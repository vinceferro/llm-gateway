/**
 * RED-first tests for cached-token telemetry:
 *  - ledger rows gain optional cached_tokens (OpenAI-compatible
 *    usage.prompt_tokens_details.cached_tokens; e.g. Z.ai/GLM when caching
 *    engages, llama.cpp typically absent)
 *  - /admin/usage totals + groups gain a derived `cache` object ADDITIVELY —
 *    present only when ≥1 row in scope carries the field, omitted otherwise
 *  - old-format rows and all-uncached ledgers keep the legacy response shape
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
import { appendRecord, summarizeLedger, type UsageRecord } from "../src/ledger.ts";

interface CacheLike {
  cached_tokens: number;
  cached_share: number;
}

function rec(over: Partial<UsageRecord> = {}): UsageRecord {
  return {
    ts: new Date().toISOString(),
    project: "proj-a",
    provider: "good",
    model: "good-model",
    task_class: "bulk",
    input_tokens: 1000,
    output_tokens: 500,
    usd: 0.0015,
    latency_ms: 42,
    stream: false,
    fallback_used: false,
    attempts: 1,
    ...over,
  };
}

describe("cached-token telemetry: ledger row capture", () => {
  it("non-streamed request with cached usage: row records integer cached_tokens <= input_tokens", async () => {
    const storage = tmpDir();
    let s: RunningServer | undefined;
    try {
      s = await startServer(
        makeConfig({ routing: { bulk: ["good"], default: ["good"] } }, storage),
        storage,
      );
      const res = await chat(s.port, TEST_KEY, {
        model: "good",
        messages: [{ role: "user", content: "[mock@good:cached] hello" }],
      });
      assert.equal(res.status, 200);

      const row = await waitFor(() => {
        const rows = readJsonl(`${storage}/usage.jsonl`);
        return rows.length === 1 ? rows[0] : undefined;
      });
      assert.equal(row["stream"], false);
      const cached = row["cached_tokens"];
      assert.equal(typeof cached, "number", "cached_tokens must be recorded when upstream reports it");
      assert.ok(Number.isInteger(cached), `cached_tokens must be an integer, got ${cached}`);
      assert.ok(
        (cached as number) >= 0,
        `cached_tokens must be >= 0, got ${cached}`,
      );
      assert.ok(
        (cached as number) <= (row["input_tokens"] as number),
        `cached_tokens ${cached} cannot exceed input_tokens ${row["input_tokens"]}`,
      );
      // deterministic mock: cached = ceil(input/2)
      assert.equal(cached, Math.ceil((row["input_tokens"] as number) / 2));
    } finally {
      if (s) await s.close();
      cleanupDir(storage);
    }
  });

  it("streamed request with cached usage: the final usage chunk feeds cached_tokens too", async () => {
    const storage = tmpDir();
    let s: RunningServer | undefined;
    try {
      s = await startServer(
        makeConfig({ routing: { bulk: ["good"], default: ["good"] } }, storage),
        storage,
      );
      const res = await chat(s.port, TEST_KEY, {
        model: "good",
        stream: true,
        messages: [{ role: "user", content: "[mock@good:cached] drip" }],
      });
      assert.equal(res.status, 200);
      assert.ok(res.text.includes("data: [DONE]"));

      const row = await waitFor(() => {
        const rows = readJsonl(`${storage}/usage.jsonl`);
        return rows.length === 1 ? rows[0] : undefined;
      });
      assert.equal(row["stream"], true);
      const cached = row["cached_tokens"];
      assert.equal(typeof cached, "number", "stream path must parse prompt_tokens_details.cached_tokens");
      assert.ok(Number.isInteger(cached));
      assert.equal(cached, Math.ceil((row["input_tokens"] as number) / 2));
    } finally {
      if (s) await s.close();
      cleanupDir(storage);
    }
  });

  it("usage WITHOUT prompt_tokens_details: cached_tokens key is ABSENT on both paths", async () => {
    const storage = tmpDir();
    let s: RunningServer | undefined;
    try {
      s = await startServer(
        makeConfig({ routing: { bulk: ["good"], default: ["good"] } }, storage),
        storage,
      );
      const plain = await chat(s.port, TEST_KEY, {
        model: "good",
        messages: [{ role: "user", content: "hi" }],
      });
      assert.equal(plain.status, 200);
      const streamed = await chat(s.port, TEST_KEY, {
        model: "good",
        stream: true,
        messages: [{ role: "user", content: "hi stream" }],
      });
      assert.equal(streamed.status, 200);

      await waitFor(() => (readJsonl(`${storage}/usage.jsonl`).length === 2 ? true : undefined));
      const rows = readJsonl(`${storage}/usage.jsonl`);
      for (const row of rows) {
        assert.equal(
          "cached_tokens" in row,
          false,
          "unreported cached_tokens must be OMITTED (not 0/null) — no fabrication",
        );
      }

      // and the summary must not grow a cache object either
      const admin = await fetch(`${s.url}/admin/usage`, {
        headers: { authorization: "Bearer admin-secret" },
      });
      assert.equal(admin.status, 200);
      const body = (await admin.json()) as {
        totals: Record<string, unknown>;
        groups: Array<Record<string, unknown>>;
      };
      assert.equal("cache" in body.totals, false, "no cached rows -> totals.cache omitted");
      for (const g of body.groups) assert.equal("cache" in g, false, "no cached rows -> group.cache omitted");
    } finally {
      if (s) await s.close();
      cleanupDir(storage);
    }
  });

  it("hostile upstream sends FRACTIONAL cached_tokens (2.5): rejected — key ABSENT from the ledger row (UsageRecord is int >= 0)", async () => {
    const storage = tmpDir();
    let s: RunningServer | undefined;
    try {
      s = await startServer(
        makeConfig({ routing: { bulk: ["good"], default: ["good"] } }, storage),
        storage,
      );
      // 2.5 rides in the prompt as prompt_tokens_details.cached_tokens; both the
      // buffered and SSE paths funnel through the same capture guard, so the
      // buffered path is the proof.
      const res = await chat(s.port, TEST_KEY, {
        model: "good",
        messages: [{ role: "user", content: "[mock@good:cached:2.5] hello" }],
      });
      assert.equal(res.status, 200);

      const row = await waitFor(() => {
        const rows = readJsonl(`${storage}/usage.jsonl`);
        return rows.length === 1 ? rows[0] : undefined;
      });
      assert.equal(
        "cached_tokens" in row,
        false,
        "fractional cached_tokens must be OMITTED, not recorded as-is",
      );
    } finally {
      if (s) await s.close();
      cleanupDir(storage);
    }
  });

  it("cached_tokens 2.0 IS an integer (Number.isInteger(2.0) === true): accepted and recorded", async () => {
    const storage = tmpDir();
    let s: RunningServer | undefined;
    try {
      s = await startServer(
        makeConfig({ routing: { bulk: ["good"], default: ["good"] } }, storage),
        storage,
      );
      const res = await chat(s.port, TEST_KEY, {
        model: "good",
        messages: [{ role: "user", content: "[mock@good:cached:2] hello" }],
      });
      assert.equal(res.status, 200);

      const row = await waitFor(() => {
        const rows = readJsonl(`${storage}/usage.jsonl`);
        return rows.length === 1 ? rows[0] : undefined;
      });
      assert.equal(row["cached_tokens"], 2);
      assert.ok(Number.isInteger(row["cached_tokens"]));
    } finally {
      if (s) await s.close();
      cleanupDir(storage);
    }
  });
});

describe("cache stats in summarizeLedger", () => {
  it("mixed rows: cached_tokens sums only valid fields; share is over ALL rows' input, 3 decimals", () => {
    const dir = tmpDir();
    try {
      appendRecord(dir, rec({ cached_tokens: 400 }));
      appendRecord(dir, rec({ cached_tokens: 300 }));
      appendRecord(dir, rec()); // old-format row: no cached_tokens, still counts in the denominator
      const s = summarizeLedger(dir, {});
      const cache = s.totals.cache as CacheLike | undefined;
      assert.ok(cache, "totals.cache present when any row carries cached_tokens");
      assert.equal(cache.cached_tokens, 700);
      assert.equal(cache.cached_share, 0.233); // 700 / 3000 total input (uncached row's input counts too)
      // group (single group here) mirrors it
      const g = s.groups[0]!.cache as CacheLike;
      assert.equal(g.cached_tokens, 700);
      assert.equal(g.cached_share, 0.233);
    } finally {
      cleanupDir(dir);
    }
  });

  it("share rounding: 100/300 -> 0.333 (3 decimals, no float dust)", () => {
    const dir = tmpDir();
    try {
      appendRecord(dir, rec({ input_tokens: 300, cached_tokens: 100 }));
      const cache = summarizeLedger(dir, {}).totals.cache as CacheLike;
      assert.equal(cache.cached_share, 0.333);
      assert.equal(cache.cached_tokens, 100);
    } finally {
      cleanupDir(dir);
    }
  });

  it("all-uncached rows (old format): cache omitted from totals AND every group", () => {
    const dir = tmpDir();
    try {
      appendRecord(dir, rec());
      appendRecord(dir, rec({ provider: "a", model: "a-model" }));
      const s = summarizeLedger(dir, {});
      assert.equal("cache" in s.totals, false);
      for (const g of s.groups) assert.equal("cache" in g, false);
    } finally {
      cleanupDir(dir);
    }
  });

  it("empty ledger: no cache object (same omission as perf)", () => {
    const dir = tmpDir();
    try {
      const s = summarizeLedger(dir, {});
      assert.equal("cache" in s.totals, false);
      assert.deepEqual(s.groups, []);
    } finally {
      cleanupDir(dir);
    }
  });

  it("foreign rows: cached_tokens null / negative are NOT carried (no NaN poisoning); 0 IS carried", () => {
    const dir = tmpDir();
    try {
      // null + negative only -> no row validly carries the field
      appendRecord(dir, rec({ cached_tokens: null as unknown as number }));
      appendRecord(dir, rec({ cached_tokens: -5 }));
      let s = summarizeLedger(dir, {});
      assert.equal("cache" in s.totals, false, "null/negative cached_tokens count as not carried");

      // mixed: one valid row alongside a null row -> only the valid one sums
      const dir2 = tmpDir();
      try {
        appendRecord(dir2, rec({ cached_tokens: 400 }));
        appendRecord(dir2, rec({ cached_tokens: null as unknown as number }));
        s = summarizeLedger(dir2, {});
        const cache = s.totals.cache as CacheLike;
        assert.equal(cache.cached_tokens, 400, "null row must not poison the sum");
        assert.equal(cache.cached_share, 0.2);
      } finally {
        cleanupDir(dir2);
      }

      // a reported 0 is a real measurement (provider says caching engaged, zero hits)
      const dir3 = tmpDir();
      try {
        appendRecord(dir3, rec({ cached_tokens: 0 }));
        s = summarizeLedger(dir3, {});
        const cache = s.totals.cache as CacheLike;
        assert.equal(cache.cached_tokens, 0);
        assert.equal(cache.cached_share, 0);
      } finally {
        cleanupDir(dir3);
      }
    } finally {
      cleanupDir(dir);
    }
  });

  it("per-group cache: only groups with cached rows carry the key; totals aggregate across groups", () => {
    const dir = tmpDir();
    try {
      appendRecord(dir, rec({ provider: "a", model: "a-model", cached_tokens: 250 }));
      appendRecord(dir, rec({ provider: "b", model: "b-model" }));
      const s = summarizeLedger(dir, {});
      const ga = s.groups.find((g) => g.provider === "a")!;
      const gb = s.groups.find((g) => g.provider === "b")!;
      assert.equal((ga.cache as CacheLike).cached_tokens, 250);
      assert.equal((ga.cache as CacheLike).cached_share, 0.25);
      assert.equal("cache" in gb, false, "uncached group must stay key-free");
      assert.equal((s.totals.cache as CacheLike).cached_tokens, 250);
      assert.equal((s.totals.cache as CacheLike).cached_share, 0.125);
    } finally {
      cleanupDir(dir);
    }
  });

  it("old-format rows summarize cleanly: legacy key sets unchanged", () => {
    const dir = tmpDir();
    try {
      appendRecord(dir, rec({ latency_ms: 42, ttfb_ms: 42 }));
      const s = summarizeLedger(dir, {});
      assert.equal("cache" in s.totals, false);
      assert.ok(s.totals.perf, "perf must still derive for old rows");
      assert.equal("cache" in s.groups[0]!, false);
      assert.ok(s.groups[0]!.perf);
    } finally {
      cleanupDir(dir);
    }
  });
});

describe("adversarial: non-finite poisoning in cache stats", () => {
  it("two finite-but-huge cached_tokens (1e308 each): sum overflows to Infinity -> cache OMITTED entirely, never null-in-a-present-object", () => {
    const dir = tmpDir();
    try {
      appendRecord(dir, rec({ cached_tokens: 1e308 }));
      appendRecord(dir, rec({ cached_tokens: 1e308 }));
      const s = summarizeLedger(dir, {});
      assert.equal(
        "cache" in s.totals,
        false,
        "unrepresentable sum must omit totals.cache, not emit cached_tokens: Infinity (JSON null)",
      );
      for (const g of s.groups) {
        assert.equal("cache" in g, false, "poisoned group cache must be omitted too");
      }
      // serialization honesty: no null cached fields anywhere in the emitted JSON
      const text = JSON.stringify(s);
      assert.equal(text.includes('"cached_tokens":null'), false);
      assert.equal(text.includes('"cached_share":null'), false);
    } finally {
      cleanupDir(dir);
    }
  });

  it("finite huge sum over tiny input: r3 share rounds to Infinity -> cache OMITTED (both fields, per omission rules)", () => {
    const dir = tmpDir();
    try {
      // 1e308 cached over 1 total input: quotient 1e308 overflows r3's *1000
      appendRecord(dir, rec({ input_tokens: 1, cached_tokens: 1e308 }));
      const s = summarizeLedger(dir, {});
      assert.equal(
        "cache" in s.totals,
        false,
        "share that cannot be represented finitely must omit the whole object",
      );
      for (const g of s.groups) assert.equal("cache" in g, false);
      const text = JSON.stringify(s);
      assert.equal(text.includes('"cached_share":null'), false);
    } finally {
      cleanupDir(dir);
    }
  });

  it("huge cached_tokens survive an honest round-trip when representable (1e308 single row over huge input)", () => {
    const dir = tmpDir();
    try {
      // same magnitude, share stays finite: the guard must NOT overreach
      appendRecord(dir, rec({ input_tokens: 1e308, cached_tokens: 1e308 }));
      const s = summarizeLedger(dir, {});
      const cache = s.totals.cache as CacheLike | undefined;
      assert.ok(cache, "finite sum + finite share must still be reported");
      assert.equal(cache.cached_tokens, 1e308);
      assert.equal(cache.cached_share, 1);
    } finally {
      cleanupDir(dir);
    }
  });

  it("hostile ledger over HTTP: /admin/usage emits no cache key with null fields inside", async () => {
    const storage = tmpDir();
    let s: RunningServer | undefined;
    try {
      s = await startServer(
        makeConfig({ routing: { bulk: ["good"], default: ["good"] } }, storage),
        storage,
      );
      appendRecord(storage, rec({ cached_tokens: 1e308 }));
      appendRecord(storage, rec({ cached_tokens: 1e308 }));
      const res = await fetch(`${s.url}/admin/usage`, {
        headers: { authorization: "Bearer admin-secret" },
      });
      assert.equal(res.status, 200);
      const text = await res.text();
      const body = JSON.parse(text) as { totals: Record<string, unknown> };
      assert.equal("cache" in body.totals, false);
      assert.equal(text.includes('"cached_tokens":null'), false);
      assert.equal(text.includes('"cached_share":null'), false);
    } finally {
      if (s) await s.close();
      cleanupDir(storage);
    }
  });
});

describe("GET /admin/usage stays additive", () => {
  it("old-format ledger: response shape has NO cache key anywhere (existing readers byte-identical)", async () => {
    const storage = tmpDir();
    let s: RunningServer | undefined;
    try {
      s = await startServer(
        makeConfig({ routing: { bulk: ["good"], default: ["good"] } }, storage),
        storage,
      );
      // legacy pre-telemetry row written directly: only the original fields
      appendRecord(storage, rec({ latency_ms: 42 }));
      const res = await fetch(`${s.url}/admin/usage`, {
        headers: { authorization: "Bearer admin-secret" },
      });
      assert.equal(res.status, 200);
      const body = (await res.json()) as {
        totals: Record<string, unknown>;
        groups: Array<Record<string, unknown>>;
      };
      assert.equal("cache" in body.totals, false);
      assert.deepEqual(Object.keys(body.totals).sort(), [
        "input_tokens",
        "output_tokens",
        "perf",
        "requests",
        "usd",
      ]);
      assert.equal(body.groups.length, 1);
      assert.equal("cache" in body.groups[0]!, false);
      assert.deepEqual(Object.keys(body.groups[0]!).sort(), [
        "input_tokens",
        "model",
        "output_tokens",
        "perf",
        "project",
        "provider",
        "requests",
        "usd",
      ]);
    } finally {
      if (s) await s.close();
      cleanupDir(storage);
    }
  });

  it("cached traffic: totals + serving group gain cache with exact sums; response keeps all legacy keys", async () => {
    const storage = tmpDir();
    let s: RunningServer | undefined;
    try {
      s = await startServer(
        makeConfig({ routing: { bulk: ["good"], default: ["good"] } }, storage),
        storage,
      );
      const cachedRes = await chat(s.port, TEST_KEY, {
        model: "good",
        messages: [{ role: "user", content: "[mock@good:cached] hello" }],
      });
      assert.equal(cachedRes.status, 200);
      const plainRes = await chat(s.port, TEST_KEY, {
        model: "good",
        messages: [{ role: "user", content: "hi" }],
      });
      assert.equal(plainRes.status, 200);

      await waitFor(() => (readJsonl(`${storage}/usage.jsonl`).length === 2 ? true : undefined));
      const rows = readJsonl(`${storage}/usage.jsonl`);
      const cachedRow = rows.find((r) => "cached_tokens" in r)!;
      const plainRow = rows.find((r) => !("cached_tokens" in r))!;
      const expectedShare =
        Math.round(
          ((cachedRow["cached_tokens"] as number) /
            ((cachedRow["input_tokens"] as number) + (plainRow["input_tokens"] as number))) *
            1000,
        ) / 1000;

      const res = await fetch(`${s.url}/admin/usage`, {
        headers: { authorization: "Bearer admin-secret" },
      });
      const body = (await res.json()) as {
        totals: { requests: number; cache?: CacheLike };
        groups: Array<{ provider: string; cache?: CacheLike }>;
      };
      // legacy keys all still present
      for (const k of ["requests", "input_tokens", "output_tokens", "usd", "perf"]) {
        assert.ok(k in body.totals, `legacy key totals.${k} must survive`);
      }
      const cache = body.totals.cache!;
      assert.ok(cache, "totals.cache present");
      assert.equal(cache.cached_tokens, cachedRow["cached_tokens"]);
      assert.equal(cache.cached_share, expectedShare);

      const g = body.groups.find((x) => x.provider === "good")!;
      assert.ok(g.cache, "serving group carries cache");
      assert.equal(g.cache!.cached_tokens, cache.cached_tokens);
    } finally {
      if (s) await s.close();
      cleanupDir(storage);
    }
  });
});
