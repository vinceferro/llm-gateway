/**
 * Pure counterfactual-savings + work-delivered computation over ledger rows.
 *
 * NO I/O and NO clock here: gatewayctl reads the ledger + config, resolves
 * pricing (src/prices.ts) and calls buildReport. Everything the report claims
 * is derivable from the returned object — the assumptions/warnings strings are
 * part of the output, not decoration, and every savings number carries them.
 *
 * Honesty rules (each one regression-tested):
 *  - Counterfactual A "no-cache": each in-scope row priced at its own model's
 *    list price with ALL input tokens at the full input rate — cached_tokens
 *    are deliberately NOT credited any discount, so USD is conservatively
 *    OVERestimated wherever providers bill cached input cheaper.
 *  - Counterfactual B "all-cloud baseline": each in-scope row priced at the
 *    reference provider (default deepseek-v4-flash, verified 2026-08-28).
 *    Local rows are NOT re-priced into B.
 *  - Plan-honesty: rows on plan-covered providers (config pricing $0/$0,
 *    non-local host) force a notice — their actual $0 is plan coverage, and
 *    savings including them are LIST-PRICE VALUE AVOIDED, not cash.
 *  - Unverified pricing: rows on models without a verified list price are
 *    EXCLUDED from all counterfactual math with a warning. Never invented.
 *  - Local rows (loopback base_url) are excluded from cf math entirely (no
 *    cloud counterfactual exists) and shown in the local-vs-cloud split.
 */

import type { ProviderConfig } from "./config.ts";
import { perfStatsOf, round9, type UsageRecord } from "./ledger.ts";
import type { ListPrice, ResolvedPricing } from "./prices.ts";

export interface ReportInput {
  month: string;
  /** undefined = all projects (rendered as "*") */
  project?: string;
  /** ledger rows ALREADY filtered by month/project (see filterRecords) */
  rows: readonly UsageRecord[];
  /** provider configs by id — used for host classification + plan detection */
  providers: Record<string, ProviderConfig>;
  /** resolved price table + baseline (resolveReportPricing) */
  pricing: ResolvedPricing;
}

export interface SplitBucket {
  requests: number;
  input_tokens: number;
  output_tokens: number;
}

export interface ProjectRow {
  project: string;
  requests: number;
  input_tokens: number;
  output_tokens: number;
  /** ledger usd over ALL of the project's rows */
  actual_usd: number;
  /** counterfactuals over the project's cf-scope rows only; null when none qualify (never a fake zero) */
  cf_a_usd: number | null;
  cf_b_usd: number | null;
  /** cfB − ledger usd of the SAME cf-scope rows */
  savings_vs_baseline_usd: number | null;
}

export interface ProviderTtfb {
  provider: string;
  /** rows carrying a ttfb_ms */
  samples: number;
  ttfb_p50_ms?: number;
  ttfb_p95_ms?: number;
}

export interface WorkDelivered {
  /** request count */
  agent_turns: number;
  output_tokens: number;
  /** Σ stream_ms in hours, 1 decimal */
  stream_hours: number;
  /** % of rows without `incomplete` (1 decimal); null on an empty ledger */
  reliability_pct: number | null;
  completed_rows: number;
  total_rows: number;
  /** rows with fallback_used or attempts > 1 */
  fallbacks_survived: number;
  split: { local: SplitBucket; cloud: SplitBucket; unknown: SplitBucket };
  /** per provider, sorted by provider id */
  ttfb_by_provider: ProviderTtfb[];
}

export interface Counterfactual {
  /** rows used in cf math */
  scope_requests: number;
  excluded_local_requests: number;
  excluded_unverified_requests: number;
  excluded_unverified_models: string[];
  /** ledger usd over the cf-scope rows only */
  actual_usd: number;
  cf_a_usd: number;
  cf_b_usd: number;
  /** cfB − cfA: provider-mix (routing + local + plan) savings at list prices */
  routing_cache_savings_usd: number;
  /** cfB − actual: the headline number */
  total_savings_usd: number;
  plan_requests: number;
  /** cfA over plan rows: the list-price value the plan absorbed */
  plan_value_avoided_usd: number;
  /** forced when plan_requests > 0; null otherwise */
  plan_notice: string | null;
}

export interface DailyBucket {
  /** UTC day-of-month parsed from row ts */
  day: number;
  requests: number;
  input_tokens: number;
  output_tokens: number;
  usd: number;
}

export interface ReportOutput {
  month: string;
  project: string;
  total_rows: number;
  projects: ProjectRow[];
  totals: ProjectRow;
  /** one entry per day that HAS rows (no zero-fill), ascending; trend charts */
  daily: DailyBucket[];
  work: WorkDelivered;
  counterfactual: Counterfactual;
  baseline: ListPrice & { id: string };
  assumptions: string[];
  warnings: string[];
}

type HostClass = "local" | "cloud" | "unknown";

function classify(p: ProviderConfig | undefined): HostClass {
  if (!p?.base_url) return "unknown";
  try {
    const h = new URL(p.base_url).hostname;
    return h === "localhost" || h === "127.0.0.1" || h === "[::1]" || h === "::1"
      ? "local"
      : "cloud";
  } catch {
    return "unknown";
  }
}

function isPlanCovered(p: ProviderConfig | undefined, cls: HostClass): boolean {
  return (
    cls === "cloud" &&
    !!p &&
    p.pricing.input_per_mtok === 0 &&
    p.pricing.output_per_mtok === 0
  );
}

function rowCost(p: ListPrice, r: UsageRecord): number {
  return round9((r.input_tokens * p.input_per_mtok + r.output_tokens * p.output_per_mtok) / 1e6);
}

function round1(n: number): number {
  return Math.round(n * 10) / 10;
}

function zeroBucket(): SplitBucket {
  return { requests: 0, input_tokens: 0, output_tokens: 0 };
}

function bucketOf(b: SplitBucket, r: UsageRecord): void {
  b.requests++;
  b.input_tokens += r.input_tokens;
  b.output_tokens += r.output_tokens;
}

function emptyProjectRow(project: string): ProjectRow {
  return {
    project,
    requests: 0,
    input_tokens: 0,
    output_tokens: 0,
    actual_usd: 0,
    cf_a_usd: null,
    cf_b_usd: null,
    savings_vs_baseline_usd: null,
  };
}

/** UTC day-of-month buckets over ALL rows (trend charts). Days without rows
 *  are absent (not zero-filled) — chart layers decide their own zero-fill. */
function dailyBuckets(rows: readonly UsageRecord[]): DailyBucket[] {
  const byDay = new Map<number, UsageRecord[]>();
  for (const r of rows) {
    const day = new Date(r.ts).getUTCDate();
    const list = byDay.get(day) ?? [];
    list.push(r);
    byDay.set(day, list);
  }
  return [...byDay.entries()]
    .sort(([a], [b]) => a - b)
    .map(([day, list]) => {
      let input_tokens = 0;
      let output_tokens = 0;
      let usd = 0;
      for (const r of list) {
        input_tokens += r.input_tokens;
        output_tokens += r.output_tokens;
        usd = round9(usd + r.usd);
      }
      return { day, requests: list.length, input_tokens, output_tokens, usd };
    });
}

/** Usd display formatting lives in the render layer; this module stays numeric. */
export function buildReport(input: ReportInput): ReportOutput {
  const { rows, providers, pricing, month } = input;
  const project = input.project ?? "*";
  const warnings: string[] = [];

  // --- classify every row once --------------------------------------------
  const hostCls = new Map<UsageRecord, HostClass>();
  const isPlan = new Map<UsageRecord, boolean>();
  for (const r of rows) {
    const cls = classify(providers[r.provider]);
    hostCls.set(r, cls);
    isPlan.set(r, isPlanCovered(providers[r.provider], cls));
  }

  // --- counterfactual scope -------------------------------------------------
  const scopeRows: UsageRecord[] = [];
  let excludedLocal = 0;
  let excludedUnverified = 0;
  const unverifiedByModel = new Map<string, number>();
  for (const r of rows) {
    if (hostCls.get(r) === "local") {
      excludedLocal++;
      continue;
    }
    const price = pricing.prices[r.model];
    if (!price || !price.verified) {
      excludedUnverified++;
      unverifiedByModel.set(r.model, (unverifiedByModel.get(r.model) ?? 0) + 1);
      continue;
    }
    scopeRows.push(r);
  }
  for (const [model, n] of [...unverifiedByModel].sort(([a], [b]) => (a < b ? -1 : 1))) {
    const asOf = pricing.prices[model]?.asOf ?? "unverified";
    warnings.push(
      `unverified pricing: model "${model}" has no verified list price (asOf ${asOf}) — ` +
        `${n} row(s) EXCLUDED from all counterfactual math; set report.prices to include them`,
    );
  }

  const unknownByProvider = new Map<string, number>();
  for (const r of rows) {
    if (hostCls.get(r) === "unknown") {
      unknownByProvider.set(r.provider, (unknownByProvider.get(r.provider) ?? 0) + 1);
    }
  }
  for (const [id, n] of [...unknownByProvider].sort(([a], [b]) => (a < b ? -1 : 1))) {
    warnings.push(
      `ledger rows reference provider "${id}", which is not in the current config — ` +
        `counted in the "unknown" split bucket (${n} row(s)); verified model list pricing still applies to its counterfactuals`,
    );
  }

  // --- per-project table + totals -------------------------------------------
  const byProject = new Map<string, UsageRecord[]>();
  for (const r of rows) {
    const list = byProject.get(r.project) ?? [];
    list.push(r);
    byProject.set(r.project, list);
  }

  const scopeSet = new Set(scopeRows);

  function projectRowOf(name: string, list: readonly UsageRecord[]): ProjectRow {
    const row = emptyProjectRow(name);
    let scopeActual = 0;
    let cfA = 0;
    let cfB = 0;
    let scoped = 0;
    for (const r of list) {
      row.requests++;
      row.input_tokens += r.input_tokens;
      row.output_tokens += r.output_tokens;
      row.actual_usd = round9(row.actual_usd + r.usd);
      if (scopeSet.has(r)) {
        scoped++;
        scopeActual = round9(scopeActual + r.usd);
        // scopeSet membership implies a verified price exists (see scope build)
        cfA = round9(cfA + rowCost(pricing.prices[r.model]!, r));
        cfB = round9(cfB + rowCost(pricing.baseline, r));
      }
    }
    if (scoped > 0) {
      row.cf_a_usd = cfA;
      row.cf_b_usd = cfB;
      row.savings_vs_baseline_usd = round9(cfB - scopeActual);
    }
    return row;
  }

  const projects = [...byProject.entries()]
    .sort(([a], [b]) => (a < b ? -1 : 1))
    .map(([name, list]) => projectRowOf(name, list));
  const totals = projectRowOf(project === "*" ? "TOTALS" : project, rows);

  // --- counterfactual block (global cf scope) --------------------------------
  let cfActual = 0;
  let cfA = 0;
  let cfB = 0;
  let planRequests = 0;
  let planValue = 0;
  for (const r of scopeRows) {
    cfActual = round9(cfActual + r.usd);
    cfA = round9(cfA + rowCost(pricing.prices[r.model]!, r));
    cfB = round9(cfB + rowCost(pricing.baseline, r));
    if (isPlan.get(r)) {
      planRequests++;
      planValue = round9(planValue + rowCost(pricing.prices[r.model]!, r));
    }
  }

  const plan_notice =
    planRequests > 0
      ? `Plan coverage detected: ${planRequests} in-scope request(s) ran on plan-covered providers ` +
        `(config pricing $0/$0, non-local host). Their actual $0 is plan coverage, not free — savings that ` +
        `include them are LIST-PRICE VALUE AVOIDED ($${planValue.toFixed(2)} of list-price tokens), not cash returned.`
      : null;

  // --- work delivered (ALL rows, local included) -----------------------------
  const split = { local: zeroBucket(), cloud: zeroBucket(), unknown: zeroBucket() };
  let outputTokens = 0;
  let streamMs = 0;
  let completed = 0;
  let fallbacks = 0;
  const rowsByProvider = new Map<string, UsageRecord[]>();
  for (const r of rows) {
    bucketOf(split[hostCls.get(r) ?? "unknown"], r);
    outputTokens += r.output_tokens;
    if (r.stream_ms != null && Number.isFinite(r.stream_ms) && r.stream_ms > 0) {
      streamMs += r.stream_ms;
    }
    if (r.incomplete !== true) completed++;
    if (r.fallback_used === true || r.attempts > 1) fallbacks++;
    const list = rowsByProvider.get(r.provider) ?? [];
    list.push(r);
    rowsByProvider.set(r.provider, list);
  }
  const ttfb_by_provider: ProviderTtfb[] = [...rowsByProvider.entries()]
    .sort(([a], [b]) => (a < b ? -1 : 1))
    .flatMap(([provider, list]) => {
      const perf = perfStatsOf(list);
      const samples = list.filter((r) => r.ttfb_ms != null && Number.isFinite(r.ttfb_ms)).length;
      // providers with zero ttfb-bearing rows are OMITTED entirely (same
      // omission philosophy as PerfStats: absent stat ≡ absent key/row)
      if (samples === 0 || !perf) return [];
      return [
        {
          provider,
          samples,
          ...(perf.ttfb_p50_ms !== undefined ? { ttfb_p50_ms: perf.ttfb_p50_ms } : {}),
          ...(perf.ttfb_p95_ms !== undefined ? { ttfb_p95_ms: perf.ttfb_p95_ms } : {}),
        } satisfies ProviderTtfb,
      ];
    });

  const work: WorkDelivered = {
    agent_turns: rows.length,
    output_tokens: outputTokens,
    stream_hours: round1(streamMs / 3_600_000),
    reliability_pct: rows.length > 0 ? round1((completed / rows.length) * 100) : null,
    completed_rows: completed,
    total_rows: rows.length,
    fallbacks_survived: fallbacks,
    split,
    ttfb_by_provider,
  };

  const counterfactual: Counterfactual = {
    scope_requests: scopeRows.length,
    excluded_local_requests: excludedLocal,
    excluded_unverified_requests: excludedUnverified,
    excluded_unverified_models: [...unverifiedByModel.keys()].sort(),
    actual_usd: cfActual,
    cf_a_usd: cfA,
    cf_b_usd: cfB,
    routing_cache_savings_usd: round9(cfB - cfA),
    total_savings_usd: round9(cfB - cfActual),
    plan_requests: planRequests,
    plan_value_avoided_usd: planValue,
    plan_notice,
  };

  // --- assumptions (every savings number carries these) ----------------------
  const b = pricing.baseline;
  const assumptions: string[] = [
    `Counterfactual scope: ${scopeRows.length} of ${rows.length} request(s) — rows with a verified list price for the served model. ` +
      `Excluded: ${excludedLocal} local-GPU row(s) (no cloud counterfactual exists) and ${excludedUnverified} row(s) on models without a verified list price.`,
    `Cache honesty: USD math prices ALL input tokens at the full input rate — cached_tokens are deliberately NOT credited any discount. ` +
      `Where a provider bills cached input cheaper (most do), every USD figure here is conservatively OVERestimated and cache savings UNDERstated.`,
    `Counterfactual A (no-cache): each in-scope row priced at its own model's list price with all input tokens at the full input rate — same routing, cache benefit removed.`,
    `Counterfactual B (all-cloud baseline): each in-scope row priced entirely at ${b.id} list rates ` +
      `($${b.input_per_mtok} in / $${b.output_per_mtok} out per Mtok; source: ${b.source}, as of ${b.asOf}, verified). ` +
      `Local rows are NOT re-priced into B — this is a like-for-like billing comparison, not a promise of what a no-GPU month would have cost.`,
    `Actual is the ledger usd column as metered at config pricing — not adjusted for subscription plans or cache discounts. ` +
      `Savings compare cfB against the ledger usd of the SAME in-scope rows only.`,
    ...(plan_notice ? [plan_notice] : []),
  ];

  return {
    month,
    project,
    total_rows: rows.length,
    projects,
    totals,
    daily: dailyBuckets(rows),
    work,
    counterfactual,
    baseline: b,
    assumptions,
    warnings,
  };
}
