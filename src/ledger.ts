/**
 * Append-only JSONL usage ledger (~/.llm-gateway/usage.jsonl by default).
 * One line per completed request. Corrupt/teared lines are skipped on read.
 */

import { appendFileSync, closeSync, existsSync, fstatSync, mkdirSync, openSync, readFileSync, readSync } from "node:fs";
import { join } from "node:path";
import type { Pricing } from "./config.ts";

export const LEDGER_FILE = "usage.jsonl";

export interface UsageRecord {
  ts: string; // ISO timestamp
  project: string;
  provider: string;
  model: string; // upstream model_id actually served
  task_class: string;
  input_tokens: number;
  output_tokens: number;
  usd: number;
  latency_ms: number;
  stream: boolean;
  fallback_used: boolean;
  attempts: number; // total upstream attempts across the chain
  /** true when token counts were char-estimated because upstream sent no usage */
  estimated?: boolean;
  /** true when the stream ended abnormally (mid-stream failure or client disconnect) */
  incomplete?: boolean;
  /** ms from gateway request start to the FIRST upstream byte. Absent on rows written before telemetry existed (and on pre-first-byte failures). */
  ttfb_ms?: number;
  /** streaming only: stream generation window = last upstream byte time − first upstream byte time. ABSENT (not null/0) on non-streamed rows. */
  stream_ms?: number;
  /** Prompt tokens served from the provider's prompt cache (OpenAI-compatible
   *  usage.prompt_tokens_details.cached_tokens — e.g. Z.ai/GLM when caching
   *  engages; llama.cpp typically absent). ABSENT when upstream didn't report
   *  it: cached input is materially cheaper, so it is never estimated. */
  cached_tokens?: number;
}

export function round9(n: number): number {
  return Math.round(n * 1e9) / 1e9;
}

/** USD for a call: (in * price_in + out * price_out) / 1e6, rounded to 1e-9 (nano-dollar precision — keeps sub-micro costs exact, kills float dust). */
export function computeCost(pricing: Pricing, inputTokens: number, outputTokens: number): number {
  return round9(
    (inputTokens * pricing.input_per_mtok + outputTokens * pricing.output_per_mtok) / 1e6,
  );
}

export function ledgerPath(storageDir: string): string {
  return join(storageDir, LEDGER_FILE);
}

/**
 * A crash mid-append can leave the ledger's final line torn: partial JSON with
 * the trailing newline never flushed. Appending blindly onto that file would
 * merge the new record INTO the torn line, so readers (which skip corrupt
 * lines) would silently drop the new record. This repairs the file by
 * appending a bare "\n" when the last byte isn't one — the torn tail stays on
 * its own line (still skipped as corrupt) and the new record lands intact.
 * Tail check reads exactly 1 byte: the ledger is appended on every finalize,
 * so a whole-file read here would be O(ledger) per request.
 *
 * The probe is BEST-EFFORT and fails open: any error reading the tail
 * (write-only file perms, ENOENT races, …) skips the repair and falls back
 * to the plain append — the exact pre-probe behavior. appendRecord runs on
 * the finalize path outside handle()'s try/catch (stream event handlers in
 * src/server.ts), so a sync throw here would kill the process; the repair
 * must never become a new throw source.
 */
function ensureTrailingNewline(p: string): void {
  let torn = false;
  try {
    let fd: number | undefined;
    try {
      fd = openSync(p, "r");
      const size = fstatSync(fd).size;
      if (size > 0) {
        const buf = Buffer.alloc(1);
        readSync(fd, buf, 0, 1, size - 1);
        torn = buf[0] !== 0x0a; // \n
      }
    } finally {
      if (fd !== undefined) closeSync(fd);
    }
  } catch {
    torn = false; // probe unreadable → skip repair, attempt the append as before
  }
  if (torn) appendFileSync(p, "\n", "utf8");
}

export function appendRecord(storageDir: string, rec: UsageRecord): void {
  mkdirSync(storageDir, { recursive: true });
  const p = ledgerPath(storageDir);
  if (existsSync(p)) ensureTrailingNewline(p);
  appendFileSync(p, JSON.stringify(rec) + "\n", "utf8");
}

export function readRecords(storageDir: string): UsageRecord[] {
  const p = ledgerPath(storageDir);
  if (!existsSync(p)) return [];
  const out: UsageRecord[] = [];
  for (const line of readFileSync(p, "utf8").split("\n")) {
    if (line.trim() === "") continue;
    try {
      out.push(JSON.parse(line) as UsageRecord);
    } catch {
      /* torn write — skip */
    }
  }
  return out;
}

export interface LedgerFilter {
  project?: string;
  /** YYYY-MM matched against ts prefix */
  month?: string;
}

export function filterRecords(records: UsageRecord[], f: LedgerFilter): UsageRecord[] {
  return records.filter(
    (r) =>
      (f.project ? r.project === f.project : true) &&
      (f.month ? r.ts.slice(0, 7) === f.month : true),
  );
}

export interface GroupTotals {
  project: string;
  provider: string;
  model: string;
  requests: number;
  input_tokens: number;
  output_tokens: number;
  usd: number;
  /** derived on read from this group's rows; never stored. Present iff the group has ≥1 row (groups always do). */
  perf: PerfStats;
  /** present iff ≥1 row in the group carries a valid cached_tokens; omitted otherwise (additive-only contract). */
  cache?: CacheStats;
}

/**
 * Performance stats derived on READ — nothing here is persisted per-row.
 *
 * Percentile definition: LINEAR INTERPOLATION between closest ranks (the
 * "inclusive" method, aka Excel PERCENTILE.INC / numpy 'linear' default):
 * for sorted samples s[0..n-1], rank = p·(n−1); the result interpolates
 * between s[floor(rank)] and s[ceil(rank)]. Chosen over nearest-rank because
 * it is continuous in p, keeps p50 equal to the ordinary median for even
 * counts, and matches the default of common analysis tooling. Edge cases:
 * single sample → that sample; empty → undefined (caller omits the stat).
 *
 * Omission rules: rows without ttfb_ms are excluded from ttfb stats but still
 * count for latency stats (every row carries latency_ms); only streamed rows
 * with stream_ms > 0 qualify for tok_per_s_avg. Absent stats OMIT the key
 * entirely (never null) so old readers and deep-equality stay honest.
 * Foreign/torn rows (hand-written JSONL) may carry null instead of absent
 * fields: null is treated exactly like absent everywhere below, and a row
 * without a finite latency_ms is excluded from latency stats rather than
 * poisoning them with NaN.
 */
export interface PerfStats {
  latency_p50_ms: number;
  latency_p95_ms: number;
  latency_avg_ms: number;
  /** mean ttfb_ms over rows that carry one; key absent when none do */
  ttfb_avg_ms?: number;
  /** ttfb p50/p95 over the SAME rows as ttfb_avg_ms, same linear-interpolation
   *  percentile as latency (see above); keys absent alongside ttfb_avg_ms */
  ttfb_p50_ms?: number;
  ttfb_p95_ms?: number;
  /** mean of output_tokens / (stream_ms/1000) over streamed rows with stream_ms > 0; key absent when none qualify */
  tok_per_s_avg?: number;
}

/** Derived perf values are rounded to 3 decimals (sub-ms) to keep float dust out of the admin JSON. */
function r3(n: number): number {
  return Math.round(n * 1000) / 1000;
}

export function percentile(sortedAsc: readonly number[], p: number): number | undefined {
  if (sortedAsc.length === 0) return undefined;
  const rank = (sortedAsc.length - 1) * p;
  const lo = Math.floor(rank);
  const hi = Math.ceil(rank);
  if (lo === hi) return sortedAsc[lo]!;
  return sortedAsc[lo]! + (sortedAsc[hi]! - sortedAsc[lo]!) * (rank - lo);
}

/** Perf over a row set; undefined when the set is empty (caller omits the object). */
export function perfStatsOf(rows: readonly UsageRecord[]): PerfStats | undefined {
  if (rows.length === 0) return undefined;
  // Number.isFinite guard: a parseable-but-incomplete foreign row (missing or
  // null latency_ms) is excluded instead of turning percentiles/avg into NaN.
  const latencies = rows
    .map((r) => r.latency_ms)
    .filter((n) => Number.isFinite(n))
    .sort((a, b) => a - b);
  if (latencies.length === 0) return undefined;
  const perf: PerfStats = {
    latency_p50_ms: r3(percentile(latencies, 0.5)!),
    latency_p95_ms: r3(percentile(latencies, 0.95)!),
    latency_avg_ms: r3(latencies.reduce((acc, n) => acc + n, 0) / latencies.length),
  };
  // `== null` (not `=== undefined`): foreign/hand-written rows carry null, and
  // JSON cannot express undefined — a null ttfb must be omitted, never a 0ms sample.
  const ttfbs = rows.flatMap((r) => (r.ttfb_ms == null ? [] : [r.ttfb_ms]));
  if (ttfbs.length > 0) {
    perf.ttfb_avg_ms = r3(ttfbs.reduce((acc, n) => acc + n, 0) / ttfbs.length);
    const sortedTtfb = [...ttfbs].sort((a, b) => a - b);
    perf.ttfb_p50_ms = r3(percentile(sortedTtfb, 0.5)!);
    perf.ttfb_p95_ms = r3(percentile(sortedTtfb, 0.95)!);
  }
  // computed on read, never stored as a tps field: mean of PER-ROW tok/s ratios
  const tokPerS = rows.flatMap((r) =>
    r.stream === true && r.stream_ms !== undefined && r.stream_ms > 0
      ? [r.output_tokens / (r.stream_ms / 1000)]
      : [],
  );
  if (tokPerS.length > 0) {
    perf.tok_per_s_avg = r3(tokPerS.reduce((acc, n) => acc + n, 0) / tokPerS.length);
  }
  return perf;
}

/**
 * Cache stats derived on READ — nothing here is persisted per-row. Present
 * ONLY when at least one row in scope carries a usable cached_tokens:
 * all-uncached ledgers and old-format rows keep the object omitted entirely
 * (never zero-filled) so existing readers see the exact legacy shape.
 */
export interface CacheStats {
  /** sum of cached_tokens over rows in scope that carry a valid one */
  cached_tokens: number;
  /** cached_tokens / input_tokens over ALL rows in scope (3 decimals); 0 when total input is 0 */
  cached_share: number;
}

/**
 * `== null` (not `=== undefined`) + Number.isFinite + >= 0: foreign/hand-written
 * rows may carry null or garbage — such rows count as NOT carrying the field
 * (they still count in the share denominator via input_tokens). A reported 0
 * IS carried: the provider said caching details with zero hits.
 *
 * POST-SUM finiteness: the per-row guard cannot save the AGGREGATE — two
 * finite-but-huge values (e.g. 1e308) sum to Infinity, and r3's *1000 rounding
 * overflows to Infinity for share quotients above ~1.8e305. JSON.stringify
 * renders either as null INSIDE a present object, which is a dishonest
 * contract — so an unrepresentable sum or share omits the whole `cache`
 * object, exactly like the absent-stat omission rules above.
 */
function cacheStatsOf(rows: readonly UsageRecord[]): CacheStats | undefined {
  let cachedTokens = 0;
  let carried = false;
  for (const r of rows) {
    const c = r.cached_tokens;
    if (c == null || !Number.isFinite(c) || c < 0) continue;
    carried = true;
    cachedTokens += c;
  }
  if (!carried) return undefined;
  if (!Number.isFinite(cachedTokens)) return undefined; // 1e308 + 1e308 -> Infinity
  let inputTokens = 0;
  for (const r of rows) {
    if (Number.isFinite(r.input_tokens)) inputTokens += r.input_tokens;
  }
  const share = inputTokens > 0 ? r3(cachedTokens / inputTokens) : 0;
  if (!Number.isFinite(share)) return undefined; // r3(quotient > ~1.8e305) -> Infinity
  return { cached_tokens: cachedTokens, cached_share: share };
}

export interface LedgerSummary {
  totals: {
    requests: number;
    input_tokens: number;
    output_tokens: number;
    usd: number;
    /** present iff requests > 0 */
    perf?: PerfStats;
    /** present iff ≥1 row in scope carries a valid cached_tokens */
    cache?: CacheStats;
  };
  groups: GroupTotals[];
}

export function summarizeLedger(storageDir: string, f: LedgerFilter): LedgerSummary {
  const rows = filterRecords(readRecords(storageDir), f);
  const groups = new Map<string, { totals: Omit<GroupTotals, "perf">; rows: UsageRecord[] }>();
  let requests = 0;
  let inputTokens = 0;
  let outputTokens = 0;
  let usd = 0;
  for (const r of rows) {
    requests++;
    inputTokens += r.input_tokens;
    outputTokens += r.output_tokens;
    usd += r.usd;
    const k = `${r.project}|${r.provider}|${r.model}`;
    const g =
      groups.get(k) ??
      {
        totals: {
          project: r.project,
          provider: r.provider,
          model: r.model,
          requests: 0,
          input_tokens: 0,
          output_tokens: 0,
          usd: 0,
        },
        rows: [] as UsageRecord[],
      };
    g.totals.requests++;
    g.totals.input_tokens += r.input_tokens;
    g.totals.output_tokens += r.output_tokens;
    g.totals.usd = round9(g.totals.usd + r.usd);
    g.rows.push(r);
    groups.set(k, g);
  }
  const totalsPerf = perfStatsOf(rows);
  const totalsCache = cacheStatsOf(rows);
  return {
    totals: {
      requests,
      input_tokens: inputTokens,
      output_tokens: outputTokens,
      usd: round9(usd),
      ...(totalsPerf ? { perf: totalsPerf } : {}),
      ...(totalsCache ? { cache: totalsCache } : {}),
    },
    groups: [...groups.values()].map((g) => {
      const cache = cacheStatsOf(g.rows);
      return {
        ...g.totals,
        perf: perfStatsOf(g.rows)!,
        ...(cache ? { cache } : {}),
      };
    }),
  };
}

/** Month-to-date USD spend for a project (for the hard budget gate). */
export function monthSpend(storageDir: string, project: string, month: string): number {
  return round9(
    filterRecords(readRecords(storageDir), { project, month }).reduce((acc, r) => acc + r.usd, 0),
  );
}
