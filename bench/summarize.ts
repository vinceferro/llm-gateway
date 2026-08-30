/**
 * bench/summarize.ts — aggregates A/B bench JSONL as written by bench/bench-ab.sh.
 *
 * Usage:
 *   node --disable-warning=ExperimentalWarning --experimental-strip-types \
 *     bench/summarize.ts <results.jsonl> [--md]
 *
 * JSON summary to stdout; `--md` emits a compact markdown table instead.
 * Malformed/error rows are skipped and counted, never crash.
 *
 * PAIRING CONTRACT — bench/bench-ab.sh appends gateway-then-direct per prompt
 * and the JSONL carries no prompt id, so pairing is ORDER-based within each
 * pass: the 2i-th row of a pass pairs with its (2i+1)-th row. Error rows keep
 * their ordinal (the harness writes one row per request even on failure), so a
 * failed side surfaces as an incomplete pair instead of shifting every later
 * pair. Rows that cannot pair (direct with no pending gateway, back-to-back
 * gateways, trailing gateway) are counted as unpaired. Pairing never crosses
 * passes.
 */

import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

export type Arm = "gateway" | "direct";

/** One bench row (schema of bench/bench-ab.sh output). */
export interface BenchRow {
  arm: Arm;
  kind: string;
  pass: number;
  latency_s?: number;
  /** usage.prompt_tokens — null when upstream sent no usage (timeout/error body) */
  in?: number | null;
  /** usage.completion_tokens — null when upstream sent no usage */
  out?: number | null;
  /** usage.prompt_tokens_details.cached_tokens — null when not reported */
  cached?: number | null;
  /** set by the harness when the request itself failed (no latency/usage) */
  error?: string;
}

export interface LatencyStats {
  n: number;
  /** seconds; null when n === 0 */
  median_s: number | null;
  /** seconds; p95 by linear interpolation between closest ranks (numpy default) */
  p95_s: number | null;
}

export interface ArmLatency extends LatencyStats {
  by_kind: Record<string, LatencyStats>;
}

export interface BenchSummary {
  /** rows that parsed and validated (malformed rows excluded, counted below) */
  total_rows: number;
  skipped_malformed: number;
  /** gateway/direct pairs formed by order within a pass */
  pairs: number;
  /** pairs where a side has an error row or no numeric latency */
  incomplete_pairs: number;
  /** rows that could not pair (order-based pairing leftovers) */
  unpaired_rows: number;
  token_drift: {
    /** pairs where BOTH sides report numeric usage on at least one metric */
    comparable_pairs: number;
    /** pairs with zero comparable metrics (one side has null usage) */
    excluded_pairs: number;
    /** comparable pairs where any metric differs */
    drifted_pairs: number;
    /** max absolute delta per metric across comparable pairs (0 if none) */
    max_delta: { in: number; out: number; cached: number };
  };
  latency: Record<Arm, ArmLatency>;
  /** (gw median − direct median) / direct median × 100; negative = gateway faster; null if either arm empty */
  median_delta_pct: number | null;
}

const ARMS: readonly Arm[] = ["gateway", "direct"];
const DRIFT_METRICS = ["in", "out", "cached"] as const;

const round4 = (x: number): number => Math.round(x * 1e4) / 1e4;
const round2 = (x: number): number => Math.round(x * 1e2) / 1e2;

function parseRows(text: string): { rows: BenchRow[]; malformed: number } {
  let malformed = 0;
  const rows: BenchRow[] = [];
  for (const raw of text.split("\n")) {
    const t = raw.trim();
    if (!t) continue; // blank line (e.g. trailing newline) — not a row, not malformed
    let j: unknown;
    try {
      j = JSON.parse(t);
    } catch {
      malformed++;
      continue;
    }
    if (typeof j !== "object" || j === null) {
      malformed++;
      continue;
    }
    const o = j as Record<string, unknown>;
    const arm = o.arm;
    if (
      (arm !== "gateway" && arm !== "direct") ||
      typeof o.kind !== "string" ||
      typeof o.pass !== "number" ||
      !Number.isInteger(o.pass)
    ) {
      malformed++;
      continue;
    }
    const num = (v: unknown): number | null =>
      typeof v === "number" && Number.isFinite(v) ? v : null;
    rows.push({
      arm,
      kind: o.kind,
      pass: o.pass,
      latency_s: num(o.latency_s) ?? undefined,
      in: num(o.in),
      out: num(o.out),
      cached: num(o.cached),
      error: typeof o.error === "string" ? o.error : undefined,
    });
  }
  return { rows, malformed };
}

interface Pair {
  gateway: BenchRow;
  direct: BenchRow;
}

/** See PAIRING CONTRACT above. Map iteration order = first-appearance order of passes in the file. */
function pairRows(rows: BenchRow[]): { pairs: Pair[]; unpaired: number } {
  const byPass = new Map<number, BenchRow[]>();
  for (const r of rows) {
    const list = byPass.get(r.pass);
    if (list) list.push(r);
    else byPass.set(r.pass, [r]);
  }
  const pairs: Pair[] = [];
  let unpaired = 0;
  for (const [, list] of byPass) {
    let pending: BenchRow | undefined;
    for (const r of list) {
      if (r.arm === "gateway") {
        if (pending) unpaired++; // back-to-back gateways: the earlier one is orphaned
        pending = r;
      } else {
        if (pending) {
          pairs.push({ gateway: pending, direct: r });
          pending = undefined;
        } else {
          unpaired++; // direct with no pending gateway
        }
      }
    }
    if (pending) unpaired++; // trailing gateway
  }
  return { pairs, unpaired };
}

function percentile(sorted: number[], p: number): number {
  const idx = (p / 100) * (sorted.length - 1);
  const lo = Math.floor(idx);
  const hi = Math.ceil(idx);
  if (lo === hi) return sorted[lo]!;
  return sorted[lo]! + (idx - lo) * (sorted[hi]! - sorted[lo]!);
}

/** Median (p50) and p95 by linear interpolation between closest ranks. */
function stats(values: number[]): LatencyStats {
  const n = values.length;
  if (n === 0) return { n: 0, median_s: null, p95_s: null };
  const sorted = [...values].sort((a, b) => a - b);
  return { n, median_s: round4(percentile(sorted, 50)), p95_s: round4(percentile(sorted, 95)) };
}

/** Latency aggregates for one arm over ALL its latency-bearing rows (not per pair). */
function armLatency(rows: BenchRow[], arm: Arm): ArmLatency {
  const mine = rows.filter((r) => r.arm === arm);
  const withLat = mine.filter((r) => typeof r.latency_s === "number").map((r) => r.latency_s as number);
  const by_kind: Record<string, LatencyStats> = {};
  for (const k of new Set(mine.map((r) => r.kind))) {
    by_kind[k] = stats(
      mine.filter((r) => r.kind === k && typeof r.latency_s === "number").map((r) => r.latency_s as number),
    );
  }
  return { ...stats(withLat), by_kind };
}

function driftOf(pairs: Pair[]): BenchSummary["token_drift"] {
  let comparable = 0;
  let excluded = 0;
  let drifted = 0;
  const max: { in: number; out: number; cached: number } = { in: 0, out: 0, cached: 0 };
  for (const { gateway: g, direct: d } of pairs) {
    let anyComparable = false;
    let pairDrifted = false;
    for (const k of DRIFT_METRICS) {
      const a = g[k];
      const b = d[k];
      if (typeof a !== "number" || typeof b !== "number") continue; // metric not comparable this pair
      anyComparable = true;
      const delta = Math.abs(a - b);
      if (delta > max[k]) max[k] = delta;
      if (delta > 0) pairDrifted = true;
    }
    if (anyComparable) {
      comparable++;
      if (pairDrifted) drifted++;
    } else {
      excluded++;
    }
  }
  return { comparable_pairs: comparable, excluded_pairs: excluded, drifted_pairs: drifted, max_delta: max };
}

export function summarize(text: string): BenchSummary {
  const { rows, malformed } = parseRows(text);
  const { pairs, unpaired } = pairRows(rows);
  const latencyOk = (r: BenchRow): boolean => !r.error && typeof r.latency_s === "number";
  let incomplete = 0;
  for (const p of pairs) {
    if (!latencyOk(p.gateway) || !latencyOk(p.direct)) incomplete++;
  }
  const latency: Record<Arm, ArmLatency> = {
    gateway: armLatency(rows, "gateway"),
    direct: armLatency(rows, "direct"),
  };
  const gm = latency.gateway.median_s;
  const dm = latency.direct.median_s;
  const median_delta_pct =
    gm !== null && dm !== null && dm !== 0 ? round2(((gm - dm) / dm) * 100) : null;
  return {
    total_rows: rows.length,
    skipped_malformed: malformed,
    pairs: pairs.length,
    incomplete_pairs: incomplete,
    unpaired_rows: unpaired,
    token_drift: driftOf(pairs),
    latency,
    median_delta_pct,
  };
}

const fmt = (v: number | null): string => (v === null ? "—" : v.toFixed(2));

export function renderMarkdown(s: BenchSummary): string {
  const lines: string[] = [];
  lines.push("| metric | gateway | direct |", "|---|---:|---:|");
  lines.push(`| n | ${s.latency.gateway.n} | ${s.latency.direct.n} |`);
  lines.push(`| median_s | ${fmt(s.latency.gateway.median_s)} | ${fmt(s.latency.direct.median_s)} |`);
  lines.push(`| p95_s | ${fmt(s.latency.gateway.p95_s)} | ${fmt(s.latency.direct.p95_s)} |`, "");
  lines.push(
    `median delta: ${s.median_delta_pct === null ? "n/a" : `${s.median_delta_pct.toFixed(1)}%`}`,
    "(gateway − direct, % of direct median; negative = gateway faster)",
    "",
  );
  const kinds = [
    ...new Set([...Object.keys(s.latency.gateway.by_kind), ...Object.keys(s.latency.direct.by_kind)]),
  ].sort();
  lines.push(
    "| kind | gw n | gw median_s | gw p95_s | dir n | dir median_s | dir p95_s |",
    "|---|---:|---:|---:|---:|---:|---:|",
  );
  for (const k of kinds) {
    const g = s.latency.gateway.by_kind[k];
    const d = s.latency.direct.by_kind[k];
    lines.push(
      `| ${k} | ${g?.n ?? 0} | ${fmt(g?.median_s ?? null)} | ${fmt(g?.p95_s ?? null)} | ${d?.n ?? 0} | ${fmt(d?.median_s ?? null)} | ${fmt(d?.p95_s ?? null)} |`,
    );
  }
  lines.push("");
  const t = s.token_drift;
  lines.push(
    `token drift: comparable ${t.comparable_pairs}/${s.pairs} pairs (${t.excluded_pairs} excluded: no usage on one side) · drifted ${t.drifted_pairs} · max delta in=${t.max_delta.in} out=${t.max_delta.out} cached=${t.max_delta.cached}`,
  );
  lines.push(
    `skipped: ${s.skipped_malformed} malformed rows · ${s.unpaired_rows} unpaired rows · ${s.incomplete_pairs} incomplete pairs`,
  );
  return lines.join("\n") + "\n";
}

function main(argv: string[]): number {
  const md = argv.includes("--md");
  const file = argv.find((a) => a !== "--md");
  if (!file) {
    console.error("usage: bench/summarize.ts <results.jsonl> [--md]");
    console.error("  reads a bench-ab.sh results JSONL; JSON summary to stdout, --md for markdown");
    return 2;
  }
  let text: string;
  try {
    text = readFileSync(file, "utf8");
  } catch (e) {
    console.error(`summarize: cannot read ${file}: ${(e as Error).message}`);
    return 1;
  }
  process.stdout.write(md ? renderMarkdown(summarize(text)) : JSON.stringify(summarize(text), null, 2) + "\n");
  return 0;
}

/* CLI entry only when run directly (tests import the pure functions). */
if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  process.exit(main(process.argv.slice(2)));
}
