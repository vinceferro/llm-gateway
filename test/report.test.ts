/**
 * RED-first tests for src/report.ts — the pure counterfactual-savings +
 * work-delivered computation. Honesty contract under test:
 *  - every savings number is derivable from stated assumptions
 *  - cache benefit is NOT credited (full-rate input) — USD overestimated
 *  - plan-covered ($0/$0 config pricing, non-local) rows force a notice
 *  - unverified-priced models are EXCLUDED from cf math with a warning
 *  - local rows are excluded from counterfactuals and shown in the split
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { ProviderConfig } from "../src/config.ts";
import { filterRecords, type UsageRecord } from "../src/ledger.ts";
import { resolveReportPricing } from "../src/prices.ts";
import { buildReport, type ReportInput } from "../src/report.ts";

/** $0.22 in / $0.66 out per Mtok → 1M+1M tokens costs exactly 0.88 at list. */
const M = 1_000_000;

function rec(over: Partial<UsageRecord> = {}): UsageRecord {
  return {
    ts: "2026-08-15T10:00:00.000Z",
    project: "proj-a",
    provider: "ds",
    model: "deepseek-v4-flash",
    task_class: "bulk",
    input_tokens: M,
    output_tokens: M,
    usd: 0.88, // metered at config pricing 0.22/0.66
    latency_ms: 100,
    stream: false,
    fallback_used: false,
    attempts: 1,
    ...over,
  };
}

const PROVIDERS = {
  ds: {
    type: "openai",
    base_url: "https://api.deepseek.com/v1",
    model_id: "deepseek-v4-flash",
    pricing: { input_per_mtok: 0.22, output_per_mtok: 0.66 },
    task_classes: ["bulk"],
  },
  planDs: {
    type: "openai",
    base_url: "https://plan.example.com/v1",
    model_id: "deepseek-v4-flash",
    pricing: { input_per_mtok: 0, output_per_mtok: 0 },
    task_classes: ["bulk"],
  },
  glm: {
    type: "openai",
    base_url: "https://api.z.ai/api/paas/v4",
    model_id: "glm-4.6",
    pricing: { input_per_mtok: 0.6, output_per_mtok: 2.2 },
    task_classes: ["long-run"],
  },
  local: {
    type: "openai",
    base_url: "http://127.0.0.1:11434/v1",
    model_id: "qwen3:8b",
    pricing: { input_per_mtok: 0, output_per_mtok: 0 },
    task_classes: ["autocomplete"],
  },
} as unknown as Record<string, ProviderConfig>;

function inputOf(
  rows: UsageRecord[],
  over: Partial<ReportInput> = {},
  pricing = resolveReportPricing(undefined),
): ReportInput {
  return { month: "2026-08", rows, providers: PROVIDERS, pricing, ...over };
}

/** money comparisons at nano-dollar tolerance (ledger rounds to 1e-9) */
function approxUsd(got: number, expected: number, msg?: string): void {
  assert.ok(
    Math.abs(got - expected) < 5e-9,
    `${msg ?? "usd"}: expected ~${expected}, got ${got}`,
  );
}

describe("counterfactual math", () => {
  it("prices ALL input at full list rate — cached_tokens are NOT credited any discount", () => {
    const rows = [
      rec({ input_tokens: M, output_tokens: M, usd: 0.88, cached_tokens: 400_000 }),
      rec({ input_tokens: 2 * M, output_tokens: M, usd: 1.1 }),
    ];
    const r = buildReport(inputOf(rows));
    // cfA row 1: full 1M input (not 600k) + 1M out at 0.22/0.66 = 0.88
    approxUsd(r.counterfactual.cf_a_usd, 0.88 + 1.1, "cfA (no-cache)");
    approxUsd(r.counterfactual.cf_b_usd, 1.98, "cfB (baseline is the same model)");
    approxUsd(r.counterfactual.actual_usd, 1.98);
    approxUsd(r.counterfactual.routing_cache_savings_usd, 0, "same-model workload: no routing savings");
    approxUsd(r.counterfactual.total_savings_usd, 0);
    assert.equal(r.counterfactual.scope_requests, 2);
    assert.match(r.assumptions.join("\n"), /full input rate/);
    assert.match(r.assumptions.join("\n"), /OVERestimated/i);
  });

  it("savings lines: cfB − cfA is routing/cache savings; cfB − actual is total vs baseline", () => {
    const pricing = resolveReportPricing({
      baseline: { model: "premium-ref", input_per_mtok: 3, output_per_mtok: 9 },
    });
    const rows = [
      rec({ input_tokens: M, output_tokens: M, usd: 0.88 }),
      rec({ input_tokens: 2 * M, output_tokens: M, usd: 1.1 }),
    ];
    const r = buildReport(inputOf(rows, {}, pricing));
    // cfA: 0.88 + (2*0.22 + 0.66) = 1.98 ; cfB: 12 + 15 = 27
    approxUsd(r.counterfactual.cf_a_usd, 1.98, "cfA");
    approxUsd(r.counterfactual.cf_b_usd, 27, "cfB");
    approxUsd(r.counterfactual.routing_cache_savings_usd, 27 - 1.98, "B − A");
    approxUsd(r.counterfactual.total_savings_usd, 27 - 1.98, "B − actual (config pricing == list here)");
    const all = r.assumptions.join("\n");
    assert.match(all, /Counterfactual A/);
    assert.match(all, /Counterfactual B/);
    assert.match(all, /premium-ref/);
  });

  it("actual may exceed cfB — negative savings print honestly", () => {
    const pricing = resolveReportPricing({
      prices: { "kimi-k2": { input_per_mtok: 3, output_per_mtok: 9 } },
    });
    const rows = [rec({ provider: "kim", model: "kimi-k2", usd: 12 })];
    const r = buildReport(inputOf(rows, {}, pricing));
    approxUsd(r.counterfactual.cf_b_usd, 0.88);
    approxUsd(r.counterfactual.cf_a_usd, 12);
    approxUsd(r.counterfactual.total_savings_usd, 0.88 - 12, "negative, not hidden");
    assert.ok(r.counterfactual.total_savings_usd < 0);
  });
});

describe("plan-honesty rule", () => {
  it("plan-covered rows (config $0/$0, non-local host) force the value-not-cash notice", () => {
    const pricing = resolveReportPricing({
      baseline: { model: "premium-ref", input_per_mtok: 3, output_per_mtok: 9 },
    });
    const rows = [
      rec({ provider: "ds", usd: 0.88 }),
      rec({ provider: "planDs", usd: 0, input_tokens: 2 * M, output_tokens: M }),
    ];
    const r = buildReport(inputOf(rows, {}, pricing));
    assert.equal(r.counterfactual.plan_requests, 1);
    // plan row cfA: 2M in @0.22 + 1M out @0.66 = 1.10 of list-price tokens avoided
    approxUsd(r.counterfactual.plan_value_avoided_usd, 1.1);
    const notice = r.counterfactual.plan_notice;
    assert.ok(notice, "plan notice is FORCED when plan rows exist");
    assert.match(notice!, /plan coverage/i);
    assert.match(notice!, /LIST-PRICE VALUE AVOIDED/);
    assert.match(notice!, /not cash/i);
    assert.match(r.assumptions.join("\n"), /LIST-PRICE VALUE AVOIDED/);
    // actual scope includes the $0 plan row: total savings = cfB − (0.88 + 0)
    approxUsd(r.counterfactual.total_savings_usd, 27 - 0.88);
  });

  it("no plan rows → no plan notice", () => {
    const r = buildReport(inputOf([rec({})]));
    assert.equal(r.counterfactual.plan_requests, 0);
    assert.equal(r.counterfactual.plan_notice, null);
    assert.ok(!r.assumptions.some((a) => /plan coverage/i.test(a)));
  });
});

describe("unverified pricing exclusion", () => {
  it("glm-4.6 rows are EXCLUDED from cf math with an unverified-pricing warning", () => {
    const rows = [
      rec({ provider: "ds", usd: 0.88 }),
      rec({ provider: "glm", model: "glm-4.6", usd: 2.8, input_tokens: M, output_tokens: M }),
    ];
    const r = buildReport(inputOf(rows));
    assert.equal(r.counterfactual.scope_requests, 1, "only the verified-price row is in scope");
    assert.equal(r.counterfactual.excluded_unverified_requests, 1);
    assert.deepEqual(r.counterfactual.excluded_unverified_models, ["glm-4.6"]);
    approxUsd(r.counterfactual.cf_a_usd, 0.88, "glm row contributes NOTHING to cfA");
    approxUsd(r.counterfactual.cf_b_usd, 0.88);
    const warnings = r.warnings.join("\n");
    assert.match(warnings, /unverified pricing/i);
    assert.match(warnings, /glm-4\.6/);
    // the excluded row still shows in the ledger-side table + split
    const total = r.totals;
    assert.equal(total.requests, 2);
    approxUsd(total.actual_usd, 3.68);
    assert.equal(r.work.split.cloud.requests, 2);
  });

  it("unknown-provider rows stay in cf scope when the MODEL price is verified, with a warning", () => {
    const rows = [rec({ provider: "ghost" })];
    const r = buildReport(inputOf(rows));
    assert.equal(r.counterfactual.scope_requests, 1);
    approxUsd(r.counterfactual.cf_b_usd, 0.88);
    assert.equal(r.work.split.unknown.requests, 1);
    assert.match(r.warnings.join("\n"), /ghost/);
  });
});

describe("local rows", () => {
  it("are excluded from cfA/cfB, counted in the local split, and never warned about", () => {
    const pricing = resolveReportPricing({
      baseline: { model: "premium-ref", input_per_mtok: 3, output_per_mtok: 9 },
    });
    const rows = [
      rec({ provider: "ds", usd: 0.88 }),
      rec({ provider: "local", model: "qwen3:8b", usd: 0, input_tokens: 5 * M, output_tokens: 2 * M }),
    ];
    const r = buildReport(inputOf(rows, {}, pricing));
    assert.equal(r.counterfactual.excluded_local_requests, 1);
    assert.equal(r.counterfactual.scope_requests, 1);
    approxUsd(r.counterfactual.cf_b_usd, 12, "local row NOT re-priced into cfB");
    approxUsd(r.counterfactual.cf_a_usd, 0.88);
    assert.equal(r.work.split.local.requests, 1);
    assert.equal(r.work.split.local.input_tokens, 5 * M);
    assert.equal(r.work.split.cloud.requests, 1);
    assert.ok(!r.warnings.some((w) => /qwen3:8b/.test(w)), "local exclusion is silent (split covers it)");
  });
});

describe("work delivered", () => {
  it("derives turns, output tokens, stream hours, reliability, fallbacks, split, ttfb", () => {
    const rows = [
      rec({ provider: "ds", output_tokens: 1000, stream: true, stream_ms: 3_600_000, ttfb_ms: 10, latency_ms: 10 }),
      rec({ provider: "ds", output_tokens: 500, stream: true, stream_ms: 1_800_000, ttfb_ms: 20, latency_ms: 20 }),
      rec({ provider: "local", model: "qwen3:8b", usd: 0, output_tokens: 999, incomplete: true, fallback_used: true }),
      rec({ provider: "glm", model: "glm-4.6", usd: 2.8, output_tokens: 10, attempts: 3, ttfb_ms: 40 }),
    ];
    const r = buildReport(inputOf(rows));
    const w = r.work;
    assert.equal(w.agent_turns, 4);
    assert.equal(w.output_tokens, 1000 + 500 + 999 + 10);
    assert.equal(w.stream_hours, 1.5, "3_600_000 + 1_800_000 ms = 1.5h at 1 decimal");
    // 3 of 4 rows without incomplete -> 75%
    assert.equal(w.reliability_pct, 75);
    assert.equal(w.fallbacks_survived, 2, "fallback_used OR attempts>1");
    assert.equal(w.split.local.requests, 1);
    assert.equal(w.split.cloud.requests, 3);
    assert.equal(w.split.unknown.requests, 0);

    // ttfb percentiles per provider, linear interpolation like latency
    const ds = w.ttfb_by_provider.find((t) => t.provider === "ds")!;
    assert.deepEqual([ds.ttfb_p50_ms, ds.ttfb_p95_ms], [15, 19.5]); // [10,20]: p50 rank .5 -> 15; p95 rank .95 -> 19.5
    const glm = w.ttfb_by_provider.find((t) => t.provider === "glm")!;
    assert.equal(glm.ttfb_p50_ms, 40, "single sample: p50 = p95 = sample");
    assert.equal(glm.ttfb_p95_ms, 40);
    assert.ok(!w.ttfb_by_provider.find((t) => t.provider === "local"), "no ttfb rows -> provider omitted");
  });

  it("reliability is null on an empty ledger and everything zeroes without crashing", () => {
    const r = buildReport(inputOf([]));
    assert.equal(r.work.agent_turns, 0);
    assert.equal(r.work.reliability_pct, null);
    assert.equal(r.work.stream_hours, 0);
    assert.deepEqual(r.projects, []);
    assert.equal(r.totals.requests, 0);
    assert.equal(r.counterfactual.scope_requests, 0);
    assert.deepEqual(r.warnings, []);
  });
});

describe("per-project table", () => {
  it("one row per project plus totals; savings compare cfB against the SAME cf-scope actual", () => {
    const pricing = resolveReportPricing({
      baseline: { model: "premium-ref", input_per_mtok: 3, output_per_mtok: 9 },
    });
    const rows = [
      rec({ project: "alpha", provider: "ds", usd: 0.88 }),
      rec({ project: "alpha", provider: "planDs", usd: 0 }),
      rec({ project: "beta", provider: "ds", usd: 1.1, input_tokens: 2 * M }),
    ];
    const r = buildReport(inputOf(rows, {}, pricing));
    assert.deepEqual(r.projects.map((p) => p.project), ["alpha", "beta"]);
    const alpha = r.projects[0]!;
    assert.equal(alpha.requests, 2);
    approxUsd(alpha.actual_usd, 0.88, "ledger usd over ALL project rows");
    // alpha cf scope: both rows (ds verified, planDs verified model); each 1M/1M:
    // cfA = 0.88 + 0.88 ; cfB = 12 + 12 = 24
    approxUsd(alpha.cf_b_usd!, 24);
    approxUsd(alpha.cf_a_usd!, 0.88 + 0.88);
    approxUsd(alpha.savings_vs_baseline_usd!, 24 - (0.88 + 0), "vs cf-scope actual, not all-row actual");
    const totals = r.totals;
    assert.equal(totals.requests, 3);
    approxUsd(totals.actual_usd, 1.98);
    approxUsd(totals.cf_b_usd!, 39, "alpha 24 + beta 15 (2M/1M @ 3/9)");
    assert.ok(
      Math.abs(totals.savings_vs_baseline_usd! - r.counterfactual.total_savings_usd) < 5e-9,
      "totals.savings == counterfactual.total_savings",
    );
  });

  it("a project with only excluded rows shows null counterfactuals (never a fake zero)", () => {
    const rows = [rec({ provider: "local", model: "qwen3:8b", usd: 0 })];
    const r = buildReport(inputOf(rows));
    const only = r.projects[0]!;
    assert.equal(only.cf_a_usd, null);
    assert.equal(only.cf_b_usd, null);
    assert.equal(only.savings_vs_baseline_usd, null);
    assert.equal(r.counterfactual.scope_requests, 0);
  });
});

describe("daily buckets", () => {
  it("one entry per day that has rows, sorted ascending, with per-day sums (off-month row filtered out by the caller)", () => {
    // ReportInput.rows arrive ALREADY month/project-filtered (filterRecords) —
    // same contract as the CLI + /admin/report handlers.
    const seeded: UsageRecord[] = [
      rec({ ts: "2026-08-02T12:00:00.000Z", usd: 0.5, input_tokens: 2 * M, output_tokens: 3 * M }),
      rec({ ts: "2026-08-31T23:59:59.999Z", usd: 0.25 }),
      rec({ ts: "2026-08-02T18:00:00.000Z", usd: 0.125 }),
      rec({ ts: "2026-08-01T00:30:00.000Z", usd: 0.3 }), // UTC month boundary → day 1
      rec({ ts: "2026-07-31T23:00:00.000Z", usd: 99 }), // other month → filtered out
    ];
    const rows = filterRecords(seeded, { month: "2026-08" });
    const r = buildReport(inputOf(rows, { month: "2026-08" }));
    assert.deepEqual(
      r.daily.map((d) => d.day),
      [1, 2, 31],
      "one entry per day-with-rows, ascending; July row absent (no zero-fill, no off-month leak)",
    );
    const d1 = r.daily[0]!;
    const d2 = r.daily[1]!;
    const d31 = r.daily[2]!;
    // day 1: the single 00:30Z boundary row
    assert.equal(d1.requests, 1);
    assert.equal(d1.input_tokens, M);
    assert.equal(d1.output_tokens, M);
    approxUsd(d1.usd, 0.3);
    // day 2: both rows aggregate into ONE entry
    assert.equal(d2.requests, 2);
    assert.equal(d2.input_tokens, 3 * M);
    assert.equal(d2.output_tokens, 4 * M);
    approxUsd(d2.usd, 0.5 + 0.125, "same-day rows sum usd");
    // day 31: untouched defaults from rec()
    assert.equal(d31.requests, 1);
    assert.equal(d31.input_tokens, M);
    assert.equal(d31.output_tokens, M);
    approxUsd(d31.usd, 0.25);
  });

  it("day numbers derive from UTC, never the host's local timezone", () => {
    // 23:30Z and next-day 00:30Z are the same local date in UTC-5 hosts —
    // a local-date parse would collapse them into one bucket; UTC must not.
    const rows = [
      rec({ ts: "2026-08-15T23:30:00.000Z" }),
      rec({ ts: "2026-08-16T00:30:00.000Z" }),
    ];
    const r = buildReport(inputOf(rows));
    assert.deepEqual(
      r.daily.map((d) => d.day),
      [15, 16],
    );
  });

  it("empty month → daily = []", () => {
    const r = buildReport(inputOf([]));
    assert.deepEqual(r.daily, []);
  });
});

describe("baseline identity surfaces in the report", () => {
  it("carries the resolved baseline (id, rates, source, asOf, verified) for receipts", () => {
    const r = buildReport(inputOf([rec({})]));
    assert.equal(r.baseline.id, "deepseek-v4-flash");
    assert.equal(r.baseline.input_per_mtok, 0.22);
    assert.equal(r.baseline.source, "api-docs.deepseek.com");
    assert.equal(r.baseline.asOf, "2026-08-28");
    assert.equal(r.baseline.verified, true);
    assert.match(r.assumptions.join("\n"), /api-docs\.deepseek\.com/);
    assert.match(r.assumptions.join("\n"), /2026-08-28/);
  });
});
