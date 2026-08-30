/**
 * Per-provider smoke test: sends a tiny 1-token chat request DIRECTLY to the
 * configured provider (bypasses the gateway server) and prints OK/FAIL with
 * latency, tokens, and computed cost.
 *
 * Usage:
 *   npm run smoke -- <provider-id> [--config path/to/llm-gateway.json]
 *   npm run smoke -- all
 *
 * Exit codes: 0 = all requested providers OK, 1 = upstream failure,
 *             2 = config/env problem (message names exactly what's missing).
 *
 * NOTE: `type: "mock"` providers are exercised in-process — no network needed.
 */

import { performance } from "node:perf_hooks";
import { configPath, loadConfig, type ProviderConfig } from "../src/config.ts";
import { dispatchOne } from "../src/upstream.ts";
import { computeCost } from "../src/ledger.ts";
import { estTokens } from "../src/util.ts";

function args(argv: string[]): { provider: string | null; cfgPath: string | null } {
  let provider: string | null = null;
  let cfgPath: string | null = null;
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--config") {
      cfgPath = argv[i + 1] ?? null;
      i++;
    } else if (!provider) {
      provider = argv[i]!;
    }
  }
  return { provider, cfgPath };
}

async function smokeProvider(id: string, pcfg: ProviderConfig, timeoutMs: number): Promise<number> {
  const t0 = performance.now();

  // fail fast and precisely on missing credentials
  if (pcfg.type !== "mock" && pcfg.api_key_env && !process.env[pcfg.api_key_env]) {
    console.error(
      `SKIP ${id}: environment variable ${pcfg.api_key_env} is not set — export it (export ${pcfg.api_key_env}=<key>) and retry`,
    );
    return 2;
  }

  const body: Record<string, unknown> = {
    messages: [{ role: "user", content: "Reply with the single word: pong" }],
    max_tokens: 1,
    stream: false,
    model: pcfg.model_id, // mock ignores this; openai dispatch overrides anyway
  };

  try {
    const reply = await dispatchOne(id, pcfg, body, AbortSignal.timeout(timeoutMs));
    const latencyMs = Math.round(performance.now() - t0);
    if (reply.status !== 200) {
      console.error(`FAIL ${id}: HTTP ${reply.status}${reply.bodyText ? ` — ${reply.bodyText.slice(0, 300)}` : ""}`);
      return 1;
    }

    let inTok: number;
    let outTok: number;
    let estimated = false;
    try {
      const json = JSON.parse(reply.bodyText ?? "{}") as {
        usage?: { prompt_tokens?: number; completion_tokens?: number };
        choices?: Array<{ message?: { content?: string } }>;
      };
      if (typeof json.usage?.prompt_tokens === "number") {
        inTok = json.usage.prompt_tokens;
        outTok = json.usage.completion_tokens ?? 0;
      } else {
        estimated = true;
        inTok = estTokens("Reply with the single word: pong");
        outTok = estTokens(json.choices?.[0]?.message?.content ?? "");
      }
      const usd = computeCost(pcfg.pricing, inTok!, outTok!);
      console.log(
        `OK   ${id} model=${pcfg.model_id} latency=${latencyMs}ms tokens(in/out)=${inTok}/${outTok}${estimated ? "(estimated)" : ""} cost=$${usd}`,
      );
      return 0;
    } catch {
      console.error(`FAIL ${id}: HTTP 200 but unparseable body: ${(reply.bodyText ?? "").slice(0, 200)}`);
      return 1;
    }
  } catch (e) {
    const latencyMs = Math.round(performance.now() - t0);
    const err = e as Error;
    const why =
      err.name === "AbortError" || err.name === "TimeoutError"
        ? `no response within ${timeoutMs}ms (timeout)`
        : err.message;
    console.error(`FAIL ${id}: ${why} (${latencyMs}ms)`);
    return 1;
  }
}

async function main(): Promise<void> {
  const { provider, cfgPath } = args(process.argv.slice(2));
  if (!provider) {
    console.error("usage: npm run smoke -- <provider-id|all> [--config llm-gateway.json]");
    process.exit(2);
  }
  let cfg;
  try {
    cfg = loadConfig(cfgPath ?? configPath([]));
  } catch (e) {
    console.error((e as Error).message);
    process.exit(2);
  }

  const ids =
    provider === "all" ? Object.keys(cfg.providers) : provider in cfg.providers ? [provider] : null;
  if (!ids) {
    console.error(`unknown provider "${provider}". configured: ${Object.keys(cfg.providers).join(", ")}`);
    process.exit(2);
  }

  const timeoutMs = Math.max(cfg.connect_timeout_ms * 3, 20_000);
  let worst = 0;
  for (const id of ids!) {
    const code = await smokeProvider(id, cfg.providers[id]!, timeoutMs);
    worst = Math.max(worst, code);
  }
  process.exit(worst);
}

main();
