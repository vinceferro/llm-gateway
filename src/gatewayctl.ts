/**
 * Node half of the `bin/gateway` shim: `connect` printers + `--write` merge
 * (with `--project [name]` mint-or-select of a per-repo gateway key), and
 * `gateway report` — the honest counterfactual-savings + work-delivered
 * receipt. The report reads the ledger DIRECTLY (no running gateway needed);
 * all savings math lives in src/report.ts (pure) over prices from
 * src/prices.ts. Process management (start/stop/status) stays in the bash
 * shim; everything that needs JSON lives here.
 *
 * Config resolution mirrors main.ts, minus the ./llm-gateway.json fallback:
 * --config <path> > LLM_GATEWAY_CONFIG > ~/.llm-gateway/llm-gateway.json > ./llm-gateway.json
 */

import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join } from "node:path";
import { configPath, loadConfig, type GatewayConfig, type ProviderConfig } from "./config.ts";
import { filterRecords, ledgerPath, readRecords } from "./ledger.ts";
import { generateGatewayKey } from "./bootstrap.ts";
import { PriceError, resolveReportPricing } from "./prices.ts";
import { buildReport, type ReportOutput, type SplitBucket } from "./report.ts";

export class CliError extends Error {}

export interface ConnectInfo {
  key: string;
  host: string;
  port: number;
  models: string[];
}

function baseURL(info: ConnectInfo): string {
  return `http://${info.host}:${info.port}/v1`;
}

/** The provider block we merge into opencode config under provider["llm-gateway"]. */
export function opencodeProviderBlock(info: ConnectInfo): Record<string, unknown> {
  const models: Record<string, object> = {};
  for (const m of info.models) models[m] = { name: `${m} (via llm-gateway)` };
  return {
    npm: "@ai-sdk/openai-compatible",
    name: "LLM Gateway",
    options: {
      baseURL: baseURL(info),
      apiKey: info.key,
    },
    models,
  };
}

/** Copy-paste instructions per tool. Pure; tested against key/baseURL presence. */
export function connectInstructions(tool: string, info: ConnectInfo): string {
  switch (tool) {
    case "opencode": {
      const block = opencodeProviderBlock(info);
      return [
        `Add this provider block to ${opencodeConfigPath()} (inside the top-level object):`,
        "",
        JSON.stringify({ provider: { "llm-gateway": block } }, null, 2),
        "",
        `Then use model "llm-gateway/${info.models[0] ?? "<provider-id>"}" in opencode`,
        "(or any provider id from your gateway config as the model name).",
        "",
        `Or merge it automatically:  gateway connect opencode --write`,
        "(backs up your config to <config>.bak-pre-gateway-<timestamp> first)",
      ].join("\n");
    }
    case "aider":
      return [
        "Export these before launching aider (add to your shell profile to keep):",
        "",
        `  export OPENAI_API_BASE=${baseURL(info)}`,
        `  export OPENAI_API_KEY=${info.key}`,
        "",
        `Then run:  aider --model openai/${info.models[0] ?? "<provider-id>"}`,
        "(provider ids come from your gateway config; they are the model names the gateway exposes)",
      ].join("\n");
    case "claude-code":
      return [
        "Export these before launching claude-code:",
        "",
        `  export ANTHROPIC_BASE_URL=http://${info.host}:${info.port}`,
        `  export ANTHROPIC_AUTH_TOKEN=${info.key}`,
        "",
        "NOTE: the gateway currently speaks the OpenAI wire protocol (/v1/chat/completions).",
        "claude-code expects the Anthropic protocol, so this needs a protocol shim until the",
        "gateway gains /v1/messages — opencode and aider work out of the box today.",
      ].join("\n");
    default:
      throw new CliError(`unknown tool "${tool}" (supported: opencode, aider, claude-code)`);
  }
}

/** Deep-clone-preserving merge: only provider["llm-gateway"] is (re)set. */
export function mergeOpencodeConfig(existing: unknown, block: unknown): Record<string, unknown> {
  const out: Record<string, unknown> =
    typeof existing === "object" && existing !== null && !Array.isArray(existing)
      ? (structuredClone(existing) as Record<string, unknown>)
      : {};
  const providers: Record<string, unknown> =
    typeof out.provider === "object" && out.provider !== null && !Array.isArray(out.provider)
      ? (structuredClone(out.provider) as Record<string, unknown>)
      : {};
  providers["llm-gateway"] = structuredClone(block);
  out.provider = providers;
  return out;
}

/** ~/.config/opencode/opencode.json (XDG_CONFIG_HOME aware). */
export function opencodeConfigPath(): string {
  const xdg = process.env.XDG_CONFIG_HOME;
  return xdg ? join(xdg, "opencode", "opencode.json") : join(homedir(), ".config", "opencode", "opencode.json");
}

function tsStamp(now: () => Date): string {
  const d = now();
  const p = (n: number): string => String(n).padStart(2, "0");
  return (
    `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}` +
    `-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`
  );
}

/**
 * Merge the gateway provider block into an opencode config file on disk.
 * Backs the file up first as <path>.bak-pre-gateway-<ts>. Refuses to parse
 * JSONC (comments) — prints instructions instead of corrupting the file.
 */
export function applyOpencodeMerge(
  filePath: string,
  info: ConnectInfo,
  now: () => Date = (): Date => new Date(),
): { backupPath: string | null } {
  let existing: unknown;
  if (existsSync(filePath)) {
    let text: string;
    try {
      text = readFileSync(filePath, "utf8");
    } catch (e) {
      throw new CliError(`cannot read ${filePath}: ${(e as Error).message}`);
    }
    try {
      existing = JSON.parse(text);
    } catch {
      throw new CliError(
        `${filePath} is not valid JSON (comments? that's JSONC) — merge the printed block by hand instead`,
      );
    }
    const backupPath = `${filePath}.bak-pre-gateway-${tsStamp(now)}`;
    copyFileSync(filePath, backupPath);
    const merged = mergeOpencodeConfig(existing, opencodeProviderBlock(info));
    writeFileSync(filePath, JSON.stringify(merged, null, 2) + "\n", "utf8");
    return { backupPath };
  }

  mkdirSync(dirname(filePath), { recursive: true });
  const merged = mergeOpencodeConfig(existing, opencodeProviderBlock(info));
  writeFileSync(filePath, JSON.stringify(merged, null, 2) + "\n", "utf8");
  return { backupPath: null };
}

function resolveConfigPath(argv: readonly string[]): string {
  // explicit flag / env var win (same parsing as main.ts); otherwise prefer the
  // installed location, falling back to a repo-checkout ./llm-gateway.json
  const flagIdx = argv.indexOf("--config");
  const envSet = Boolean(process.env.LLM_GATEWAY_CONFIG);
  if (flagIdx !== -1 || envSet) return configPath(argv);
  const installed = join(homedir(), ".llm-gateway", "llm-gateway.json");
  if (existsSync(installed)) return installed;
  return configPath(argv);
}

function loadInstalledConfig(argv: readonly string[]): GatewayConfig {
  const path = resolveConfigPath(argv);
  if (!existsSync(path)) {
    throw new CliError(
      `config not found at ${path} — run the installer first (curl ... install.sh) or pass --config <path>`,
    );
  }
  return loadConfig(path); // validated, same rules as the server
}

function connectInfoOf(cfg: GatewayConfig): ConnectInfo {
  const key = Object.keys(cfg.keys)[0];
  if (!key) throw new CliError(`config has no gateway keys — add one under "keys" first`);
  return { key, host: cfg.host, port: cfg.port, models: Object.keys(cfg.providers) };
}

// --- connect --project: mint-or-select a per-repo gateway key ---------------

/** Parsed `gateway connect` flags. */
export interface ConnectFlags {
  tool?: string;
  write: boolean;
  /** --project appeared on the argv (the value may still be defaulted). */
  projectRequested: boolean;
  /** Explicit value after --project, when one was given. */
  projectValue?: string;
}

/**
 * Parse connect flags. Legacy rule preserved exactly: the FIRST bare argument
 * is the tool, wherever it sits (`gateway connect --write opencode` selects
 * "opencode" today and must keep doing so). `--project` takes an OPTIONAL
 * value — a following flag (or end of argv) means "default it" (the caller
 * uses basename(cwd)); a value is never mistaken for the tool name.
 */
export function parseConnectFlags(rest: readonly string[]): ConnectFlags {
  const flags: ConnectFlags = { write: false, projectRequested: false };
  for (let i = 0; i < rest.length; i++) {
    const a = rest[i]!;
    if (a === "--write") flags.write = true;
    else if (a === "--project") {
      flags.projectRequested = true;
      const v = rest[i + 1];
      if (v !== undefined && !v.startsWith("--")) {
        flags.projectValue = v;
        i++;
      }
    } else if (!a.startsWith("--") && flags.tool === undefined) {
      flags.tool = a;
    }
  }
  return flags;
}

/**
 * First existing gateway key (config insertion order) whose `project` matches
 * exactly — case-sensitive — or null. Hashed (`sha256:<hex>`) keys match like
 * any other; their id is what the config stores.
 */
export function findKeyForProject(cfg: GatewayConfig, project: string): string | null {
  for (const [key, k] of Object.entries(cfg.keys)) {
    if (k.project === project) return key;
  }
  return null;
}

/**
 * Mint a 256-bit `sk-lg-` gateway key for `project` (same generator the
 * installer uses) and append it to the config's `keys` map. The RAW JSON is
 * re-read and mutated in place so every other field — including tolerated
 * extras like `_readme` — survives; written back 0600 exactly like bootstrap
 * (the file holds gateway keys); the result is re-validated with loadConfig,
 * so config this touches can never drift out of schema.
 */
export function mintProjectKey(configFile: string, project: string): { key: string; cfg: GatewayConfig } {
  const key = generateGatewayKey();
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(configFile, "utf8"));
  } catch (e) {
    throw new CliError(`cannot read ${configFile}: ${(e as Error).message}`);
  }
  const isObj = (v: unknown): v is Record<string, unknown> =>
    typeof v === "object" && v !== null && !Array.isArray(v);
  if (!isObj(raw)) throw new CliError(`config ${configFile} is not a JSON object`);
  if (!isObj(raw.keys)) throw new CliError(`config ${configFile} has no "keys" object to extend`);
  raw.keys[key] = { project };
  writeFileSync(configFile, JSON.stringify(raw, null, 2) + "\n", { encoding: "utf8", mode: 0o600 });
  return { key, cfg: loadConfig(configFile) }; // re-validate: same rules as the server
}

// --- gateway report: honest counterfactual savings + work delivered --------

export interface ReportFlags {
  month: string;
  project?: string;
  json: boolean;
  htmlPath?: string;
}

const MONTH_RE = /^\d{4}-(0[1-9]|1[0-2])$/;

/** Parse report flags: --month YYYY-MM (default current UTC month), --project, --json, --html <out.html>. */
export function parseReportFlags(
  rest: readonly string[],
  now: () => Date = (): Date => new Date(),
): ReportFlags {
  const flags: ReportFlags = { month: now().toISOString().slice(0, 7), json: false };
  for (let i = 0; i < rest.length; i++) {
    const a = rest[i]!;
    switch (a) {
      case "--month": {
        const v = rest[++i];
        if (!v || !MONTH_RE.test(v)) {
          throw new CliError(`report: --month expects YYYY-MM (month 01-12), got ${JSON.stringify(v ?? "")}`);
        }
        flags.month = v;
        break;
      }
      case "--project": {
        const v = rest[++i];
        if (!v) throw new CliError("report: --project expects a project name");
        flags.project = v;
        break;
      }
      case "--json":
        flags.json = true;
        break;
      case "--html": {
        const v = rest[++i];
        if (!v) throw new CliError("report: --html expects an output .html path");
        flags.htmlPath = v;
        break;
      }
      default:
        throw new CliError(
          `report: unknown flag "${a}" (supported: --month YYYY-MM, --project <name>, --json, --html <out.html>)`,
        );
    }
  }
  return flags;
}

/** Money: 2dp above half a cent; 6dp below so ledger nano-dollar precision never hides as $0.00. */
function fmtUsd(n: number): string {
  if (n === 0) return "$0.00";
  if (Math.abs(n) < 0.005) return `$${n.toFixed(6)}`;
  return `$${n.toFixed(2)}`;
}

function fmtInt(n: number): string {
  return n.toLocaleString("en-US");
}

function renderTable(header: readonly string[], rows: readonly (readonly string[])[]): string {
  const widths = header.map((h, i) => Math.max(h.length, ...rows.map((r) => (r[i] ?? "").length)));
  const left = header.map((_, i) => i === 0);
  const line = (cells: readonly string[]): string =>
    cells.map((c, i) => (left[i] ? c.padEnd(widths[i]!) : c.padStart(widths[i]!))).join("  ");
  const sep = widths.map((w) => "-".repeat(w)).join("  ");
  return [line(header), sep, ...rows.map(line), sep].join("\n");
}

function projectRowOf(p: {
  project: string;
  requests: number;
  input_tokens: number;
  output_tokens: number;
  actual_usd: number;
  cf_a_usd: number | null;
  cf_b_usd: number | null;
  savings_vs_baseline_usd: number | null;
}): string[] {
  return [
    p.project,
    fmtInt(p.requests),
    fmtInt(p.input_tokens),
    fmtInt(p.output_tokens),
    fmtUsd(p.actual_usd),
    p.cf_a_usd === null ? "—" : fmtUsd(p.cf_a_usd),
    p.cf_b_usd === null ? "—" : fmtUsd(p.cf_b_usd),
    p.savings_vs_baseline_usd === null ? "—" : fmtUsd(p.savings_vs_baseline_usd),
  ];
}

/** Terminal receipt: usage table, savings lines, work delivered, assumptions, warnings. */
export function renderReportText(report: ReportOutput, ledgerFile: string): string {
  const lines: string[] = [];
  const cf = report.counterfactual;
  const b = report.baseline;
  lines.push(
    `gateway report — ${report.month} · project: ${report.project}${report.project === "*" ? " (all projects)" : ""}`,
  );
  lines.push(`ledger: ${ledgerFile}`);
  lines.push(
    `baseline: ${b.id} — $${b.input_per_mtok}/$${b.output_per_mtok} per Mtok ` +
      `(source: ${b.source}, as of ${b.asOf}, ${b.verified ? "VERIFIED" : "UNVERIFIED"})`,
  );
  lines.push("");
  lines.push("Usage + counterfactual savings (per project)");
  lines.push(
    renderTable(
      ["project", "requests", "in tok", "out tok", "actual", "cfA no-cache", "cfB baseline", "savings vs B"],
      [...report.projects.map(projectRowOf), projectRowOf(report.totals)],
    ),
  );
  const excl: string[] = [];
  if (cf.excluded_local_requests > 0) excl.push(`${cf.excluded_local_requests} local-GPU`);
  if (cf.excluded_unverified_requests > 0) excl.push(`${cf.excluded_unverified_requests} unverified-pricing`);
  lines.push("");
  lines.push(
    `Counterfactual savings (scope: ${cf.scope_requests} of ${report.total_rows} requests` +
      (excl.length > 0 ? ` — excluded: ${excl.join(", ")}` : "") + ")",
  );
  lines.push(`  routing/cache savings (cfB − cfA):        ${fmtUsd(cf.routing_cache_savings_usd)}`);
  lines.push(`  total savings vs baseline (cfB − actual): ${fmtUsd(cf.total_savings_usd)}`);
  if (cf.plan_notice) lines.push(`  plan coverage: ${cf.plan_notice}`);

  const w = report.work;
  const splitPart = (name: string, x: SplitBucket): string =>
    `${name} ${x.requests} req / ${fmtInt(x.input_tokens)} in / ${fmtInt(x.output_tokens)} out`;
  const s = w.split;
  lines.push("");
  lines.push("Work delivered (all rows, local included)");
  lines.push(`  agent turns:         ${fmtInt(w.agent_turns)}`);
  lines.push(`  output tokens:       ${fmtInt(w.output_tokens)}`);
  lines.push(`  stream time:         ${w.stream_hours} h`);
  lines.push(
    `  reliability:         ` +
      (w.reliability_pct === null
        ? "n/a (empty ledger)"
        : `${w.reliability_pct.toFixed(1)}% (${w.completed_rows}/${w.total_rows} rows completed)`),
  );
  lines.push(`  fallbacks survived:  ${fmtInt(w.fallbacks_survived)}`);
  lines.push(
    `  local vs cloud:      ${splitPart("local", s.local)} · ${splitPart("cloud", s.cloud)} · ${splitPart("unknown", s.unknown)}`,
  );
  lines.push(
    `  ttfb ms p50/p95:     ` +
      (w.ttfb_by_provider.length === 0
        ? "none recorded"
        : w.ttfb_by_provider
            .map((t) => `${t.provider} ${t.ttfb_p50_ms ?? "?"}/${t.ttfb_p95_ms ?? "?"} (${t.samples} samples)`)
            .join(", ")),
  );
  lines.push("");
  lines.push("Assumptions (every savings number above carries these)");
  for (const a of report.assumptions) lines.push(`  · ${a}`);
  lines.push("");
  if (report.warnings.length === 0) lines.push("Warnings: none");
  else {
    lines.push("Warnings");
    for (const warn of report.warnings) lines.push(`  ! ${warn}`);
  }
  return lines.join("\n");
}

function escapeHtml(s: string): string {
  return s.replace(
    /[&<>"']/g,
    (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!,
  );
}

/** Self-contained shareable receipt: inline CSS, zero external resources, no scripts. */
export function renderReportHtml(report: ReportOutput, ledgerFile: string): string {
  const e = escapeHtml;
  const cf = report.counterfactual;
  const b = report.baseline;
  const w = report.work;
  const excl: string[] = [];
  if (cf.excluded_local_requests > 0) excl.push(`${cf.excluded_local_requests} local-GPU`);
  if (cf.excluded_unverified_requests > 0) excl.push(`${cf.excluded_unverified_requests} unverified-pricing`);

  const tableRows = [...report.projects.map(projectRowOf), projectRowOf(report.totals)];
  const tableHtml = tableRows
    .map(
      (cells, i) =>
        `<tr${i === tableRows.length - 1 ? ' class="total"' : ""}>` +
        cells.map((c) => `<td>${e(c)}</td>`).join("") +
        "</tr>",
    )
    .join("\n");

  const splitPart = (name: string, x: SplitBucket): string =>
    `${name}: ${x.requests} req / ${fmtInt(x.input_tokens)} in / ${fmtInt(x.output_tokens)} out`;
  const s = w.split;
  const ttfb =
    w.ttfb_by_provider.length === 0
      ? "none recorded"
      : w.ttfb_by_provider
          .map((t) => `${e(t.provider)} ${t.ttfb_p50_ms ?? "?"}/${t.ttfb_p95_ms ?? "?"} ms (${t.samples} samples)`)
          .join(", ");

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>llm-gateway report ${e(report.month)}</title>
<style>
  body{font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;margin:2rem auto;max-width:60rem;padding:0 1rem;color:#1a1a2e;background:#fafafa;line-height:1.5}
  h1{font-size:1.25rem;margin-bottom:.2rem}
  h2{font-size:1rem;border-bottom:1px solid #ccc;padding-bottom:.25rem;margin-top:2rem}
  .muted{color:#666;font-size:.85rem;margin:.15rem 0}
  table{border-collapse:collapse;width:100%;font-size:.85rem;margin-top:.5rem}
  th,td{padding:.35rem .5rem;border-bottom:1px solid #e2e2e2;text-align:right;white-space:nowrap}
  th:first-child,td:first-child{text-align:left}
  tr.total{font-weight:700;background:#f0f0f0}
  .savings{background:#eef7ee;border:1px solid #cde3cd;padding:.75rem 1rem;border-radius:6px;margin-top:.5rem}
  .savings div b{font-size:1.05rem}
  .plan{margin-top:.5rem;font-size:.85rem}
  .warn{color:#8a2b0b;background:#fdf1ec;border:1px solid #f0cfc0;padding:.5rem .75rem;border-radius:6px;margin:.35rem 0;font-size:.85rem}
  ul{margin:.4rem 0;padding-left:1.2rem}
  li{margin:.2rem 0}
  .assump li{color:#444;font-size:.85rem}
</style>
</head>
<body>
<h1>gateway report — ${e(report.month)} · project: ${e(report.project)}${report.project === "*" ? " (all projects)" : ""}</h1>
<p class="muted">ledger: ${e(ledgerFile)}</p>
<p class="muted">baseline: ${e(b.id)} — $${e(String(b.input_per_mtok))}/$${e(String(b.output_per_mtok))} per Mtok (source: ${e(b.source)}, as of ${e(b.asOf)}, ${b.verified ? "VERIFIED" : "UNVERIFIED"})</p>

<h2>Usage + counterfactual savings</h2>
<table>
<thead><tr><th>project</th><th>requests</th><th>in tok</th><th>out tok</th><th>actual</th><th>cfA no-cache</th><th>cfB baseline</th><th>savings vs B</th></tr></thead>
<tbody>
${tableHtml}
</tbody>
</table>

<div class="savings">
<div>Counterfactual scope: ${cf.scope_requests} of ${report.total_rows} request(s)${excl.length > 0 ? ` — excluded: ${e(excl.join(", "))}` : ""}</div>
<div>routing/cache savings (cfB − cfA): <b>${fmtUsd(cf.routing_cache_savings_usd)}</b></div>
<div>total savings vs baseline (cfB − actual): <b>${fmtUsd(cf.total_savings_usd)}</b></div>
${cf.plan_notice ? `<div class="plan">${e(cf.plan_notice)}</div>` : ""}
</div>

<h2>Work delivered (all rows, local included)</h2>
<ul>
<li>agent turns: ${fmtInt(w.agent_turns)}</li>
<li>output tokens: ${fmtInt(w.output_tokens)}</li>
<li>stream time: ${w.stream_hours} h</li>
<li>reliability: ${w.reliability_pct === null ? "n/a (empty ledger)" : `${w.reliability_pct.toFixed(1)}% (${w.completed_rows}/${w.total_rows} rows completed)`}</li>
<li>fallbacks survived: ${fmtInt(w.fallbacks_survived)}</li>
<li>local vs cloud: ${e(splitPart("local", s.local))} · ${e(splitPart("cloud", s.cloud))} · ${e(splitPart("unknown", s.unknown))}</li>
<li>ttfb ms p50/p95: ${e(ttfb)}</li>
</ul>

<h2>Assumptions (every savings number above carries these)</h2>
<ul class="assump">
${report.assumptions.map((a) => `<li>${e(a)}</li>`).join("\n")}
</ul>

<h2>Warnings</h2>
${
  report.warnings.length === 0
    ? `<p class="muted">none</p>`
    : report.warnings.map((warn) => `<div class="warn">! ${e(warn)}</div>`).join("\n")
}
</body>
</html>
`;
}

/** `gateway report`: read the ledger directly (no running gateway), build + render the receipt. */
async function reportCommand(cfg: GatewayConfig, rest: readonly string[]): Promise<void> {
  const flags = parseReportFlags(rest);
  let pricing;
  try {
    pricing = resolveReportPricing(cfg.report);
  } catch (err) {
    if (err instanceof PriceError) throw new CliError(err.message);
    throw err;
  }
  const rows = filterRecords(readRecords(cfg.storage_dir), {
    project: flags.project,
    month: flags.month,
  });
  const report = buildReport({
    month: flags.month,
    project: flags.project,
    rows,
    providers: cfg.providers as Record<string, ProviderConfig>,
    pricing,
  });
  const ledgerFile = ledgerPath(cfg.storage_dir);
  if (flags.json) {
    console.log(JSON.stringify(report, null, 2)); // stdout stays machine-clean
    if (flags.htmlPath) {
      writeFileSync(flags.htmlPath, renderReportHtml(report, ledgerFile), "utf8");
      console.error(`[report] html receipt written: ${flags.htmlPath}`);
    }
  } else {
    console.log(renderReportText(report, ledgerFile));
    if (flags.htmlPath) {
      writeFileSync(flags.htmlPath, renderReportHtml(report, ledgerFile), "utf8");
      console.log(`[report] html receipt written: ${flags.htmlPath}`);
    }
  }
}

/** CLI dispatch: [--config <path>] connect <tool> [--write] | report */
export async function runCli(argv: readonly string[]): Promise<void> {
  // --config may lead the argv (bin/gateway passes it first); dispatch skips it,
  // config resolution below still sees it
  const dispatch = argv[0] === "--config" ? argv.slice(2) : argv;
  const [cmd, ...rest] = dispatch;
  switch (cmd) {
    case "connect": {
      const flags = parseConnectFlags(rest);
      if (!flags.tool) {
        throw new CliError("usage: gateway connect <opencode|aider|claude-code> [--write] [--project [name]]");
      }
      const cfg = loadInstalledConfig(argv);
      let info: ConnectInfo;
      if (flags.projectRequested) {
        // --project [name]: select the existing key for this project, or mint
        // one; default label is the current directory's basename
        const project = flags.projectValue ?? basename(process.cwd());
        const existing = findKeyForProject(cfg, project);
        if (existing !== null) {
          console.log(`[connect] using existing gateway key for project "${project}"`);
          info = { key: existing, host: cfg.host, port: cfg.port, models: Object.keys(cfg.providers) };
        } else {
          const configFile = resolveConfigPath(argv);
          const minted = mintProjectKey(configFile, project);
          console.log(`[connect] minted a new gateway key for project "${project}" (added to ${configFile})`);
          console.log(`[connect] gateway key: ${minted.key}`);
          console.log("[connect] keep it secret — it authorizes requests");
          info = {
            key: minted.key,
            host: minted.cfg.host,
            port: minted.cfg.port,
            models: Object.keys(minted.cfg.providers),
          };
        }
      } else {
        info = connectInfoOf(cfg); // legacy selection: first key, untouched
      }
      if (flags.tool === "opencode" && flags.write) {
        const target = opencodeConfigPath();
        const { backupPath } = applyOpencodeMerge(target, info);
        console.log(
          backupPath
            ? `[connect] merged provider block into ${target} (backup: ${backupPath})`
            : `[connect] created ${target} with the llm-gateway provider block`,
        );
        console.log("[connect] restart opencode to pick it up");
      } else {
        console.log(connectInstructions(flags.tool, info));
      }
      return;
    }
    case "report": {
      const cfg = loadInstalledConfig(argv);
      await reportCommand(cfg, rest);
      return;
    }
    default:
      throw new CliError(
        `usage: gateway <start|stop|status|connect|report>\n  node layer handles: connect <opencode|aider|claude-code> [--write], report`,
      );
  }
}

if (process.argv[1] && import.meta.filename === process.argv[1]) {
  runCli(process.argv.slice(2)).catch((e: unknown) => {
    if (e instanceof CliError) {
      console.error(`[gateway] ${e.message}`);
      process.exitCode = 1;
      return;
    }
    console.error("[gateway] error:", e);
    process.exitCode = 1;
  });
}
