/**
 * Regression tests for the repo's #1 binding contract:
 * exactly-once ledger finalize across finish/close/error/disconnect.
 *
 * The success path was already covered by server.integration.test.ts; these
 * pin the two ABNORMAL termination paths (adapted from the adversarial
 * review's live probes, verified against this codebase):
 *
 *   1. client DISCONNECT mid-stream (after first byte) -> exactly one ledger
 *      row, incomplete:true, process alive;
 *   2. upstream RESET mid-stream (RST after bytes flowed) -> exactly one
 *      ledger row, incomplete:true, response terminated (not hung), process
 *      alive.
 *
 * The failure mode being guarded against is a double-write (e.g. both the
 * 'error' and 'close' handlers finalizing) or a missed write (row never
 * lands) — either breaks usage metering honesty.
 */

import assert from "node:assert/strict";
import http from "node:http";
import { describe, it } from "node:test";
import type { AddressInfo } from "node:net";
import type { RunningServer } from "./helpers.ts";
import {
  chat,
  cleanupDir,
  makeConfig,
  readJsonl,
  startServer,
  TEST_KEY,
  tmpDir,
  waitFor,
} from "./helpers.ts";

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

describe("exactly-once ledger finalize (abnormal termination)", () => {
  it("client disconnect mid-stream (after first byte): exactly ONE ledger row, incomplete:true, process alive", async () => {
    const storage = tmpDir();
    let s: RunningServer | undefined;
    try {
      s = await startServer(
        makeConfig(
          { routing: { bulk: ["good"], default: ["good"] }, connect_timeout_ms: 250 },
          storage,
        ),
        storage,
      );

      // slow drip: ~7 frames x 120ms — plenty of stream left when we hang up
      const ac = new AbortController();
      const res = await fetch(`${s.url}/v1/chat/completions`, {
        method: "POST",
        signal: ac.signal,
        headers: { "content-type": "application/json", authorization: `Bearer ${TEST_KEY}` },
        body: JSON.stringify({
          model: "good",
          stream: true,
          messages: [{ role: "user", content: "[mock@good:slow-stream:120] drip" }],
        }),
      });
      assert.equal(res.status, 200);
      const reader = res.body!.getReader();
      const first = await reader.read(); // first upstream byte reaches the client
      assert.ok(!first.done, "expected at least one streamed chunk before the disconnect");
      ac.abort(); // socket dies while the upstream is still dripping
      try {
        await reader.read();
      } catch {
        /* expected: read rejects after abort */
      }

      // the row must land exactly once: wait for it, then give any duplicate
      // finalize a settle window before counting
      await waitFor(() => (readJsonl(`${storage}/usage.jsonl`).length >= 1 ? true : undefined), 3000);
      await sleep(250);
      const rows = readJsonl(`${storage}/usage.jsonl`);
      assert.equal(rows.length, 1, `exactly one ledger row expected, got ${rows.length}`);
      const row = rows[0]!;
      assert.equal(row.stream, true);
      assert.equal(row.incomplete, true, "mid-stream disconnect must mark the row incomplete");
      // bytes DID flow before the hangup -> this is a mid-stream row, ttfb present
      assert.ok(Number.isInteger(row.ttfb_ms), `ttfb_ms must be present, got ${row.ttfb_ms}`);

      // process alive: a follow-up request must succeed on the same server
      const alive = await chat(s.port, TEST_KEY, {
        model: "good",
        messages: [{ role: "user", content: "still there?" }],
      });
      assert.equal(alive.status, 200);
    } finally {
      if (s) await s.close();
      cleanupDir(storage);
    }
  });

  it("upstream RST mid-stream: exactly ONE ledger row, incomplete:true, response terminates, process alive", async () => {
    const storage = tmpDir();

    // hostile upstream: 2 SSE frames, then destroy the socket (no [DONE])
    const enc = new TextEncoder();
    const frame = (o: object): Uint8Array => enc.encode(`data: ${JSON.stringify(o)}\n\n`);
    const evil = http.createServer((req, res) => {
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.write(frame({ choices: [{ index: 0, delta: { role: "assistant" } }] }));
      res.write(frame({ choices: [{ index: 0, delta: { content: "p" } }] }));
      setTimeout(() => res.socket?.destroy(), 40); // abrupt reset mid-stream
    });
    await new Promise<void>((r) => evil.listen(0, "127.0.0.1", r));
    const evilPort = (evil.address() as AddressInfo).port;

    let s: RunningServer | undefined;
    try {
      const cfg = makeConfig(
        { routing: { bulk: ["evil"], default: ["evil"] }, connect_timeout_ms: 2000 },
        storage,
      );
      cfg.max_retries_per_provider = 0; // single hostile upstream, no retry noise
      cfg.providers.evil = {
        type: "openai",
        base_url: `http://127.0.0.1:${evilPort}`,
        model_id: "evil-model",
        pricing: { input_per_mtok: 0.5, output_per_mtok: 2 },
        task_classes: [],
        stream_include_usage: false,
      };
      s = await startServer(cfg, storage);

      const res = await fetch(`${s.url}/v1/chat/completions`, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${TEST_KEY}` },
        body: JSON.stringify({ model: "evil", stream: true, messages: [{ role: "user", content: "x" }] }),
      });
      assert.equal(res.status, 200);
      const text = await res.text(); // must TERMINATE, not hang
      assert.ok(text.includes('"content":"p"'), "frames sent before the reset must pass through");

      // exactly-once: wait for the row, then settle before counting
      await waitFor(() => (readJsonl(`${storage}/usage.jsonl`).length >= 1 ? true : undefined), 3000);
      await sleep(250);
      const rows = readJsonl(`${storage}/usage.jsonl`);
      assert.equal(rows.length, 1, `exactly one ledger row expected, got ${rows.length}`);
      const row = rows[0]!;
      assert.equal(row.incomplete, true, "mid-stream upstream reset must mark the row incomplete");
      assert.ok(Number.isInteger(row.ttfb_ms), `bytes flowed before the reset, ttfb must be present, got ${row.ttfb_ms}`);

      // process alive: follow-up against the healthy mock provider succeeds
      const alive = await chat(s.port, TEST_KEY, {
        model: "good",
        messages: [{ role: "user", content: "still there?" }],
      });
      assert.equal(alive.status, 200);
    } finally {
      if (s) await s.close();
      evil.close();
      cleanupDir(storage);
    }
  });
});
