/**
 * RED-first tests for performance telemetry:
 *  - ledger rows gain optional ttfb_ms (first upstream byte) and stream_ms
 *    (stream generation window = last − first upstream byte)
 *  - /admin/usage groups + totals gain a derived `perf` object
 *  - old-format rows (no perf fields) must summarize cleanly
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

interface PerfLike {
  latency_p50_ms: number;
  latency_p95_ms: number;
  latency_avg_ms: number;
  ttfb_avg_ms?: number;
  ttfb_p50_ms?: number;
  ttfb_p95_ms?: number;
  tok_per_s_avg?: number;
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

describe("perf telemetry: ledger row capture", () => {
  it("streamed mock request: row has integer ttfb_ms and stream_ms >= 0, ttfb <= latency, and a real generation window for a drip stream", async () => {
    const storage = tmpDir();
    let s: RunningServer | undefined;
    try {
      s = await startServer(
        makeConfig({ routing: { bulk: ["good"], default: ["good"] } }, storage),
        storage,
      );

      // drip stream: 7 frames x 30ms sleep before each enqueue -> first byte
      // after ~30ms, last byte ~180ms later
      const res = await chat(s.port, TEST_KEY, {
        model: "good",
        stream: true,
        messages: [{ role: "user", content: "[mock@good:slow-stream:30] drip" }],
      });
      assert.equal(res.status, 200);
      assert.ok(res.text.includes("data: [DONE]"));

      const row = await waitFor(() => {
        const rows = readJsonl(`${storage}/usage.jsonl`);
        return rows.length === 1 ? rows[0] : undefined;
      });
      assert.equal(row["stream"], true);

      assert.equal(typeof row["ttfb_ms"], "number", "ttfb_ms must be present on streamed rows");
      assert.ok(Number.isInteger(row["ttfb_ms"]), `ttfb_ms must be an integer, got ${row["ttfb_ms"]}`);
      assert.ok(
        (row["ttfb_ms"] as number) >= 0,
        `ttfb_ms must be >= 0, got ${row["ttfb_ms"]}`,
      );
      // one 30ms sleep precedes the first frame
      assert.ok(
        (row["ttfb_ms"] as number) >= 20,
        `ttfb should include the first frame delay, got ${row["ttfb_ms"]}`,
      );

      assert.equal(typeof row["stream_ms"], "number", "stream_ms must be present on streamed rows");
      assert.ok(Number.isInteger(row["stream_ms"]), `stream_ms must be an integer, got ${row["stream_ms"]}`);
      // 6 further sleeps separate first from last upstream byte
      assert.ok(
        (row["stream_ms"] as number) >= 120,
        `stream_ms should cover the 6 remaining frame gaps (~180ms), got ${row["stream_ms"]}`,
      );

      assert.ok(
        (row["ttfb_ms"] as number) <= (row["latency_ms"] as number),
        `invariant violated: ttfb_ms ${row["ttfb_ms"]} > latency_ms ${row["latency_ms"]}`,
      );
    } finally {
      if (s) await s.close();
      cleanupDir(storage);
    }
  });

  it("fast streamed request: both fields present, integers, stream_ms >= 0, ttfb <= latency", async () => {
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
        messages: [{ role: "user", content: "hi" }],
      });
      assert.equal(res.status, 200);

      const row = await waitFor(() => {
        const rows = readJsonl(`${storage}/usage.jsonl`);
        return rows.length === 1 ? rows[0] : undefined;
      });
      assert.equal(typeof row["ttfb_ms"], "number");
      assert.ok(Number.isInteger(row["ttfb_ms"]));
      assert.equal(typeof row["stream_ms"], "number");
      assert.ok(Number.isInteger(row["stream_ms"]));
      assert.ok((row["stream_ms"] as number) >= 0);
      assert.ok((row["ttfb_ms"] as number) <= (row["latency_ms"] as number));
    } finally {
      if (s) await s.close();
      cleanupDir(storage);
    }
  });

  it("non-streaming mock request: row has ttfb_ms, no stream_ms key at all", async () => {
    const storage = tmpDir();
    let s: RunningServer | undefined;
    try {
      s = await startServer(
        makeConfig({ routing: { bulk: ["good"], default: ["good"] } }, storage),
        storage,
      );
      const res = await chat(s.port, TEST_KEY, {
        model: "good",
        messages: [{ role: "user", content: "hi" }],
      });
      assert.equal(res.status, 200);

      const row = await waitFor(() => {
        const rows = readJsonl(`${storage}/usage.jsonl`);
        return rows.length === 1 ? rows[0] : undefined;
      });
      assert.equal(row["stream"], false);
      assert.equal(typeof row["ttfb_ms"], "number", "ttfb_ms must be present on non-streamed rows");
      assert.ok(Number.isInteger(row["ttfb_ms"]));
      assert.ok(
        (row["ttfb_ms"] as number) <= (row["latency_ms"] as number),
        `invariant violated: ttfb_ms ${row["ttfb_ms"]} > latency_ms ${row["latency_ms"]}`,
      );
      assert.equal(
        "stream_ms" in row,
        false,
        "stream_ms must be ABSENT (not null/0) on non-streamed rows",
      );
    } finally {
      if (s) await s.close();
      cleanupDir(storage);
    }
  });
});

describe("perf stats in summarizeLedger", () => {
  it("latency percentiles use linear interpolation; avg is the mean", () => {
    const dir = tmpDir();
    try {
      // latencies [10, 20, 30, 40]: p50 rank 1.5 -> 25; p95 rank 2.85 -> 38.5
      for (const latency of [10, 20, 30, 40]) {
        appendRecord(dir, rec({ latency_ms: latency, ttfb_ms: latency === 10 ? 10 : 30 }));
      }
      const s = summarizeLedger(dir, {});
      const perf = s.totals.perf as PerfLike;
      assert.ok(perf, "totals.perf must be present when rows exist");
      assert.equal(perf.latency_p50_ms, 25);
      assert.equal(perf.latency_p95_ms, 38.5);
      assert.equal(perf.latency_avg_ms, 25);
      // ttfb carried by all 4 rows: [10, 30, 30, 30]
      assert.equal(perf.ttfb_avg_ms, 25);
      assert.equal("tok_per_s_avg" in perf, false, "no qualifying streamed rows -> key absent");
    } finally {
      cleanupDir(dir);
    }
  });

  it("single sample: p50 = p95 = avg = the sample", () => {
    const dir = tmpDir();
    try {
      appendRecord(dir, rec({ latency_ms: 7, ttfb_ms: 3 }));
      const perf = summarizeLedger(dir, {}).totals.perf as PerfLike;
      assert.equal(perf.latency_p50_ms, 7);
      assert.equal(perf.latency_p95_ms, 7);
      assert.equal(perf.latency_avg_ms, 7);
      assert.equal(perf.ttfb_avg_ms, 3);
    } finally {
      cleanupDir(dir);
    }
  });

  it("empty ledger: totals.perf is omitted entirely", () => {
    const dir = tmpDir();
    try {
      const s = summarizeLedger(dir, {});
      assert.equal(s.totals.requests, 0);
      assert.equal("perf" in s.totals, false, "no rows -> no perf object");
      assert.deepEqual(s.groups, []);
    } finally {
      cleanupDir(dir);
    }
  });

  it("p95 >= p50 invariant holds on heavily skewed samples", () => {
    const dir = tmpDir();
    try {
      for (const latency of [1, 1, 1, 1, 5000]) {
        appendRecord(dir, rec({ latency_ms: latency }));
      }
      const perf = summarizeLedger(dir, {}).totals.perf as PerfLike;
      assert.ok(perf.latency_p95_ms >= perf.latency_p50_ms);
      // spot-check the interpolation on this set: p50 rank 2 -> 1; p95 rank 3.8 -> 1 + 4999*0.8
      assert.equal(perf.latency_p50_ms, 1);
      assert.equal(perf.latency_p95_ms, Math.round((1 + (5000 - 1) * 0.8) * 1000) / 1000);
    } finally {
      cleanupDir(dir);
    }
  });

  it("tok_per_s_avg is the MEAN of per-row output_tokens/(stream_ms/1000); excludes stream_ms=0 and non-stream rows", () => {
    const dir = tmpDir();
    try {
      // 100 tok over 4000ms = 25 tok/s; 60 tok over 1000ms = 60 tok/s -> mean 42.5
      appendRecord(dir, rec({ stream: true, stream_ms: 4000, output_tokens: 100, latency_ms: 4100 }));
      appendRecord(dir, rec({ stream: true, stream_ms: 1000, output_tokens: 60, latency_ms: 1100 }));
      // excluded from tok stats but still counted for latency:
      appendRecord(dir, rec({ stream: true, stream_ms: 0, output_tokens: 999, latency_ms: 300 }));
      appendRecord(dir, rec({ stream: false, latency_ms: 400 }));
      const perf = summarizeLedger(dir, {}).totals.perf as PerfLike;
      assert.equal(perf.tok_per_s_avg, 42.5);
      // latency stats include ALL rows: [4100, 1100, 300, 400]
      assert.equal(perf.latency_avg_ms, 1475);
      assert.equal("ttfb_avg_ms" in perf, false, "no ttfb-bearing rows -> key absent");
    } finally {
      cleanupDir(dir);
    }
  });

  it("rows missing ttfb are excluded from ttfb stats but still count for latency stats", () => {
    const dir = tmpDir();
    try {
      appendRecord(dir, rec({ latency_ms: 10, ttfb_ms: 10 }));
      appendRecord(dir, rec({ latency_ms: 50 })); // old-format row: no ttfb
      const perf = summarizeLedger(dir, {}).totals.perf as PerfLike;
      assert.equal(perf.ttfb_avg_ms, 10, "only the ttfb-bearing row is averaged");
      assert.equal(perf.latency_avg_ms, 30, "both rows count for latency");
    } finally {
      cleanupDir(dir);
    }
  });

  it("foreign row with ttfb_ms: null is EXCLUDED from ttfb stats (omission rule must admit null, not just undefined)", () => {
    const dir = tmpDir();
    try {
      appendRecord(dir, rec({ latency_ms: 10, ttfb_ms: 100 }));
      // JSON cannot express undefined, so a hand-written/foreign row arrives as
      // null — a `=== undefined` omission guard averages it in as a 0ms sample
      appendRecord(dir, rec({ latency_ms: 50, ttfb_ms: null as unknown as number }));
      const perf = summarizeLedger(dir, {}).totals.perf as PerfLike;
      assert.equal(perf.ttfb_avg_ms, 100, "null-ttfb row must not be averaged in as 0ms");
      assert.equal(perf.latency_avg_ms, 30, "both rows still count for latency stats");
    } finally {
      cleanupDir(dir);
    }
  });

  it("foreign row without a finite latency_ms is excluded from latency stats (percentiles stay finite)", () => {
    const dir = tmpDir();
    try {
      appendRecord(dir, rec({ latency_ms: 42, ttfb_ms: 42 }));
      // hand-written/torn row missing latency_ms entirely (undefined is dropped
      // by JSON.stringify — mirrors `"latency_ms": null`-style foreign rows)
      appendRecord(dir, rec({ latency_ms: undefined as unknown as number }));
      const perf = summarizeLedger(dir, {}).totals.perf as PerfLike;
      assert.ok(perf, "the finite-latency row still yields a perf object");
      assert.equal(perf.latency_p50_ms, 42);
      assert.equal(perf.latency_p95_ms, 42);
      assert.equal(perf.latency_avg_ms, 42, "null/undefined latency must not poison the average");
      assert.equal(perf.ttfb_avg_ms, 42);
    } finally {
      cleanupDir(dir);
    }
  });

  it("backward compat: OLD-format rows (no ttfb/stream_ms) summarize cleanly — latency stats present, perf extras absent", () => {
    const dir = tmpDir();
    try {
      // written as a pre-telemetry row would have been (no ttfb_ms/stream_ms)
      appendRecord(dir, rec({ latency_ms: 42 }));
      const s = summarizeLedger(dir, {});
      const perf = s.totals.perf as PerfLike;
      assert.ok(perf, "latency stats must exist for old rows");
      assert.equal(perf.latency_p50_ms, 42);
      assert.equal(perf.latency_p95_ms, 42);
      assert.equal(perf.latency_avg_ms, 42);
      assert.equal("ttfb_avg_ms" in perf, false);
      assert.equal("tok_per_s_avg" in perf, false);
      assert.deepEqual(s.groups[0]!.perf && Object.keys(s.groups[0]!.perf).sort(), [
        "latency_avg_ms",
        "latency_p50_ms",
        "latency_p95_ms",
      ]);
    } finally {
      cleanupDir(dir);
    }
  });

  it("each group carries its own perf computed from only its rows", () => {
    const dir = tmpDir();
    try {
      appendRecord(dir, rec({ provider: "a", model: "a-model", latency_ms: 10, ttfb_ms: 5 }));
      appendRecord(dir, rec({ provider: "b", model: "b-model", latency_ms: 100, stream: true, stream_ms: 2000, output_tokens: 100 }));
      const s = summarizeLedger(dir, {});
      const ga = s.groups.find((g) => g.provider === "a")!;
      const gb = s.groups.find((g) => g.provider === "b")!;
      assert.equal(ga.perf.latency_p50_ms, 10);
      assert.equal(ga.perf.ttfb_avg_ms, 5);
      assert.equal("tok_per_s_avg" in ga.perf, false);
      assert.equal(gb.perf.latency_p50_ms, 100);
      assert.equal(gb.perf.tok_per_s_avg, 50);
      assert.equal("ttfb_avg_ms" in gb.perf, false);
    } finally {
      cleanupDir(dir);
    }
  });
});

describe("ttfb percentiles (additive to ttfb_avg_ms)", () => {
  it("ttfb_p50/p95 use the same linear-interpolation percentile as latency", () => {
    const dir = tmpDir();
    try {
      // ttfbs [10, 20, 30, 40]: p50 rank 1.5 -> 25; p95 rank 2.85 -> 38.5
      let i = 0;
      for (const ttfb of [10, 20, 30, 40]) {
        appendRecord(dir, rec({ latency_ms: 100 + i++, ttfb_ms: ttfb }));
      }
      const perf = summarizeLedger(dir, {}).totals.perf as PerfLike;
      assert.equal(perf.ttfb_p50_ms, 25);
      assert.equal(perf.ttfb_p95_ms, 38.5);
      assert.equal(perf.ttfb_avg_ms, 25);
      assert.ok(perf.ttfb_p95_ms >= perf.ttfb_p50_ms);
    } finally {
      cleanupDir(dir);
    }
  });

  it("single ttfb sample: p50 = p95 = avg = the sample", () => {
    const dir = tmpDir();
    try {
      appendRecord(dir, rec({ latency_ms: 7, ttfb_ms: 3 }));
      const perf = summarizeLedger(dir, {}).totals.perf as PerfLike;
      assert.equal(perf.ttfb_p50_ms, 3);
      assert.equal(perf.ttfb_p95_ms, 3);
      assert.equal(perf.ttfb_avg_ms, 3);
    } finally {
      cleanupDir(dir);
    }
  });

  it("null-ttfb foreign rows are excluded from ttfb percentiles, not averaged in as 0ms", () => {
    const dir = tmpDir();
    try {
      appendRecord(dir, rec({ latency_ms: 10, ttfb_ms: 100 }));
      appendRecord(dir, rec({ latency_ms: 50, ttfb_ms: null as unknown as number }));
      const perf = summarizeLedger(dir, {}).totals.perf as PerfLike;
      assert.equal(perf.ttfb_p50_ms, 100);
      assert.equal(perf.ttfb_p95_ms, 100);
      assert.equal(perf.ttfb_avg_ms, 100);
    } finally {
      cleanupDir(dir);
    }
  });

  it("no ttfb-bearing rows: all three ttfb keys absent (omission rules unchanged)", () => {
    const dir = tmpDir();
    try {
      appendRecord(dir, rec({ latency_ms: 42 }));
      const perf = summarizeLedger(dir, {}).totals.perf as PerfLike;
      assert.equal("ttfb_avg_ms" in perf, false);
      assert.equal("ttfb_p50_ms" in perf, false);
      assert.equal("ttfb_p95_ms" in perf, false);
    } finally {
      cleanupDir(dir);
    }
  });

  it("additive-only shape: a ttfb-bearing row set exposes exactly the six perf keys", () => {
    const dir = tmpDir();
    try {
      appendRecord(dir, rec({ latency_ms: 42, ttfb_ms: 11 }));
      const g = summarizeLedger(dir, {}).groups[0]!;
      assert.deepEqual(Object.keys(g.perf).sort(), [
        "latency_avg_ms",
        "latency_p50_ms",
        "latency_p95_ms",
        "ttfb_avg_ms",
        "ttfb_p50_ms",
        "ttfb_p95_ms",
      ]);
    } finally {
      cleanupDir(dir);
    }
  });
});

describe("GET /admin/usage exposes perf additively", () => {
  it("totals and groups gain a perf object derived from real requests", async () => {
    const storage = tmpDir();
    let s: RunningServer | undefined;
    try {
      s = await startServer(
        makeConfig({ routing: { bulk: ["good"], default: ["good"] } }, storage),
        storage,
      );
      // one drip stream (stream_ms > 0 -> tok_per_s) + one non-stream call
      const streamRes = await chat(s.port, TEST_KEY, {
        model: "good",
        stream: true,
        messages: [{ role: "user", content: "[mock@good:slow-stream:30] drip" }],
      });
      assert.equal(streamRes.status, 200);
      const plainRes = await chat(s.port, TEST_KEY, {
        model: "good",
        messages: [{ role: "user", content: "hi" }],
      });
      assert.equal(plainRes.status, 200);

      await waitFor(() => (readJsonl(`${storage}/usage.jsonl`).length === 2 ? true : undefined));

      const res = await fetch(`${s.url}/admin/usage`, {
        headers: { authorization: "Bearer admin-secret" },
      });
      assert.equal(res.status, 200);
      const body = (await res.json()) as {
        totals: { requests: number; perf?: PerfLike };
        groups: Array<{ provider: string; perf?: PerfLike }>;
      };
      const perf = body.totals.perf!;
      assert.ok(perf, "totals.perf present");
      assert.equal(body.totals.requests, 2);
      assert.ok(Number.isFinite(perf.latency_avg_ms));
      assert.ok(perf.latency_p95_ms >= perf.latency_p50_ms);
      assert.ok(typeof perf.ttfb_avg_ms === "number");
      assert.ok(typeof perf.ttfb_p50_ms === "number", "ttfb_p50_ms exposed additively");
      assert.ok(typeof perf.ttfb_p95_ms === "number", "ttfb_p95_ms exposed additively");
      assert.ok(perf.ttfb_p95_ms! >= perf.ttfb_p50_ms!);
      assert.ok(typeof perf.tok_per_s_avg === "number", "drip stream should qualify for tok_per_s_avg");

      const g = body.groups.find((x) => x.provider === "good")!;
      assert.ok(g.perf, "group perf present");
      assert.ok(g.perf!.latency_p95_ms >= g.perf!.latency_p50_ms);
    } finally {
      if (s) await s.close();
      cleanupDir(storage);
    }
  });
});
