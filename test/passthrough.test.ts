/**
 * Pass-through contract tests against a REAL loopback HTTP upstream (not the
 * in-process mock — the mock never sees the HTTP hop, so it cannot prove what
 * the gateway actually puts on the wire).
 *
 * Two guarantees are pinned here:
 *
 *  1. Byte-identical SSE pass-through: the client receives exactly the bytes
 *     the upstream sent (the usage tap is read-only), delivered incrementally
 *     (multi-chunk upstream → multiple client reads; no buffer-then-flush).
 *     Scope: loopback test double; inter-chunk timing fidelity is NOT asserted.
 *
 *  2. Precisely-scoped request forwarding: the upstream request body is the
 *     client's JSON verbatim EXCEPT (a) `model` rewritten to the provider's
 *     upstream model_id, (b) `stream_options:{include_usage:true}` injected on
 *     streaming requests when absent (suppressed by stream_include_usage:false,
 *     left untouched when the client set it). Upstream headers are exactly
 *     content-type + authorization (provider key from env); the gateway key and
 *     client routing headers never travel upstream.
 */

import assert from "node:assert/strict";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { after, before, describe, it } from "node:test";
import type { GatewayConfig } from "../src/config.ts";
import type { RunningServer } from "./helpers.ts";
import { cleanupDir, startServer, TEST_KEY, tmpDir } from "./helpers.ts";

const UPSTREAM_KEY_ENV = "LG_PASSTHROUGH_TEST_UPSTREAM_KEY";
const UPSTREAM_KEY = "pk-upstream-secret-value-1";
// Set at module load — BEFORE any server starts — so the env-only key path
// (api_key_env -> process.env read at request time) is armed for every suite.
process.env[UPSTREAM_KEY_ENV] = UPSTREAM_KEY;
// The gateway's own contribution to upstream request headers is exactly these
// two. node's undici fetch adds its own defaults on top (whitelisted in the
// closed-set assertion below); the gateway adds nothing else and forwards
// nothing from the client request.
const GATEWAY_OWN_HEADERS = ["authorization", "content-type"];
// undici's spec-mandated defaults + hop-by-hop/body framing headers it manages.
const NON_GATEWAY_HEADERS = [
  "accept",
  "accept-encoding",
  "accept-language",
  "connection",
  "content-length",
  "host",
  "sec-fetch-mode",
  "user-agent",
];

interface Captured {
  headers?: http.IncomingHttpHeaders;
  rawBody?: string;
}

const enc = new TextEncoder();
const sseFrame = (obj: object): Uint8Array => enc.encode(`data: ${JSON.stringify(obj)}\n\n`);
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/** Upstream that records the request and replies from a script. */
function makeUpstream(
  reply: (res: http.ServerResponse, req: http.IncomingMessage, rawBody: string) => Promise<void>,
): { server: http.Server; port: number; captured: Captured } {
  const captured: Captured = {};
  const server = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => {
      captured.headers = req.headers;
      captured.rawBody = Buffer.concat(chunks).toString("utf8");
      void reply(res, req, captured.rawBody);
    });
  });
  return { server, port: 0, captured };
}

function listen(server: http.Server): Promise<number> {
  return new Promise((resolveP) => {
    server.listen(0, "127.0.0.1", () => resolveP((server.address() as AddressInfo).port));
  });
}

function gatewayConfig(dir: string, upstreamPort: number, providerOver: Partial<GatewayConfig["providers"][string]> = {}): GatewayConfig {
  return {
    port: 0,
    host: "127.0.0.1",
    storage_dir: dir,
    connect_timeout_ms: 3000,
    max_retries_per_provider: 0,
    retry_backoff_base_ms: 1,
    body_limit_mb: 10,
    providers: {
      wired: {
        type: "openai",
        base_url: `http://127.0.0.1:${upstreamPort}`,
        api_key_env: UPSTREAM_KEY_ENV,
        model_id: "upstream-model-1",
        pricing: { input_per_mtok: 0.5, output_per_mtok: 2 },
        task_classes: [],
        ...providerOver,
      },
    },
    keys: { [TEST_KEY]: { project: "proj-a" } },
    routing: { default: ["wired"] },
    budgets: {},
  };
}

describe("SSE pass-through: byte identity + incremental delivery", () => {
  it("client receives EXACTLY the upstream bytes (tap is read-only), in multiple reads (no buffer-then-flush)", async () => {
    // 9 distinct writes, 25ms apart — chunk boundaries and contents both matter.
    const frames: Uint8Array[] = [
      enc.encode(": keep-alive comment line\n\n"), // non-data line must survive verbatim too
      sseFrame({ choices: [{ index: 0, delta: { role: "assistant" } }] }),
      sseFrame({ choices: [{ index: 0, delta: { content: "pong" } }] }),
      enc.encode("data: not-json-at-all\n\n"), // tap ignores unparseable data lines, must still forward them
      sseFrame({ choices: [{ index: 0, delta: { content: "pong" } }] }),
      sseFrame({ choices: [{ index: 0, delta: {} }], usage: { prompt_tokens: 2, completion_tokens: 1 } }),
      enc.encode("data: [DONE]\n\n"),
    ];
    const sent: Buffer[] = [];
    const upstream = makeUpstream(async (res) => {
      res.writeHead(200, { "content-type": "text/event-stream" });
      for (const f of frames) {
        const buf = Buffer.from(f);
        sent.push(buf);
        res.write(buf);
        await sleep(25);
      }
      res.end();
    });
    const upstreamPort = await listen(upstream.server);

    const storage = tmpDir();
    let s: RunningServer | undefined;
    try {
      s = await startServer(gatewayConfig(storage, upstreamPort), storage);
      const res = await fetch(`${s.url}/v1/chat/completions`, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${TEST_KEY}` },
        body: JSON.stringify({ model: "wired", stream: true, messages: [{ role: "user", content: "hi" }] }),
      });
      assert.equal(res.status, 200);

      const received: Buffer[] = [];
      const reader = res.body!.getReader();
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        received.push(Buffer.from(value));
      }

      // byte-identical: concatenated client bytes === concatenated upstream bytes
      const sentAll = Buffer.concat(sent);
      const receivedAll = Buffer.concat(received);
      assert.equal(
        Buffer.compare(sentAll, receivedAll),
        0,
        `client bytes differ from upstream bytes\n sent: ${sentAll.toString("utf8")}\n got:  ${receivedAll.toString("utf8")}`,
      );
      // incremental: 7 upstream writes (25ms apart) must surface as multiple
      // client reads — a buffer-then-flush gateway would deliver exactly one
      assert.ok(
        received.length >= 3,
        `expected incremental delivery (>=3 client reads for 7 upstream writes), got ${received.length}`,
      );
      assert.ok(receivedAll.toString("utf8").endsWith("data: [DONE]\n\n"));
    } finally {
      if (s) await s.close();
      upstream.server.close();
      cleanupDir(storage);
    }
  });
});

describe("forwarded request shape (zero mutation, precisely scoped)", () => {
  const upstream = makeUpstream(async (res, _req, _raw) => {
    res.writeHead(200, { "content-type": "application/json" });
    res.end('{"choices":[{"message":{"content":"ok"}}],"usage":{"prompt_tokens":1,"completion_tokens":1}}');
  });
  let upstreamPort: number;
  let s: RunningServer | undefined;
  const storage = tmpDir();

  before(async () => {
    upstreamPort = await listen(upstream.server);
    s = await startServer(gatewayConfig(storage, upstreamPort), storage);
  });
  after(async () => {
    if (s) await s.close();
    upstream.server.close();
    cleanupDir(storage);
  });

  function assertOwnHeadersExactlyAuthAndContentType(): void {
    // Closed set: every upstream header must be either a gateway-owned header
    // or a known node/undici default. A client header (x-task-class,
    // x-lg-probe) can only appear by being forwarded — this set makes that a
    // failure, not just an absence check.
    const allowed = new Set([...GATEWAY_OWN_HEADERS, ...NON_GATEWAY_HEADERS]);
    const upstreamHeaders = Object.entries(upstream.captured.headers ?? {}).map(([h]) => h.toLowerCase());
    const unexpected = upstreamHeaders.filter((h) => !allowed.has(h));
    assert.deepEqual(
      unexpected,
      [],
      `upstream received non-gateway, non-undici-default headers (client leak?): ${unexpected.join(", ")}`,
    );
    for (const h of GATEWAY_OWN_HEADERS) {
      assert.ok(upstreamHeaders.includes(h), `upstream request is missing gateway header "${h}"`);
    }
    assert.equal(upstream.captured.headers?.["content-type"], "application/json");
    assert.equal(
      upstream.captured.headers?.authorization,
      `Bearer ${UPSTREAM_KEY}`,
      "upstream auth must come from the provider's env key",
    );
    // the GATEWAY key must never travel upstream
    const headerBlob = JSON.stringify(upstream.captured.headers);
    assert.ok(!headerBlob.includes(TEST_KEY), "gateway bearer key leaked upstream");
  }

  it("body is verbatim except model rewrite; client headers are not forwarded; upstream auth is the env key", async () => {
    const clientBody = {
      model: "wired",
      stream: false,
      messages: [{ role: "user", content: "hi" }],
      temperature: 0.7,
      user: "u-123",
      metadata: { nested: { a: 1 } },
    };
    const res = await fetch(`${s!.url}/v1/chat/completions`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${TEST_KEY}`,
        "x-task-class": "bulk",
        "x-lg-probe": "never-forward-me",
      },
      body: JSON.stringify(clientBody),
    });
    assert.equal(res.status, 200);

    const forwarded = JSON.parse(upstream.captured.rawBody!) as Record<string, unknown>;
    assert.deepEqual(
      forwarded,
      { ...clientBody, model: "upstream-model-1" },
      "forwarded body must be the client body with ONLY model rewritten",
    );
    assert.equal("stream_options" in forwarded, false, "non-stream requests must not gain stream_options");
    assertOwnHeadersExactlyAuthAndContentType();
    const headers = upstream.captured.headers as Record<string, unknown>;
    assert.equal("x-task-class" in headers, false, "client routing headers must not travel upstream");
    assert.equal("x-lg-probe" in headers, false, "arbitrary client headers must not travel upstream");
  });

  it("streaming: stream_options.include_usage is injected when the client did not set it", async () => {
    const res = await fetch(`${s!.url}/v1/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${TEST_KEY}` },
      body: JSON.stringify({ model: "wired", stream: true, messages: [{ role: "user", content: "hi" }] }),
    });
    assert.equal(res.status, 200);
    await res.text();

    const forwarded = JSON.parse(upstream.captured.rawBody!) as Record<string, unknown>;
    assert.deepEqual(forwarded.stream_options, { include_usage: true });
    assertOwnHeadersExactlyAuthAndContentType();
  });

  it("streaming: client-specified stream_options.include_usage:true is preserved verbatim; provider opt-out (stream_include_usage:false) injects nothing", async () => {
    // client explicitly sets include_usage:true — gateway must leave it alone
    // (no duplication, no rewrite).
    // NOTE (documented quirk, see GUARANTEES.md): include_usage:false from the
    // client is NOT honored — the injection guard checks truthiness, so a
    // falsy client value is overridden to { include_usage: true }.
    const explicit = { model: "wired", stream: true, stream_options: { include_usage: true }, messages: [{ role: "user", content: "hi" }] };
    await (await fetch(`${s!.url}/v1/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${TEST_KEY}` },
      body: JSON.stringify(explicit),
    })).text();
    let forwarded = JSON.parse(upstream.captured.rawBody!) as Record<string, unknown>;
    assert.deepEqual(forwarded.stream_options, { include_usage: true }, "client-specified stream_options must be preserved verbatim");

    // provider opts out entirely — no injection even on a bare streaming request
    const optStorage = tmpDir();
    let optServer: RunningServer | undefined;
    try {
      optServer = await startServer(
        gatewayConfig(optStorage, upstreamPort, { stream_include_usage: false }),
        optStorage,
      );
      await (await fetch(`${optServer.url}/v1/chat/completions`, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${TEST_KEY}` },
        body: JSON.stringify({ model: "wired", stream: true, messages: [{ role: "user", content: "hi" }] }),
      })).text();
      forwarded = JSON.parse(upstream.captured.rawBody!) as Record<string, unknown>;
      assert.equal("stream_options" in forwarded, false, "stream_include_usage:false must suppress injection");
    } finally {
      if (optServer) await optServer.close();
      cleanupDir(optStorage);
    }
  });

  it("non-streaming: response body is byte-identical to what upstream sent, content-type forwarded", async () => {
    // distinctive bytes: irregular whitespace + unicode, sent as raw bytes
    const body = Buffer.from(
      '{ "choices" : [ { "message" : { "content" : "héllo — wörld" } } ], "usage": {"prompt_tokens":1,"completion_tokens":1} }  ',
      "utf8",
    );
    const byteUpstream = makeUpstream(async (res) => {
      res.writeHead(200, { "content-type": "application/json; charset=utf-8" });
      res.end(body);
    });
    const bytePort = await listen(byteUpstream.server);
    const byteStorage = tmpDir();
    let byteGateway: RunningServer | undefined;
    try {
      byteGateway = await startServer(gatewayConfig(byteStorage, bytePort), byteStorage);
      const res = await fetch(`${byteGateway.url}/v1/chat/completions`, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${TEST_KEY}` },
        body: JSON.stringify({ model: "wired", messages: [{ role: "user", content: "hi" }] }),
      });
      assert.equal(res.status, 200);
      const received = Buffer.from(await res.arrayBuffer());
      assert.equal(Buffer.compare(body, received), 0, "non-streaming body must reach the client byte-identical");
      // upstream response headers are NOT forwarded on the non-stream path:
      // the gateway synthesizes application/json (the body is what is
      // guaranteed byte-identical, not the header set).
      assert.equal(res.headers.get("content-type"), "application/json");
    } finally {
      if (byteGateway) await byteGateway.close();
      byteUpstream.server.close();
      cleanupDir(byteStorage);
    }
  });
});

after(() => {
  delete process.env[UPSTREAM_KEY_ENV];
});
