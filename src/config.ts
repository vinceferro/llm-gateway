/**
 * Config loading + validation.
 *
 * Config format: **JSON** (chosen over YAML to keep runtime deps at zero — Node's
 * stdlib parses it natively). See `config.example.json` for a documented example.
 *
 * Secrets rules enforced here:
 *  - provider API keys NEVER live in config; only the *name* of an env var (`api_key_env`)
 *  - gateway keys / admin key may be stored as `sha256:<hex>` (preferred) or plaintext
 *    (startup warns). Generate hashes with `npm run hash-key -- <secret>`.
 */

import { existsSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { resolveReportPricing } from "./prices.ts";

export interface Pricing {
  input_per_mtok: number;
  output_per_mtok: number;
}

/** One peak window: "HH:MM"-"HH:MM" UTC on the given UTC weekdays. */
export interface PeakWindow {
  /** UTC weekdays (0=Sun..6=Sat) this window applies to. */
  days: number[];
  /** Inclusive window start, "HH:MM" UTC. */
  start: string;
  /** Exclusive window end, "HH:MM" UTC. Windows never cross midnight (start < end enforced). */
  end: string;
}

/**
 * A provider's peak schedule. OFF-PEAK = outside ALL listed peak windows;
 * UTC weekdays absent from every window's `days` are ALL-DAY off-peak — that
 * is how "weekends all off-peak" (e.g. DeepSeek) is encoded: simply do not
 * list Sat/Sun in any window's days. See `isOffPeak` in router.ts for the
 * predicate. Window bounds are minute-resolution, half-open [start, end).
 */
export interface OffPeakSchedule {
  peak_utc: PeakWindow[];
}

/**
 * Declared provider capabilities — all optional. ABSENT = claims nothing
 * (never overclaim): /v1/models advertises the resolved set with false for
 * unclaimed, and vision-gated routing consults only `vision`.
 */
export interface ProviderCapabilities {
  vision?: boolean;
  tools?: boolean;
  reasoning?: boolean;
}

/** Resolved capability set — the one source of truth shared by router + /v1/models. */
export interface ResolvedCapabilities {
  vision: boolean;
  tools: boolean;
  reasoning: boolean;
}

export interface ProviderConfig {
  /** "openai" (default) = OpenAI-compatible HTTP upstream; "mock" = in-process fake. */
  type?: "openai" | "mock";
  base_url?: string;
  /** Name of the environment variable holding the provider API key. Optional for keyless upstreams (e.g. Ollama). */
  api_key_env?: string;
  model_id: string;
  pricing: Pricing;
  task_classes: string[];
  /** When streaming upstream, inject `stream_options:{include_usage:true}` if client didn't set it (default true). Turn off for upstreams that reject unknown fields. */
  stream_include_usage?: boolean;
  /** Optional peak-window schedule enabling off-peak chain selection for classes that name this provider in an off_peak_chain. */
  off_peak?: OffPeakSchedule;
  /** Capabilities this provider is CLAIMED to have; absent/empty claims nothing. See providerCapabilities(). */
  capabilities?: ProviderCapabilities;
}

/**
 * The resolved capability set for one provider entry: true only when the
 * config explicitly claims it. Absent capabilities (or absent provider —
 * defensive) resolve to all-false. Used by vision-gated routing AND the
 * /v1/models advertisement, so they can never disagree.
 */
export function providerCapabilities(p?: ProviderConfig): ResolvedCapabilities {
  const c = p?.capabilities;
  return {
    vision: c?.vision === true,
    tools: c?.tools === true,
    reasoning: c?.reasoning === true,
  };
}

/**
 * routing.<class> entry. Plain `string[]` = the chain, always (original form).
 * Object form adds an `off_peak_chain` used during off-peak hours — see
 * router.ts for the exact selection rule. Both forms parse identically for
 * everything that only declares `chain`.
 */
export interface RoutingClassConfig {
  chain: string[];
  /** Candidate chain during off-peak windows; consulted only when at least one provider in it declares an off_peak schedule. */
  off_peak_chain?: string[];
}
export type RoutingChain = string[] | RoutingClassConfig;

export interface KeyConfig {
  project: string;
  /** Task classes this key may use. Omitted/empty = all allowed. */
  allowed_task_classes?: string[];
  /** Seed for sticky routing before any observed success. */
  sticky_provider_hint?: string;
}

/** project -> monthly hard budget. When month-to-date spend >= cap, requests get HTTP 402. Missing entry = unlimited. */
export interface BudgetConfig {
  monthly_usd_cap: number;
}

/** Inline counterfactual baseline: reference rates instead of a price-table id. */
export interface ReportBaselineRef {
  /** Display label for the receipt (defaults to "inline baseline"). */
  model?: string;
  input_per_mtok: number;
  output_per_mtok: number;
}

/** Operator-verified price for a model — an attestation, stored with provenance. */
export interface ReportPriceOverride {
  input_per_mtok: number;
  output_per_mtok: number;
  /** provenance for the receipt; defaults to "operator: llm-gateway.json report.prices" */
  source?: string;
  /** when the operator verified it; defaults to "operator-configured" */
  as_of?: string;
}

/**
 * Optional `report` section: shapes the `gateway report` counterfactuals.
 * Strictly validated: unknown fields rejected; a baseline id must resolve to
 * a VERIFIED price entry (see src/prices.ts — unverified placeholders can
 * never silently anchor savings math).
 */
export interface ReportConfig {
  /** Counterfactual B reference provider: price-table id or inline rates. Default: deepseek-v4-flash. */
  baseline?: string | ReportBaselineRef;
  /** Operator-verified replacements/additions for the list-price table. */
  prices?: Record<string, ReportPriceOverride>;
}

export interface GatewayConfig {
  port: number;
  host: string;
  storage_dir: string;
  admin_key?: string;
  connect_timeout_ms: number;
  /**
   * Per-attempt deadline for NON-streaming upstream requests. A non-stream
   * upstream sends headers+body together at completion, so a long generation
   * would blow the (stream-oriented) connect window on a healthy reply.
   * Streaming requests always use connect_timeout_ms.
   */
  nonstream_timeout_ms?: number;
  max_retries_per_provider: number;
  retry_backoff_base_ms: number;
  body_limit_mb: number;
  providers: Record<string, ProviderConfig>;
  keys: Record<string, KeyConfig>;
  /** task class -> provider chain (plain array, or { chain, off_peak_chain }). Must include "default". */
  routing: Record<string, RoutingChain>;
  budgets: Record<string, BudgetConfig>;
  /** optional `gateway report` shaping (baseline + price overrides); strictly validated */
  report?: ReportConfig;
}

export class ConfigError extends Error {}

const DEFAULT_PORT = 8090;
const DEFAULT_HOST = "127.0.0.1";
export const DEFAULT_CONNECT_TIMEOUT_MS = 10_000;
/** Default window for non-streaming upstream requests (see GatewayConfig.nonstream_timeout_ms). */
export const DEFAULT_NONSTREAM_TIMEOUT_MS = 120_000;
const DEFAULT_MAX_RETRIES = 2;
const DEFAULT_BACKOFF_BASE_MS = 200;
const DEFAULT_BODY_LIMIT_MB = 10;

function expandTilde(p: string): string {
  if (p === "~") return homedir();
  if (p.startsWith("~/")) return join(homedir(), p.slice(2));
  return p;
}

export function defaultStorageDir(): string {
  return process.env.LLM_GATEWAY_HOME ?? expandTilde("~/.llm-gateway");
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function isPricing(v: unknown): v is Pricing {
  return (
    isPlainObject(v) &&
    typeof v.input_per_mtok === "number" &&
    Number.isFinite(v.input_per_mtok) &&
    typeof v.output_per_mtok === "number" &&
    Number.isFinite(v.output_per_mtok)
  );
}

const HHMM_RE = /^([01]\d|2[0-3]):([0-5]\d)$/;

/** "HH:MM" -> minutes-of-day, or null when malformed. */
function hhmmMinutes(v: unknown): number | null {
  if (typeof v !== "string") return null;
  const m = HHMM_RE.exec(v);
  if (!m) return null;
  return Number(m[1]) * 60 + Number(m[2]);
}

/** Strict off_peak schedule validation; issues reported via bad() (no values echoed — none are secret, but keep messages uniform). */
function validateOffPeak(v: unknown, bad: (msg: string) => void): void {
  if (!isPlainObject(v)) {
    bad(`off_peak: expected { peak_utc: [ { days, start, end }, ... ] }`);
    return;
  }
  for (const f of Object.keys(v)) {
    if (f !== "peak_utc") bad(`off_peak: unknown field "${f}" (only peak_utc is supported)`);
  }
  const windows = v.peak_utc;
  if (!Array.isArray(windows) || windows.length === 0) {
    bad(`off_peak.peak_utc: required non-empty array of { days, start, end } windows`);
    return;
  }
  windows.forEach((w, i) => {
    if (!isPlainObject(w)) {
      bad(`off_peak.peak_utc[${i}]: expected object { days, start, end }`);
      return;
    }
    for (const f of Object.keys(w)) {
      if (f !== "days" && f !== "start" && f !== "end") bad(`off_peak.peak_utc[${i}]: unknown field "${f}"`);
    }
    const days = w.days;
    if (!Array.isArray(days) || days.length === 0 || !days.every((d) => Number.isInteger(d) && d >= 0 && d <= 6)) {
      bad(`off_peak.peak_utc[${i}].days: required non-empty array of UTC weekdays 0-6 (0=Sun..6=Sat)`);
    }
    const start = hhmmMinutes(w.start);
    const end = hhmmMinutes(w.end);
    if (start === null) bad(`off_peak.peak_utc[${i}].start: expected "HH:MM" (00:00-23:59) UTC`);
    if (end === null) bad(`off_peak.peak_utc[${i}].end: expected "HH:MM" (00:00-23:59) UTC`);
    if (start !== null && end !== null && start >= end) {
      bad(
        `off_peak.peak_utc[${i}]: window must satisfy start < end — windows never cross midnight; ` +
          `minutes outside every window are off-peak by definition`,
      );
    }
  });
}

/** The only fields allowed on a provider object. Anything else is rejected. */
const KNOWN_PROVIDER_FIELDS: ReadonlySet<string> = new Set([
  "type",
  "base_url",
  "api_key_env",
  "model_id",
  "pricing",
  "task_classes",
  "stream_include_usage",
  "off_peak",
  "capabilities",
]);

/** The only fields allowed inside a provider's capabilities block. */
const KNOWN_CAPABILITY_FIELDS: ReadonlySet<string> = new Set(["vision", "tools", "reasoning"]);

/** Strict capabilities validation; issues reported via bad() in the uniform style (field NAMES echoed, never secrets — none here are). */
function validateCapabilities(v: unknown, bad: (msg: string) => void): void {
  if (!isPlainObject(v)) {
    bad(`capabilities: expected object { vision?, tools?, reasoning? } (all optional booleans)`);
    return;
  }
  for (const f of Object.keys(v)) {
    if (!KNOWN_CAPABILITY_FIELDS.has(f)) {
      bad(`capabilities: unknown field "${f}" (only vision, tools, reasoning are supported)`);
      continue;
    }
    const val = (v as Record<string, unknown>)[f];
    if (typeof val !== "boolean") {
      bad(`capabilities.${f}: expected boolean, got ${JSON.stringify(val)}`);
    }
  }
}

/** Fields that look like someone tried to inline a provider secret. */
const KEY_FIELD_HINTS: Readonly<Record<string, string>> = {
  api_key: "api_key_env",
  "api-key": "api_key_env",
  api_key_literal: "api_key_env",
  token: "api_key_env",
  key: "api_key_env",
  secret: "api_key_env",
};

/**
 * Strict env-var NAME shape. Lowercase is deliberately allowed (POSIX env
 * names may be lowercase); anything with `-`, spaces, digits-first, or other
 * punctuation fails — which is exactly where pasted key material (`sk-…`,
 * JWT dots, `=` in `key=…`) lands. The offending VALUE is never echoed: if it
 * is a real key, the error surface must not leak it.
 */
const ENV_VAR_NAME_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;

/** Parse + validate. Throws ConfigError listing every problem found (not just the first). */
export function loadConfig(path: string): GatewayConfig {
  if (!existsSync(path)) throw new ConfigError(`config file not found: ${path}`);
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(path, "utf8"));
  } catch (e) {
    throw new ConfigError(`config file ${path} is not valid JSON: ${(e as Error).message}`);
  }
  if (!isPlainObject(raw)) throw new ConfigError("config root must be a JSON object");

  const issues: string[] = [];
  const cfg = raw as Partial<GatewayConfig> & Record<string, unknown>;

  const out: GatewayConfig = {
    port: DEFAULT_PORT,
    host: DEFAULT_HOST,
    storage_dir: defaultStorageDir(),
    connect_timeout_ms: DEFAULT_CONNECT_TIMEOUT_MS,
    max_retries_per_provider: DEFAULT_MAX_RETRIES,
    retry_backoff_base_ms: DEFAULT_BACKOFF_BASE_MS,
    body_limit_mb: DEFAULT_BODY_LIMIT_MB,
    providers: {},
    keys: {},
    routing: {},
    budgets: {},
  };

  if (cfg.port !== undefined) {
    if (!Number.isInteger(cfg.port) || cfg.port < 1 || cfg.port > 65535) issues.push(`port: expected integer 1-65535, got ${JSON.stringify(cfg.port)}`);
    else out.port = cfg.port;
  }
  if (cfg.host !== undefined) {
    if (typeof cfg.host !== "string") issues.push("host: expected string");
    else out.host = cfg.host;
  }
  if (cfg.storage_dir !== undefined) {
    if (typeof cfg.storage_dir !== "string") issues.push("storage_dir: expected string");
    else out.storage_dir = expandTilde(cfg.storage_dir);
  }
  if (cfg.admin_key !== undefined) {
    if (typeof cfg.admin_key !== "string" || cfg.admin_key.length === 0) issues.push("admin_key: expected non-empty string");
    else out.admin_key = cfg.admin_key.trim();
  }

  const num = (v: unknown, name: string, dflt: number): number => {
    if (v === undefined) return dflt;
    if (typeof v !== "number" || !Number.isFinite(v) || v < 0) {
      issues.push(`${name}: expected non-negative number, got ${JSON.stringify(v)}`);
      return dflt;
    }
    return v;
  };
  out.connect_timeout_ms = num(cfg.connect_timeout_ms, "connect_timeout_ms", out.connect_timeout_ms);
  if (cfg.nonstream_timeout_ms !== undefined) {
    if (!Number.isInteger(cfg.nonstream_timeout_ms) || cfg.nonstream_timeout_ms < 1) {
      issues.push(`nonstream_timeout_ms: expected positive integer, got ${JSON.stringify(cfg.nonstream_timeout_ms)}`);
    } else {
      out.nonstream_timeout_ms = cfg.nonstream_timeout_ms;
    }
  }
  out.retry_backoff_base_ms = num(cfg.retry_backoff_base_ms, "retry_backoff_base_ms", out.retry_backoff_base_ms);

  if (cfg.max_retries_per_provider !== undefined) {
    if (!Number.isInteger(cfg.max_retries_per_provider) || cfg.max_retries_per_provider < 0) {
      issues.push(`max_retries_per_provider: expected non-negative integer, got ${JSON.stringify(cfg.max_retries_per_provider)}`);
    } else out.max_retries_per_provider = cfg.max_retries_per_provider;
  }
  if (cfg.body_limit_mb !== undefined) {
    if (typeof cfg.body_limit_mb !== "number" || cfg.body_limit_mb <= 0) issues.push("body_limit_mb: expected positive number");
    else out.body_limit_mb = cfg.body_limit_mb;
  }

  // providers
  if (!isPlainObject(cfg.providers) || Object.keys(cfg.providers).length === 0) {
    issues.push("providers: required non-empty object of providerId -> provider config");
  } else {
    for (const [id, p] of Object.entries(cfg.providers)) {
      if (!isPlainObject(p)) {
        issues.push(`providers.${id}: expected object`);
        continue;
      }
      // Collect THIS provider's issues locally — never prefix-match against the
      // global list (a sibling id like "openai-eu" used to poison "openai").
      const pIssues: string[] = [];
      const bad = (msg: string): void => {
        pIssues.push(`providers.${id}.${msg}`);
      };

      const type = p.type ?? "openai";
      if (type !== "openai" && type !== "mock") bad(`type: must be "openai" or "mock", got ${JSON.stringify(type)}`);

      // unknown fields rejected wholesale; secrets-in-config get a pointed hint.
      // Only field NAMES are echoed into messages — never values.
      for (const f of Object.keys(p)) {
        if (!KNOWN_PROVIDER_FIELDS.has(f)) {
          const hint = KEY_FIELD_HINTS[f]
            ? ` (did you mean api_key_env? provider API keys come from env vars, never the config file)`
            : "";
          bad(`unknown field "${f}"${hint}`);
        }
      }

      if (type === "openai") {
        if (typeof p.base_url !== "string" || !/^https?:\/\//.test(p.base_url)) {
          bad(`base_url: required http(s) URL for openai-type providers, got ${JSON.stringify(p.base_url)}`);
        }
      }
      if (p.api_key_env !== undefined) {
        if (typeof p.api_key_env !== "string" || p.api_key_env.length === 0) {
          bad(`api_key_env: expected env var NAME (string) or omit for keyless providers`);
        } else if (!ENV_VAR_NAME_RE.test(p.api_key_env)) {
          // any provider type: a non-name here is almost always a pasted key,
          // which the gateway would then treat as an env-var NAME and the
          // provider would silently lose its auth
          bad(`api_key_env must be the NAME of an environment variable (matching [A-Za-z_][A-Za-z0-9_]*), not a key — did you paste a secret?`);
        }
      }
      if (typeof p.model_id !== "string" || p.model_id.length === 0) bad(`model_id: required string`);
      if (!isPricing(p.pricing)) bad(`pricing: required {input_per_mtok:number, output_per_mtok:number}`);
      if (!Array.isArray(p.task_classes)) bad(`task_classes: required array of strings`);
      if (p.stream_include_usage !== undefined && typeof p.stream_include_usage !== "boolean") {
        bad(`stream_include_usage: expected boolean`);
      }
      if (p.off_peak !== undefined) validateOffPeak(p.off_peak, bad);
      if (p.capabilities !== undefined) validateCapabilities(p.capabilities, bad);

      if (pIssues.length > 0) {
        issues.push(...pIssues);
        continue;
      }
      out.providers[id] = {
        ...(type === "mock" ? { type } : {}),
        ...p,
      } as ProviderConfig;
    }
  }

  // keys
  if (!isPlainObject(cfg.keys) || Object.keys(cfg.keys).length === 0) {
    issues.push("keys: required non-empty object of gatewayKey -> { project, ... }");
  } else {
    for (const [key, k] of Object.entries(cfg.keys)) {
      if (!isPlainObject(k)) {
        issues.push(`keys."${key}": expected object`);
        continue;
      }
      if (typeof k.project !== "string" || k.project.length === 0) issues.push(`keys."${key}".project: required string`);
      if (k.allowed_task_classes !== undefined && !Array.isArray(k.allowed_task_classes)) {
        issues.push(`keys."${key}".allowed_task_classes: expected array of strings`);
      }
      if (k.sticky_provider_hint !== undefined && (typeof k.sticky_provider_hint !== "string" || k.sticky_provider_hint.length === 0)) {
        issues.push(`keys."${key}".sticky_provider_hint: expected provider id string`);
      }
      out.keys[key] = k as KeyConfig;
    }
  }

  // routing — each class is either a plain chain (array of provider ids, the
  // original form) or an object { chain, off_peak_chain } for off-peak-aware
  // classes. Both forms are accepted interchangeably, including mixed.
  if (!isPlainObject(cfg.routing)) {
    issues.push('routing: required object of taskClass -> chain (array of provider ids, or { chain, off_peak_chain }), including a "default" entry');
  } else {
    const isChain = (v: unknown): v is string[] =>
      Array.isArray(v) && v.length > 0 && v.every((p) => typeof p === "string");
    for (const [cls, entry] of Object.entries(cfg.routing)) {
      if (Array.isArray(entry)) {
        if (entry.length === 0 || !entry.every((p) => typeof p === "string")) {
          issues.push(`routing.${cls}: expected non-empty array of provider ids`);
          continue;
        }
        out.routing[cls] = [...entry];
      } else if (isPlainObject(entry)) {
        const bad: string[] = [];
        for (const f of Object.keys(entry)) {
          if (f !== "chain" && f !== "off_peak_chain") {
            bad.push(`routing.${cls}: unknown field "${f}" (object form allows only chain, off_peak_chain)`);
          }
        }
        const chain = entry.chain;
        const off = entry.off_peak_chain;
        if (!isChain(chain)) bad.push(`routing.${cls}.chain: required non-empty array of provider ids`);
        if (off !== undefined && !isChain(off)) {
          bad.push(`routing.${cls}.off_peak_chain: expected non-empty array of provider ids`);
        }
        if (bad.length > 0) {
          issues.push(...bad);
          continue;
        }
        out.routing[cls] = {
          chain: [...chain],
          ...(off !== undefined ? { off_peak_chain: [...off] } : {}),
        };
      } else {
        issues.push(`routing.${cls}: expected an array of provider ids or { chain, off_peak_chain }`);
      }
    }
    if (!("default" in cfg.routing)) issues.push('routing: missing required "default" chain');
  }

  // budgets
  if (cfg.budgets !== undefined) {
    if (!isPlainObject(cfg.budgets)) {
      issues.push("budgets: expected object of project -> { monthly_usd_cap: number }");
    } else {
      for (const [project, b] of Object.entries(cfg.budgets)) {
        if (!isPlainObject(b) || typeof b.monthly_usd_cap !== "number" || !Number.isFinite(b.monthly_usd_cap) || b.monthly_usd_cap <= 0) {
          issues.push(`budgets.${project}: expected { monthly_usd_cap: positive number }`);
        } else {
          out.budgets[project] = b as BudgetConfig;
        }
      }
    }
  }

  // report (optional; strictly validated: unknown fields rejected, baseline
  // must resolve to a VERIFIED price entry, overrides must carry real rates)
  if (cfg.report !== undefined) {
    if (!isPlainObject(cfg.report)) {
      issues.push("report: expected object { baseline?, prices? }");
    } else {
      const repIssues: string[] = [];
      const rep = cfg.report as Record<string, unknown>;
      for (const f of Object.keys(rep)) {
        if (f !== "baseline" && f !== "prices") {
          repIssues.push(`report: unknown field "${f}" (only baseline, prices are supported)`);
        }
      }
      const baseline = rep.baseline;
      if (baseline !== undefined) {
        if (typeof baseline === "string") {
          if (baseline.length === 0) {
            repIssues.push('report.baseline: expected a price-table id string or { model?, input_per_mtok, output_per_mtok }');
          }
        } else if (isPlainObject(baseline)) {
          for (const f of Object.keys(baseline)) {
            if (f !== "model" && f !== "input_per_mtok" && f !== "output_per_mtok") {
              repIssues.push(`report.baseline: unknown field "${f}" (only model, input_per_mtok, output_per_mtok are supported)`);
            }
          }
          if (baseline.model !== undefined && (typeof baseline.model !== "string" || baseline.model.length === 0)) {
            repIssues.push("report.baseline.model: expected non-empty string");
          }
          if (!isPricing(baseline)) {
            repIssues.push("report.baseline: expected finite non-negative input_per_mtok/output_per_mtok numbers");
          }
        } else {
          repIssues.push("report.baseline: expected a price-table id string or { model?, input_per_mtok, output_per_mtok }");
        }
      }
      const prices = rep.prices;
      if (prices !== undefined) {
        if (!isPlainObject(prices)) {
          repIssues.push("report.prices: expected object of modelId -> { input_per_mtok, output_per_mtok, source?, as_of? }");
        } else {
          for (const [id, o] of Object.entries(prices)) {
            if (id.length === 0) {
              repIssues.push("report.prices: model id keys must be non-empty strings");
              continue;
            }
            if (!isPlainObject(o)) {
              repIssues.push(`report.prices.${id}: expected object { input_per_mtok, output_per_mtok, source?, as_of? }`);
              continue;
            }
            for (const f of Object.keys(o)) {
              if (f !== "input_per_mtok" && f !== "output_per_mtok" && f !== "source" && f !== "as_of") {
                repIssues.push(`report.prices.${id}: unknown field "${f}" (only input_per_mtok, output_per_mtok, source, as_of are supported)`);
              }
            }
            if (!isPricing(o)) {
              repIssues.push(`report.prices.${id}: expected finite non-negative input_per_mtok/output_per_mtok numbers`);
            }
            if (o.source !== undefined && (typeof o.source !== "string" || o.source.length === 0)) {
              repIssues.push(`report.prices.${id}.source: expected non-empty string`);
            }
            if (o.as_of !== undefined && (typeof o.as_of !== "string" || o.as_of.length === 0)) {
              repIssues.push(`report.prices.${id}.as_of: expected non-empty string`);
            }
          }
        }
      }
      if (repIssues.length === 0) {
        // semantic pass shared with the report command: baseline resolution
        try {
          resolveReportPricing(cfg.report as ReportConfig);
        } catch (e) {
          repIssues.push((e as Error).message);
        }
      }
      issues.push(...repIssues);
      if (repIssues.length === 0) out.report = cfg.report as ReportConfig;
    }
  }

  // cross-references
  for (const [cls, entry] of Object.entries(out.routing)) {
    const chain = Array.isArray(entry) ? entry : entry.chain;
    for (const pid of chain ?? []) {
      if (!(pid in out.providers)) issues.push(`routing.${cls}: references unknown provider "${pid}"`);
    }
    if (!Array.isArray(entry)) {
      for (const pid of entry.off_peak_chain ?? []) {
        if (!(pid in out.providers)) issues.push(`routing.${cls}.off_peak_chain: references unknown provider "${pid}"`);
      }
    }
  }
  for (const [key, k] of Object.entries(out.keys)) {
    if (k.sticky_provider_hint && !(k.sticky_provider_hint in out.providers)) {
      issues.push(`keys."${key}".sticky_provider_hint: unknown provider "${k.sticky_provider_hint}"`);
    }
  }

  if (issues.length > 0) {
    throw new ConfigError(`invalid config (${path}):\n  - ${issues.join("\n  - ")}`);
  }
  return out;
}

/** Resolve a config path from --config flag / LLM_GATEWAY_CONFIG / ./llm-gateway.json */
export function configPath(argv: readonly string[]): string {
  const flagIdx = argv.indexOf("--config");
  if (flagIdx !== -1 && argv[flagIdx + 1]) return resolve(argv[flagIdx + 1]!);
  if (process.env.LLM_GATEWAY_CONFIG) return resolve(process.env.LLM_GATEWAY_CONFIG);
  return resolve("llm-gateway.json");
}

/**
 * Startup safety check: the config file holds gateway keys, so group/other
 * read bits are flagged. Returns a human-readable warning or null when perms
 * are tight (0600-style). Wired into main.ts at startup.
 */
export function configFilePermWarning(path: string): string | null {
  let mode: number;
  try {
    mode = statSync(path).mode & 0o777;
  } catch {
    return null; // unreadable -> loadConfig reports it properly
  }
  if ((mode & 0o077) === 0) return null;
  return (
    `config file ${path} is readable by group/others (mode ${mode.toString(8)}) — ` +
    `it holds gateway keys; chmod 600 ${path} recommended`
  );
}
