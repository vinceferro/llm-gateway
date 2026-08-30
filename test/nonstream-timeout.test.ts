/**
 * Non-stream deadline contract.
 *
 * The connect deadline (time-to-headers) fits streaming replies, but a
 * non-streaming upstream sends headers+body together only when generation
 * COMPLETES — so any non-stream generation longer than connect_timeout_ms
 * would 502 after futile retries even though the upstream was healthy.
 * Non-stream requests therefore get their own (longer) window:
 * `nonstream_timeout_ms` (default 120000).
 *
 * Found by a controlled gateway-vs-direct benchmark: identical non-stream
 * calls succeeded direct (~15s) and 502'd through the gateway (~30s of
 * timeout retries).
 */

import assert from "node:assert/strict";
import { after, describe, it } from "node:test";
import type { RunningServer } from "./helpers.ts";
import { chat, cleanupDir, makeConfig, startServer, TEST_KEY, tmpDir } from "./helpers.ts";

describe("non-stream deadline", () => {
  const storage = tmpDir("lg-nonstream-");
  let s: RunningServer | undefined;
  after(async () => {
    await s?.close();
    cleanupDir(storage);
  });

  it("non-stream reply slower than connect deadline but inside the nonstream window SUCCEEDS", async () => {
    s = await startServer(
      makeConfig(
        {
          connect_timeout_ms: 300,
          nonstream_timeout_ms: 5000,
          routing: { default: ["good"] },
        },
        storage,
      ),
      storage,
    );
    const res = await chat(s.port, TEST_KEY, {
      model: "good",
      messages: [{ role: "user", content: "[mock@good:delay:700] ping" }],
    });
    assert.equal(res.status, 200, `expected 200, got ${res.status}: ${res.text.slice(0, 200)}`);
    const body = res.json as { usage?: unknown } | undefined;
    assert.ok(body?.usage, "usage should be present on success");
  });

  it("stream request still honors the SHORT connect deadline (unchanged contract)", async () => {
    const res = await chat(s!.port, TEST_KEY, {
      model: "good",
      stream: true,
      messages: [{ role: "user", content: "[mock@good:delay:700] ping" }],
    });
    assert.equal(res.status, 502, "late-header stream must still hit the connect deadline");
    const body = res.json as { error?: { attempts?: unknown[] } } | undefined;
    assert.equal(body?.error?.attempts?.length, 3, "connect_timeout 300ms x (1+2 retries)");
  });
});

describe("non-stream deadline: exceeding the window", () => {
  const storage = tmpDir("lg-nonstream-over-");
  let s: RunningServer | undefined;
  after(async () => {
    await s?.close();
    cleanupDir(storage);
  });

  it("non-stream reply slower than nonstream_timeout_ms times out with retries", async () => {
    s = await startServer(
      makeConfig(
        {
          connect_timeout_ms: 300,
          nonstream_timeout_ms: 400,
          routing: { default: ["good"] },
        },
        storage,
      ),
      storage,
    );
    const res = await chat(s.port, TEST_KEY, {
      model: "good",
      messages: [{ role: "user", content: "[mock@good:delay:700] ping" }],
    });
    assert.equal(res.status, 502);
    const body = res.json as { error?: { attempts?: unknown[] } } | undefined;
    assert.equal(body?.error?.attempts?.length, 3);
  });
});
