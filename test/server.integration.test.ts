/**
 * RED-first integration tests over the real HTTP surface with in-process mock
 * providers (no network). Proves: auth, models list, non-streaming + streaming
 * chat, fallback on 500→next-provider with retry/backoff counts, sticky
 * retention + movement + persistence across restart, ledger rows w/ correct USD,
 * budget-cap 402, admin usage endpoint.
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { after, before, describe, it } from "node:test";
import { appendRecord } from "../src/ledger.ts";
import type { RunningServer } from "./helpers.ts";
import {
  chat,
  cleanupDir,
  makeConfig,
  readJsonl,
  startServer,
  TEST_KEY,
  tmpDir,
} from "./helpers.ts";

const PING = { model: "good", messages: [{ role: "user", content: "hello" }] };

let dir: string;
let rs: RunningServer | undefined;

before(async () => {
  dir = tmpDir();
});

after(async () => {
  if (rs) await rs.close();
  cleanupDir(dir);
});

describe("auth", () => {
  it("rejects missing bearer key with 401", async () => {
    const s = await startServer(makeConfig({}, dir), dir);
    try {
      const res = await fetch(`${s.url}/v1/chat/completions`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(PING),
      });
      assert.equal(res.status, 401);
    } finally {
      await s.close();
    }
  });

  it("rejects unknown bearer key with 401", async () => {
    const s = await startServer(makeConfig({}, dir), dir);
    try {
      const r = await chat(s.port, "sk-wrong-key", PING);
      assert.equal(r.status, 401);
      const body = r.json as { error?: { message?: string } };
      assert.match(body.error?.message ?? "", /unknown gateway key/i);
    } finally {
      await s.close();
    }
  });
});

describe("GET /v1/models", () => {
  it("lists configured providers as OpenAI-style models", async () => {
    const s = await startServer(makeConfig({}, dir), dir);
    try {
      const res = await fetch(`${s.url}/v1/models`, {
        headers: { authorization: `Bearer ${TEST_KEY}` },
      });
      assert.equal(res.status, 200);
      const body = (await res.json()) as { object: string; data: Array<{ id: string }> };
      assert.equal(body.object, "list");
      const ids = body.data.map((m) => m.id).sort();
      assert.deepEqual(ids, ["alt", "flaky", "good"]);
    } finally {
      await s.close();
    }
  });
});

describe("non-streaming chat", () => {
  it("returns the completion and records a correct ledger row", async () => {
    const storage = tmpDir();
    const cfg = makeConfig({ routing: { default: ["good"] } }, storage);
    const s = await startServer(cfg, storage);
    try {
      const r = await chat(s.port, TEST_KEY, PING);
      assert.equal(r.status, 200);
      assert.equal(r.headers["x-lg-provider"], "good");
      assert.equal(r.headers["x-lg-fallback-used"], "false");
      const body = r.json as {
        choices: Array<{ message: { content: string } }>;
        usage: { prompt_tokens: number; completion_tokens: number };
      };
      assert.equal(body.choices[0]!.message.content, "pong");
      // mock token rule: ceil(prompt chars/4)=ceil(5/4)=2 in, ceil(4/4)=1 out
      assert.equal(body.usage.prompt_tokens, 2);
      assert.equal(body.usage.completion_tokens, 1);

      const row = readJsonl(`${storage}/usage.jsonl`)[0]!;
      assert.equal(row.project, "proj-a"); // attribution via key -> project
      assert.equal(row.provider, "good");
      assert.equal(row.model, "good-model");
      assert.equal(row.stream, false);
      assert.equal(row.fallback_used, false);
      assert.equal(row.attempts, 1);
      assert.equal(row.input_tokens, 2);
      assert.equal(row.output_tokens, 1);
      // USD math: (2*0.5 + 1*2)/1e6 = 3e-6
      const usd = row.usd as number;
      assert.ok(Math.abs(usd - 0.000003) < 5e-9, `usd ${usd} != 0.000003`);
      assert.ok((row.latency_ms as number) >= 0);
    } finally {
      await s.close();
      cleanupDir(storage);
    }
  });

  it("rejects a body without messages (400)", async () => {
    const storage = tmpDir();
    const s = await startServer(makeConfig({}, storage), storage);
    try {
      const r = await chat(s.port, TEST_KEY, { model: "good" });
      assert.equal(r.status, 400);
    } finally {
      await s.close();
      cleanupDir(storage);
    }
  });
});

describe("streaming chat (SSE pass-through)", () => {
  it("delivers chunk-by-chunk SSE ending in [DONE], records stream=true row", async () => {
    const storage = tmpDir();
    const s = await startServer(makeConfig({ routing: { default: ["good"] } }, storage), storage);
    try {
      const res = await fetch(`${s.url}/v1/chat/completions`, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${TEST_KEY}` },
        body: JSON.stringify({ ...PING, stream: true }),
      });
      assert.equal(res.status, 200);
      assert.ok((res.headers.get("content-type") ?? "").includes("text/event-stream"));
      assert.equal(res.headers.get("x-lg-provider"), "good");

      const text = await res.text();
      const dataLines = text.split("\n").filter((l) => l.startsWith("data: "));
      // role chunk + at least 2 content chunks + usage chunk + [DONE]
      assert.ok(dataLines.length >= 5, `expected >=5 SSE data lines, got ${dataLines.length}`);
      assert.equal(dataLines.at(-1), "data: [DONE]");
      const contents = dataLines
        .map((l) => l.replace(/^data:\s*/, ""))
        .filter((l) => l !== "[DONE]")
        .map((l) => JSON.parse(l) as { choices?: Array<{ delta?: { content?: string } }>; usage?: unknown })
        .flatMap((j) => j.choices?.[0]?.delta?.content ? [j.choices[0].delta.content] : []);
      // mock streams "pong" split into multiple deltas — proves chunked delivery
      assert.ok(contents.join("").includes("pong"));

      const row = await new Promise<Record<string, unknown>>((resolveP, rejectP) => {
        const deadline = Date.now() + 2000;
        const tick = () => {
          const rows = readJsonl(`${storage}/usage.jsonl`);
          if (rows.length > 0) return resolveP(rows[0]!);
          if (Date.now() > deadline) return rejectP(new Error("ledger row never written after stream"));
          setTimeout(tick, 15);
        };
        tick();
      });
      assert.equal(row.stream, true);
      assert.equal(row.provider, "good");
      assert.equal(row.input_tokens, 2); // usage parsed from final SSE chunk
      assert.equal(row.output_tokens, 1);
      assert.ok(Math.abs((row.usd as number) - 0.000003) < 5e-9);
    } finally {
      await s.close();
      cleanupDir(storage);
    }
  });

  it("Finding 5: when upstream sends no usage, estimate counts CONTENT chars — not SSE framing bytes", async () => {
    const storage = tmpDir();
    const s = await startServer(makeConfig({ routing: { default: ["good"] } }, storage), storage);
    try {
      // [mock@good:no-usage] strips the usage object from the stream
      const res = await fetch(`${s.url}/v1/chat/completions`, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${TEST_KEY}` },
        body: JSON.stringify({
          model: "good",
          stream: true,
          messages: [{ role: "user", content: "[mock@good:no-usage] hi" }],
        }),
      });
      assert.equal(res.status, 200);
      await res.text(); // consume fully

      const row = await new Promise<Record<string, unknown>>((resolveP, rejectP) => {
        const deadline = Date.now() + 2000;
        const tick = () => {
          const rows = readJsonl(`${storage}/usage.jsonl`);
          if (rows.length > 0) return resolveP(rows[0]!);
          if (Date.now() > deadline) return rejectP(new Error("ledger row never written"));
          setTimeout(tick, 15);
        };
        tick();
      });
      assert.equal(row.estimated, true); // RED pre-fix: usage was present, flag absent
      // prompt includes the directive text itself: "[mock@good:no-usage] hi" = 23 chars
      assert.equal(row.input_tokens, 6); // estTokens -> ceil(23/4)
      assert.equal(row.output_tokens, 1); // estTokens("pong") = 1 — NOT bytesSeen/4 (~100+)
    } finally {
      await s.close();
      cleanupDir(storage);
    }
  });
});

describe("fallback chain", () => {
  it("on upstream 500: retries same provider twice, then falls to next; ledger says so", async () => {
    const storage = tmpDir();
    const s = await startServer(
      makeConfig({ routing: { bulk: ["flaky", "good"], default: ["good"] } }, storage),
      storage,
    );
    try {
      // [mock:500] directive makes flaky fail forever; good has no directive
      const r = await chat(s.port, TEST_KEY, {
        model: "anything-not-a-provider",
        messages: [{ role: "user", content: "[mock@flaky:500] hello" }],
      }, { "x-task-class": "bulk" });
      assert.equal(r.status, 200);
      assert.equal(r.headers["x-lg-provider"], "good");
      assert.equal(r.headers["x-lg-fallback-used"], "true");

      const row = readJsonl(`${storage}/usage.jsonl`).at(-1)!;
      assert.equal(row.provider, "good");
      assert.equal(row.fallback_used, true);
      // flaky consumed 3 attempts (initial + 2 retries), good 1 → 4 total
      assert.equal(row.attempts, 4);
    } finally {
      await s.close();
      cleanupDir(storage);
    }
  });

  it("retries within one provider on transient failure ([mock:fail-first-2]) without fallback", async () => {
    const storage = tmpDir();
    const s = await startServer(
      makeConfig({ routing: { bulk: ["flaky"], default: ["flaky"] } }, storage),
      storage,
    );
    try {
      const r = await chat(s.port, TEST_KEY, {
        model: "x",
        messages: [{ role: "user", content: "[mock@flaky:fail-first:2] hi" }],
      }, { "x-task-class": "bulk" });
      assert.equal(r.status, 200);
      assert.equal(r.headers["x-lg-provider"], "flaky");
      assert.equal(r.headers["x-lg-fallback-used"], "false");
      const row = readJsonl(`${storage}/usage.jsonl`).at(-1)!;
      assert.equal(row.attempts, 3); // failed twice inside flaky, succeeded on 3rd
      assert.equal(row.fallback_used, false);
    } finally {
      await s.close();
      cleanupDir(storage);
    }
  });

  it("all providers failing yields 502 with per-attempt detail, nothing recorded", async () => {
    const storage = tmpDir();
    const s = await startServer(
      makeConfig({ routing: { bulk: ["flaky"], default: ["flaky"] } }, storage),
      storage,
    );
    try {
      const r = await chat(s.port, TEST_KEY, {
        model: "x",
        messages: [{ role: "user", content: "[mock:500] hi" }],
      }, { "x-task-class": "bulk" });
      assert.equal(r.status, 502);
      const body = r.json as { error?: { attempts?: unknown[] } };
      assert.ok(Array.isArray(body.error?.attempts));
      assert.equal(body.error!.attempts!.length, 3); // initial + 2 retries, all flaky
      assert.equal(readJsonl(`${storage}/usage.jsonl`).length, 0);
    } finally {
      await s.close();
      cleanupDir(storage);
    }
  });

  it("non-retryable 400 from upstream advances immediately (no wasted retries)", async () => {
    const storage = tmpDir();
    const s = await startServer(
      makeConfig(
        {
          routing: {
            bulk: ["flaky", "good"],
            default: ["good"],
          },
        },
        storage,
      ),
      storage,
    );
    try {
      const r = await chat(s.port, TEST_KEY, {
        model: "x",
        messages: [{ role: "user", content: "[mock@flaky:400] bad request shape" }],
      }, { "x-task-class": "bulk" });
      assert.equal(r.status, 200); // fell over to good without retrying flaky
      const row = readJsonl(`${storage}/usage.jsonl`).at(-1)!;
      assert.equal(row.provider, "good");
      assert.equal(row.fallback_used, true);
      assert.equal(row.attempts, 2); // 1 attempt on flaky + 1 on good
    } finally {
      await s.close();
      cleanupDir(storage);
    }
  });

  it("connect timeout on first provider falls through to second", async () => {
    const storage = tmpDir();
    const s = await startServer(
      makeConfig({ routing: { bulk: ["flaky", "good"], default: ["good"] }, connect_timeout_ms: 150 }, storage),
      storage,
    );
    try {
      const r = await chat(s.port, TEST_KEY, {
        model: "x",
        messages: [{ role: "user", content: "[mock@flaky:hang] too slow" }],
      }, { "x-task-class": "bulk" });
      assert.equal(r.status, 200);
      assert.equal(r.headers["x-lg-provider"], "good");
      const row = readJsonl(`${storage}/usage.jsonl`).at(-1)!;
      assert.equal(row.fallback_used, true);
    } finally {
      await s.close();
      cleanupDir(storage);
    }
  });
});

describe("sticky cache-affinity", () => {
  it("retains last-good provider on success and moves it only on failure", async () => {
    const storage = tmpDir();
    const s = await startServer(
      makeConfig({ routing: { bulk: ["flaky", "good"], default: ["good"] } }, storage),
      storage,
    );
    try {
      // 1. success on chain head 'flaky' → sticky becomes flaky
      const r1 = await chat(s.port, TEST_KEY, {
        model: "x",
        messages: [{ role: "user", content: "hi" }],
      }, { "x-task-class": "bulk" });
      assert.equal(r1.headers["x-lg-provider"], "flaky");

      // 2. clean request again → sticky flaky still first (not load-balanced away)
      const r2 = await chat(s.port, TEST_KEY, {
        model: "x",
        messages: [{ role: "user", content: "hi" }],
      }, { "x-task-class": "bulk" });
      assert.equal(r2.headers["x-lg-provider"], "flaky");

      // 3. flaky starts failing permanently → fall to good, sticky MOVES to good
      const r3 = await chat(s.port, TEST_KEY, {
        model: "x",
        messages: [{ role: "user", content: "[mock@flaky:500] now broken" }],
      }, { "x-task-class": "bulk" });
      assert.equal(r3.status, 200);
      assert.equal(r3.headers["x-lg-provider"], "good");

      // 4. next clean request goes straight to good (sticky), skipping flaky entirely
      const r4 = await chat(s.port, TEST_KEY, {
        model: "x",
        messages: [{ role: "user", content: "healthy again" }],
      }, { "x-task-class": "bulk" });
      assert.equal(r4.status, 200);
      assert.equal(r4.headers["x-lg-provider"], "good");
      assert.equal(r4.headers["x-lg-fallback-used"], "false");

      // persisted sticky state points at good
      const sticky = JSON.parse(readFileSync0(storage)) as Record<string, string>;
      assert.equal(sticky[TEST_KEY], "good");
    } finally {
      await s.close();
      cleanupDir(storage);
    }
  });

  it("survives a restart: sticky affinity is loaded from disk", async () => {
    const storage = tmpDir();
    const cfgOpts = { routing: { bulk: ["alt", "good"], default: ["good"] } };
    // server A: establish sticky=good via hint-free success on pinned model
    const sa = await startServer(makeConfig(cfgOpts, storage), storage);
    await chat(sa.port, TEST_KEY, { model: "good", messages: [{ role: "user", content: "pin" }] });
    await sa.close();

    // server B (same storage): chain head is alt, but sticky must route to good
    const sb = await startServer(makeConfig(cfgOpts, storage), storage);
    try {
      const r = await chat(sb.port, TEST_KEY, {
        model: "x",
        messages: [{ role: "user", content: "after restart" }],
      }, { "x-task-class": "bulk" });
      assert.equal(r.status, 200);
      assert.equal(r.headers["x-lg-provider"], "good");
    } finally {
      await sb.close();
      cleanupDir(storage);
    }
  });
});

describe("task-class allowlist + budget cap", () => {
  it("403 when resolved task class is not allowed for this key", async () => {
    const storage = tmpDir();
    const s = await startServer(makeConfig({ allowed: ["agentic-coding"] }, storage), storage);
    try {
      const r = await chat(s.port, TEST_KEY, PING, { "x-task-class": "bulk" });
      assert.equal(r.status, 403);
    } finally {
      await s.close();
      cleanupDir(storage);
    }
  });

  it("hard-stops with 402 once monthly spend crosses the cap", async () => {
    const storage = tmpDir();
    appendRecord(storage, {
      ts: new Date().toISOString(),
      project: "proj-a",
      provider: "good",
      model: "good-model",
      task_class: "bulk",
      input_tokens: 1_000_000,
      output_tokens: 0,
      usd: 5.0,
      latency_ms: 1,
      stream: false,
      fallback_used: false,
      attempts: 1,
    });
    const s = await startServer(
      makeConfig({ budgets: { "proj-a": { monthly_usd_cap: 1 } } }, storage),
      storage,
    );
    try {
      const r = await chat(s.port, TEST_KEY, PING);
      assert.equal(r.status, 402);
      const body = r.json as { error?: { message?: string } };
      assert.match(body.error?.message ?? "", /budget/);
      // nothing hit upstream, nothing further recorded
      assert.equal(readJsonl(`${storage}/usage.jsonl`).length, 1);
    } finally {
      await s.close();
      cleanupDir(storage);
    }
  });
});

describe("GET /admin/usage", () => {
  it("requires the admin key", async () => {
    const storage = tmpDir();
    const s = await startServer(makeConfig({ adminKey: "adm-123" }, storage), storage);
    try {
      const noKey = await fetch(`${s.url}/admin/usage`);
      assert.equal(noKey.status, 401);
      const badKey = await fetch(`${s.url}/admin/usage`, {
        headers: { authorization: "Bearer wrong" },
      });
      assert.equal(badKey.status, 401);
      const ok = await fetch(`${s.url}/admin/usage`, {
        headers: { authorization: "Bearer adm-123" },
      });
      assert.equal(ok.status, 200);
    } finally {
      await s.close();
      cleanupDir(storage);
    }
  });

  it("is disabled (503) when admin_key is unset", async () => {
    const storage = tmpDir();
    const s = await startServer(makeConfig({ adminKey: null }, storage), storage);
    try {
      const res = await fetch(`${s.url}/admin/usage`, {
        headers: { authorization: "Bearer anything" },
      });
      assert.equal(res.status, 503);
    } finally {
      await s.close();
      cleanupDir(storage);
    }
  });

  it("aggregates by project/provider with month filter", async () => {
    const storage = tmpDir();
    appendRecord(storage, recSeed("proj-a", "good", 1.0));
    appendRecord(storage, recSeed("proj-a", "flaky", 0.5));
    appendRecord(storage, recSeed("proj-b", "good", 2.0));
    appendRecord(storage, { ...recSeed("proj-a", "old", 99), ts: "2020-01-01T00:00:00.000Z" });
    const s = await startServer(makeConfig({ adminKey: "adm" }, storage), storage);
    try {
      const month = new Date().toISOString().slice(0, 7);
      const get = async (q: string) =>
        (
          await (
            await fetch(`${s.url}/admin/usage${q}`, {
              headers: { authorization: "Bearer adm" },
            })
          ).json()
        ) as {
          totals: { requests: number; usd: number };
          groups: Array<{ project: string; provider: string; requests: number; usd: number }>;
        };

      const all = await get(`?month=${month}`);
      assert.equal(all.totals.requests, 3);
      assert.equal(all.totals.usd, 3.5);

      const projA = await get(`?project=proj-a&month=${month}`);
      assert.equal(projA.totals.requests, 2);
      assert.equal(projA.totals.usd, 1.5);
      assert.ok(projA.groups.find((g) => g.provider === "flaky" && g.usd === 0.5));

      const empty = await get("?project=nope&month=2020-01");
      assert.equal(empty.totals.requests, 0);
    } finally {
      await s.close();
      cleanupDir(storage);
    }
  });
});

function recSeed(project: string, provider: string, usd: number) {
  return {
    ts: new Date().toISOString(),
    project,
    provider,
    model: `${provider}-model`,
    task_class: "bulk",
    input_tokens: 10,
    output_tokens: 10,
    usd,
    latency_ms: 5,
    stream: false,
    fallback_used: false,
    attempts: 1,
  };
}

function readFileSync0(dir: string): string {
  return readFileSync(`${dir}/sticky.json`, "utf8");
}
