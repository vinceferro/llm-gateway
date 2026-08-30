/**
 * Fresh-install config bootstrap: `node --experimental-strip-types src/bootstrap.ts --out <path> [--detect]`
 *
 * Used by install.sh (and safe to run by hand). Generates a *funded-or-local*
 * config that passes loadConfig validation unchanged:
 *  - admin key (256-bit hex) + one gateway key (sk-lg-<256-bit hex>) via node:crypto
 *  - storage_dir, default routing chain
 *  - providers = OpenAI-compatible servers detected on localhost (--detect), or
 *    the in-process mock provider when nothing is found (config must stay valid:
 *    providers may not be empty and routing.default must resolve).
 *
 * NEVER overwrites an existing config. NEVER writes provider API keys — funded
 * providers belong in the config as `api_key_env` names, edited by hand later.
 */

import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

export class BootstrapError extends Error {}

/** GET <base>/v1/models response shape we rely on (OpenAI-compatible). */
export interface DiscoveredRuntime {
  /** localhost port the server answered on */
  port: number;
  /** trivial server identity from a well-known port, when we can guess one */
  name: string | null;
  /** model ids reported by GET /v1/models (already sorted) */
  models: string[];
}

export type FetchLike = (
  url: string,
  init?: { signal?: AbortSignal },
) => Promise<{ ok: boolean; status: number; json: () => Promise<unknown> }>;

/** ollama, llama.cpp (both common ports), LM Studio. */
export const DEFAULT_PROBE_PORTS: readonly number[] = [11434, 8081, 8082, 1234];

const PROBE_TIMEOUT_MS = 1_000;

/** Well-known-port fingerprint — best effort only, misses stay null. */
function serverIdentity(port: number): string | null {
  switch (port) {
    case 11434: return "ollama";
    case 8081:
    case 8082: return "llama.cpp";
    case 1234: return "LM Studio";
    default: return null;
  }
}

interface ModelsResponse {
  data?: unknown;
}

/** Extract model id strings from a /v1/models payload; empty = unusable. */
function modelIdsOf(payload: unknown): string[] {
  const data = (payload as ModelsResponse | null)?.data;
  if (!Array.isArray(data)) return [];
  return data
    .map((m) => (m && typeof m === "object" && "id" in m ? (m as { id: unknown }).id : null))
    .filter((id): id is string => typeof id === "string" && id.length > 0)
    .sort();
}

/**
 * Probe localhost ports for OpenAI-compatible servers. Pure/injectible: the
 * port list and fetch are parameters, so unit tests never touch the network.
 * All probes run in parallel; a probe that throws, times out, returns non-ok,
 * unparsable JSON, or no models is a silent miss.
 */
export async function detectLocalRuntimes(
  opts: {
    ports?: readonly number[];
    fetchImpl?: FetchLike;
    timeoutMs?: number;
  } = {},
): Promise<DiscoveredRuntime[]> {
  const ports = opts.ports ?? DEFAULT_PROBE_PORTS;
  const timeoutMs = opts.timeoutMs ?? PROBE_TIMEOUT_MS;
  const doFetch = opts.fetchImpl ?? fetch;

  const results = await Promise.all(
    ports.map(async (port): Promise<DiscoveredRuntime | null> => {
      try {
        const res = await doFetch(`http://127.0.0.1:${port}/v1/models`, {
          signal: AbortSignal.timeout(timeoutMs),
        });
        if (!res.ok) return null;
        const models = modelIdsOf(await res.json());
        if (models.length === 0) return null;
        return { port, name: serverIdentity(port), models };
      } catch {
        return null; // probe misses are silent by design
      }
    }),
  );

  return results
    .filter((r): r is DiscoveredRuntime => r !== null)
    .sort((a, b) => a.port - b.port);
}

/** 256-bit random admin key, hex-encoded. */
export function generateAdminKey(): string {
  return randomBytes(32).toString("hex");
}

/** 256-bit random gateway key, `sk-lg-` prefixed. */
export function generateGatewayKey(): string {
  return "sk-lg-" + randomBytes(32).toString("hex");
}

/** The OpenAI-compatible provider entry for a detected local runtime. */
export function runtimeProviderConfig(rt: DiscoveredRuntime): Record<string, unknown> {
  return {
    type: "openai",
    base_url: `http://127.0.0.1:${rt.port}/v1`,
    model_id: rt.models[0]!,
    pricing: { input_per_mtok: 0, output_per_mtok: 0 },
    task_classes: ["autocomplete", "bulk"],
  };
}

export interface BuildConfigOptions {
  adminKey: string;
  gatewayKey: string;
  /** Where the ledger/sticky state lives. "~" is fine — loadConfig expands it. */
  storageDir: string;
  runtimes: readonly DiscoveredRuntime[];
}

/**
 * Assemble the full bootstrap config object (JSON-safe, loadConfig-valid).
 * With zero detected runtimes the in-process mock provider keeps the config
 * valid; the finish panel tells the user how to add real providers.
 */
export function buildBootstrapConfig(opts: BuildConfigOptions): Record<string, unknown> {
  const { adminKey, gatewayKey, storageDir } = opts;
  // deterministic output regardless of probe completion order
  const runtimes = [...opts.runtimes].sort((a, b) => a.port - b.port);

  const providers: Record<string, unknown> = {};
  for (const rt of runtimes) providers[`local-${rt.port}`] = runtimeProviderConfig(rt);
  if (Object.keys(providers).length === 0) {
    providers["mock-local"] = {
      type: "mock",
      model_id: "mock-model",
      pricing: { input_per_mtok: 0, output_per_mtok: 0 },
      task_classes: ["testing"],
    };
  }

  // all local providers, port-ascending — same chain for every class. Task
  // classes without a detected story are omitted entirely (chains must be
  // non-empty and every id must exist).
  const chain = runtimes.length > 0 ? runtimes.map((rt) => `local-${rt.port}`) : ["mock-local"];
  const routing: Record<string, unknown> = {
    default: [...chain],
  };
  if (runtimes.length > 0) {
    routing["autocomplete"] = [...chain];
    routing["bulk"] = [...chain];
    routing["agentic-coding"] = [...chain];
  } else {
    routing["testing"] = [...chain];
  }

  return {
    _readme: [
      `Generated by src/bootstrap.ts (llm-gateway installer) — it is safe to edit.`,
      "Local runtimes were auto-detected by probing 127.0.0.1 ports (ollama 11434, llama.cpp 8081/8082, LM Studio 1234).",
      runtimes.length > 0
        ? "Detected: " + runtimes.map((r) => `local-${r.port}${r.name ? ` (${r.name})` : ""}`).join(", ") + "."
        : "No local model server was detected, so routing falls back to the in-process mock provider. Add a real provider below or start ollama/llama.cpp and re-run the installer.",
      "To add a funded provider: add an entry under providers with api_key_env naming an ENV VAR (never a literal key), export the key in ~/.llm-gateway/env, then list it in the routing chains.",
      "Gateway keys + admin_key may be hashed as sha256:<hex> via `npm run hash-key -- <secret>`; plaintext is accepted for this 0600 local file.",
    ],
    port: 8090,
    host: "127.0.0.1",
    storage_dir: storageDir,
    admin_key: adminKey,
    providers,
    routing,
    keys: {
      [gatewayKey]: { project: "sandbox", allowed_task_classes: [] },
    },
    budgets: {},
  };
}

/**
 * Write the generated config. Refuses to overwrite an existing file (the
 * caller decides how to phrase that to the user) and creates it 0600 —
 * it holds gateway keys.
 */
export function writeBootstrapConfig(outPath: string, cfg: unknown): void {
  if (existsSync(outPath)) {
    throw new BootstrapError(
      `refusing to overwrite existing config: ${outPath} (delete it first if you really want a fresh one)`,
    );
  }
  mkdirSync(dirname(outPath), { recursive: true });
  writeFileSync(outPath, JSON.stringify(cfg, null, 2) + "\n", { encoding: "utf8", mode: 0o600 });
}

function usage(): string {
  return "usage: node --experimental-strip-types src/bootstrap.ts --out <path> [--detect]";
}

async function main(argv: readonly string[]): Promise<void> {
  let out: string | undefined;
  let detect = false;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a === "--out") out = argv[++i];
    else if (a === "--detect") detect = true;
    else if (a === "--help" || a === "-h") {
      console.log(usage());
      return;
    } else throw new BootstrapError(`unknown argument: ${a}\n${usage()}`);
  }
  if (!out || out.length === 0) throw new BootstrapError(`--out is required\n${usage()}`);

  const runtimes = detect ? await detectLocalRuntimes() : [];
  const gatewayKey = generateGatewayKey();
  const cfg = buildBootstrapConfig({
    adminKey: generateAdminKey(),
    gatewayKey,
    storageDir: "~/.llm-gateway",
    runtimes,
  });
  writeBootstrapConfig(out, cfg);

  console.log(`[bootstrap] wrote ${out}`);
  if (runtimes.length > 0) {
    console.log(
      `[bootstrap] detected local runtimes: ${runtimes
        .map((r) => `local-${r.port}${r.name ? ` (${r.name}, model ${r.models[0]})` : ""}`)
        .join(", ")}`,
    );
  } else if (detect) {
    console.log(
      "[bootstrap] no local model server found on 127.0.0.1 (ports 11434, 8081, 8082, 1234) — config uses the in-process mock provider until you add one",
    );
  }
  console.log(`[bootstrap] gateway key: ${gatewayKey}`);
  console.log("[bootstrap] keep it secret — it authorizes requests (and is echoed by `gateway connect`)");
}

/** CLI entrypoint — exit 1 on BootstrapError with a clean message. */
export async function runCli(argv: readonly string[]): Promise<void> {
  try {
    await main(argv);
  } catch (e) {
    if (e instanceof BootstrapError) {
      console.error(`[bootstrap] ${e.message}`);
      process.exitCode = 1;
      return;
    }
    throw e;
  }
}

if (process.argv[1] && import.meta.filename === process.argv[1]) {
  await runCli(process.argv.slice(2));
}
