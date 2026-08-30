/**
 * Regression test for review Finding 1 (HIGH):
 * the upstream connect-timeout used to stay attached to the response BODY,
 * killing streams that outlive connect_timeout_ms; the resulting source-stream
 * error had no listener -> unhandled 'error' -> whole gateway process died and
 * no ledger row was written.
 *
 * Required behavior: timeout applies ONLY until upstream headers arrive.
 * A slow (but healthy) stream must be delivered in full, the process must
 * survive, and exactly one ledger row must be recorded.
 *
 * RED shape (pre-fix): this file's runner process CRASHES mid-test
 * (unhandled 'error' event) or the assertions fail on truncated output.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";
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

describe("slow streaming vs connect_timeout_ms (Finding 1)", () => {
  it("delivers a stream whose chunk interval exceeds the connect timeout, keeps the process alive, writes one ledger row", async () => {
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

      // chunk interval 350ms > 250ms connect timeout; ~6 frames ≈ >1.8s total
      const res = await fetch(`${s.url}/v1/chat/completions`, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${TEST_KEY}` },
        body: JSON.stringify({
          model: "x",
          stream: true,
          messages: [{ role: "user", content: "[mock@good:slow-stream:350] drip" }],
        }),
        // no artificial client timeout — the GATEWAY must not need one either
      });
      assert.equal(res.status, 200);
      assert.equal(res.headers.get("x-lg-provider"), "good");

      const text = await res.text();
      const dataLines = text.split("\n").filter((l) => l.startsWith("data: "));
      // role + p/o/n/g content chunks + final chunk + [DONE]
      assert.ok(dataLines.length >= 7, `expected >=7 data lines, got ${dataLines.length}`);
      assert.equal(dataLines.at(-1), "data: [DONE]");
      const joined = dataLines.join("");
      for (const ch of ["p", "o", "n", "g"]) {
        assert.ok(joined.includes(`"content":"${ch}"`), `missing streamed chunk ${ch}`);
      }

      // (b) process alive: a follow-up request must succeed on the same server
      const alive = await chat(s.port, TEST_KEY, {
        model: "good",
        messages: [{ role: "user", content: "still there?" }],
      });
      assert.equal(alive.status, 200);

      // (c) ledger rows: [0] = the streamed call, [1] = the alive-probe above
      const rows = await waitFor(() => {
        const r = readJsonl(`${storage}/usage.jsonl`);
        return r.length >= 2 ? r : undefined;
      }, 3000);
      const streamedRow = rows[0]!;
      assert.equal(streamedRow["provider"], "good");
      assert.equal(streamedRow["stream"], true);
      // the stream lived ~6 frames × 350ms ≫ the 250ms connect deadline…
      assert.ok(
        (streamedRow["latency_ms"] as number) > 1000,
        `streamed call latency ${streamedRow["latency_ms"]} should exceed the old kill window`,
      );
      assert.equal(rows[1]!["stream"], false);
    } finally {
      if (s) await s.close();
      cleanupDir(storage);
    }
  });
});
