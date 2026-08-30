/**
 * Tests for src/gatewayctl.ts — the node half of the `gateway` shim.
 * Covers: connect printers (opencode/aider/claude-code), --write merge with
 * backup + preservation of existing keys, and `gateway report` — the honest
 * counterfactual-savings + work-delivered report wired over a real local
 * ledger (no running gateway needed).
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, appendFileSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  CliError,
  applyOpencodeMerge,
  connectInstructions,
  mergeOpencodeConfig,
  opencodeProviderBlock,
  opencodeConfigPath,
  runCli,
} from "../src/gatewayctl.ts";
import { buildBootstrapConfig } from "../src/bootstrap.ts";
import { cleanupDir, tmpDir } from "./helpers.ts";

const REPO_ROOT = join(import.meta.dirname, "..");
const KEY = "sk-lg-" + "ab".repeat(32);

const INFO = {
  key: KEY,
  host: "127.0.0.1",
  port: 8090,
  models: ["local-11434", "local-8081"],
};

describe("connect printers", () => {
  it("opencode: contains baseURL, the key, and each model id", () => {
    const text = connectInstructions("opencode", INFO);
    assert.match(text, /http:\/\/127\.0\.0\.1:8090\/v1/);
    assert.ok(text.includes(KEY), "printer must echo the generated gateway key");
    for (const m of INFO.models) assert.ok(text.includes(m), `missing model ${m}`);
    assert.match(text, /opencode\.json/);
  });

  it("aider: env-var instructions with baseURL + key", () => {
    const text = connectInstructions("aider", INFO);
    assert.match(text, /OPENAI_API_BASE=http:\/\/127\.0\.0\.1:8090\/v1/);
    assert.ok(text.includes(KEY));
  });

  it("claude-code: env-var instructions with base URL + token", () => {
    const text = connectInstructions("claude-code", INFO);
    assert.match(text, /ANTHROPIC_BASE_URL=http:\/\/127\.0\.0\.1:8090/);
    assert.ok(text.includes(KEY));
  });

  it("unknown tool names the supported tools", () => {
    assert.throws(
      () => connectInstructions("cursor", INFO),
      (e: unknown) => e instanceof CliError && /opencode/.test((e as Error).message),
    );
  });
});

describe("opencode --write merge", () => {
  it("provider block carries npm driver, baseURL and apiKey", () => {
    const block = opencodeProviderBlock(INFO) as Record<string, unknown>;
    const options = block.options as Record<string, string>;
    assert.equal(options.baseURL, "http://127.0.0.1:8090/v1");
    assert.equal(options.apiKey, KEY);
    assert.equal(block.npm, "@ai-sdk/openai-compatible");
    assert.ok(block.models && typeof block.models === "object");
  });

  it("merge preserves existing top-level keys and other providers, replaces only our block", () => {
    const existing = {
      $schema: "https://opencode.ai/config.json",
      theme: "opencode",
      provider: { openai: { options: { apiKey: "sk-other" } } },
      autoupdate: true,
    };
    const merged = mergeOpencodeConfig(existing, { npm: "@ai-sdk/openai-compatible" }) as Record<string, unknown>;
    assert.equal(merged.theme, "opencode");
    assert.equal(merged.autoupdate, true);
    assert.equal(merged.$schema, "https://opencode.ai/config.json");
    const providers = merged.provider as Record<string, unknown>;
    assert.ok(providers["openai"], "existing provider untouched");
    assert.deepEqual(providers["openai"], existing.provider.openai);
    assert.ok(providers["llm-gateway"], "gateway block added");

    // re-merge: our block is replaced wholesale, others still intact
    const merged2 = mergeOpencodeConfig(merged, { npm: "changed" }) as Record<string, unknown>;
    assert.deepEqual((merged2.provider as Record<string, unknown>)["llm-gateway"], { npm: "changed" });
    assert.ok(((merged2.provider as Record<string, unknown>)["openai"] as unknown) !== undefined);
  });

  it("applyOpencodeMerge backs up first (bak-pre-gateway-<ts>) and preserves existing keys", () => {
    const dir = tmpDir();
    try {
      mkdirSync(join(dir, ".config", "opencode"), { recursive: true });
      const cfgPath = join(dir, ".config", "opencode", "opencode.json");
      const original = JSON.stringify({ theme: "opencode", provider: { openai: { x: 1 } } });
      writeFileSync(cfgPath, original);
      const fixed = new Date(2026, 7, 29, 12, 34, 56);

      const { backupPath } = applyOpencodeMerge(cfgPath, INFO, () => fixed);
      assert.match(backupPath ?? "", /\.bak-pre-gateway-20260829-123456$/);
      assert.ok(existsSync(backupPath!), "backup must exist");
      assert.equal(readFileSync(backupPath!, "utf8"), original, "backup = pre-merge contents");

      const merged = JSON.parse(readFileSync(cfgPath, "utf8")) as { theme?: string; provider: Record<string, unknown> };
      assert.equal(merged.theme, "opencode", "existing keys preserved");
      assert.ok(merged.provider["openai"]);
      assert.ok(merged.provider["llm-gateway"]);
    } finally {
      cleanupDir(dir);
    }
  });

  it("applyOpencodeMerge creates the file when missing (no backup, still merges)", () => {
    const dir = tmpDir();
    try {
      const cfgPath = join(dir, "opencode.json");
      const { backupPath } = applyOpencodeMerge(cfgPath, INFO, () => new Date(2026, 0, 1));
      assert.equal(backupPath, null, "nothing to back up");
      const merged = JSON.parse(readFileSync(cfgPath, "utf8")) as { provider: Record<string, unknown> };
      assert.ok(merged.provider["llm-gateway"]);
    } finally {
      cleanupDir(dir);
    }
  });

  it("applyOpencodeMerge refuses JSONC/comments instead of corrupting the file", () => {
    const dir = tmpDir();
    try {
      const cfgPath = join(dir, "opencode.json");
      const jsonc = '{\n  // my comment\n  "theme": "opencode"\n}';
      writeFileSync(cfgPath, jsonc);
      assert.throws(
        () => applyOpencodeMerge(cfgPath, INFO, () => new Date()),
        (e: unknown) => e instanceof CliError && /not valid JSON/i.test((e as Error).message),
      );
      assert.equal(readFileSync(cfgPath, "utf8"), jsonc, "file untouched on failure");
      assert.ok(!existsSync(cfgPath + ".bak-pre-gateway-20260829-000000"));
    } finally {
      cleanupDir(dir);
    }
  });

  it("opencodeConfigPath honors XDG_CONFIG_HOME", () => {
    const prev = process.env.XDG_CONFIG_HOME;
    try {
      process.env.XDG_CONFIG_HOME = "/tmp/fake-xdg";
      assert.equal(opencodeConfigPath(), "/tmp/fake-xdg/opencode/opencode.json");
      delete process.env.XDG_CONFIG_HOME;
      const p = opencodeConfigPath();
      assert.ok(p.endsWith("opencode/opencode.json") && p.startsWith("/"), p);
    } finally {
      if (prev === undefined) delete process.env.XDG_CONFIG_HOME;
      else process.env.XDG_CONFIG_HOME = prev;
    }
  });
});

describe("gatewayctl CLI wiring", () => {
  const node = process.execPath;
  const script = join(REPO_ROOT, "src", "gatewayctl.ts");
  const baseArgs = ["--disable-warning=ExperimentalWarning", "--experimental-strip-types", script];

  it("connect opencode prints the config's key and baseURL (reads installed config)", () => {
    const dir = tmpDir();
    try {
      const cfgPath = join(dir, "llm-gateway.json");
      writeFileSync(
        cfgPath,
        JSON.stringify(
          buildBootstrapConfig({
            adminKey: "a".repeat(64),
            gatewayKey: KEY,
            storageDir: join(dir, "storage"),
            runtimes: [{ port: 11434, name: null, models: ["qwen3:8b"] }],
          }),
        ),
      );
      const stdout = execFileSync(node, [...baseArgs, "--config", cfgPath, "connect", "opencode"], {
        encoding: "utf8",
        timeout: 30_000,
      });
      assert.ok(stdout.includes(KEY));
      assert.match(stdout, /http:\/\/127\.0\.0\.1:8090\/v1/);
    } finally {
      cleanupDir(dir);
    }
  });

  it("report is wired via runCli (rendered against a real local ledger — see the gateway report describe)", async () => {
    // The old admin-endpoint stub test is gone: `gateway report` now reads the
    // ledger directly and never needs a running gateway. Coverage lives in the
    // "gateway report" describe below.
    await assert.rejects(
      () => runCli(["--config", join(REPO_ROOT, "test", "does-not-exist.json"), "report"]),
      (e: unknown) => e instanceof CliError && /config not found/.test((e as Error).message),
    );
  });

  it("runCli rejects unknown commands and connect without a tool", async () => {
    await assert.rejects(() => runCli(["bogus"]), /usage/i);
    await assert.rejects(() => runCli(["connect"]), /opencode|aider|claude-code/);
  });
});

/**
 * `gateway report` — honest savings + work-delivered receipt, rendered from a
 * real JSONL ledger on disk. The synthetic workload is built so every honesty
 * rule is visible in ONE render:
 *  - ds rows (deepseek-v4-flash, verified list price) carry the counterfactuals
 *  - a glm-4.6 row is EXCLUDED from cf math (unverified price) with a warning
 *  - a local row is excluded from cf math and shown in the split
 *  - a zplan row ($0/$0 config pricing, cloud host) forces the plan notice
 *  - a July row proves --month filtering
 * Baseline is inline premium-ref ($3 in / $9 out per Mtok) so savings are big
 * and unambiguous.
 */
describe("gateway report (replaces the admin-endpoint stub)", () => {
  const M = 1_000_000;

  interface Fixture {
    dir: string;
    cfgPath: string;
    storage: string;
  }

  /** Write config + ledger; rows chosen for the honesty rules above. */
  function fixture(): Fixture {
    const dir = tmpDir();
    const storage = join(dir, "storage");
    mkdirSync(storage, { recursive: true });
    const cfgPath = join(dir, "llm-gateway.json");
    writeFileSync(
      cfgPath,
      JSON.stringify({
        port: 8090,
        host: "127.0.0.1",
        storage_dir: storage,
        providers: {
          ds: {
            type: "openai",
            base_url: "https://api.deepseek.com/v1",
            model_id: "deepseek-v4-flash",
            pricing: { input_per_mtok: 0.22, output_per_mtok: 0.66 },
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
          zplan: {
            type: "openai",
            base_url: "https://plan.example.com/v1",
            model_id: "deepseek-v4-flash",
            pricing: { input_per_mtok: 0, output_per_mtok: 0 },
            task_classes: ["bulk"],
          },
        },
        keys: { [KEY]: { project: "sandbox" } },
        routing: { default: ["ds"] },
        budgets: {},
        report: { baseline: { model: "premium-ref", input_per_mtok: 3, output_per_mtok: 9 } },
      }),
    );
    const rows: Array<Record<string, unknown>> = [
      {
        ts: "2026-08-10T10:00:00.000Z",
        project: "sandbox",
        provider: "ds",
        model: "deepseek-v4-flash",
        task_class: "bulk",
        input_tokens: M,
        output_tokens: M,
        usd: 0.88,
        latency_ms: 500,
        stream: true,
        stream_ms: 600_000,
        fallback_used: false,
        attempts: 1,
        ttfb_ms: 100,
      },
      {
        ts: "2026-08-11T10:00:00.000Z",
        project: "proj-b",
        provider: "ds",
        model: "deepseek-v4-flash",
        task_class: "bulk",
        input_tokens: 2 * M,
        output_tokens: 500_000,
        usd: 0.77,
        latency_ms: 400,
        stream: false,
        fallback_used: false,
        attempts: 1,
        ttfb_ms: 60,
      },
      {
        ts: "2026-08-12T10:00:00.000Z",
        project: "sandbox",
        provider: "glm",
        model: "glm-4.6",
        task_class: "long-run",
        input_tokens: M,
        output_tokens: M,
        usd: 2.8,
        latency_ms: 300,
        stream: false,
        fallback_used: false,
        attempts: 2,
      },
      {
        ts: "2026-08-13T10:00:00.000Z",
        project: "sandbox",
        provider: "local",
        model: "qwen3:8b",
        task_class: "autocomplete",
        input_tokens: 2 * M,
        output_tokens: 2 * M,
        usd: 0,
        latency_ms: 90,
        stream: false,
        fallback_used: false,
        attempts: 1,
      },
      {
        ts: "2026-08-14T10:00:00.000Z",
        project: "sandbox",
        provider: "zplan",
        model: "deepseek-v4-flash",
        task_class: "bulk",
        input_tokens: M,
        output_tokens: M,
        usd: 0,
        latency_ms: 200,
        stream: false,
        fallback_used: false,
        attempts: 1,
      },
      {
        ts: "2026-07-05T10:00:00.000Z",
        project: "sandbox",
        provider: "ds",
        model: "deepseek-v4-flash",
        task_class: "bulk",
        input_tokens: 1000,
        output_tokens: 1000,
        usd: 0.01,
        latency_ms: 100,
        stream: false,
        fallback_used: false,
        attempts: 1,
      },
    ];
    for (const r of rows) appendFileSync(join(storage, "usage.jsonl"), JSON.stringify(r) + "\n");
    return { dir, cfgPath, storage };
  }

  async function captureStdout(fn: () => Promise<void>): Promise<string> {
    const lines: string[] = [];
    const orig = console.log;
    console.log = (...a: unknown[]) => {
      lines.push(a.map(String).join(" "));
    };
    try {
      await fn();
    } finally {
      console.log = orig;
    }
    return lines.join("\n");
  }

  it("terminal render includes savings, work delivered, assumptions, warnings", async () => {
    const fx = fixture();
    try {
      const out = await captureStdout(() =>
        runCli(["--config", fx.cfgPath, "report", "--month", "2026-08"]),
      );
      // header + baseline provenance
      assert.match(out, /2026-08/);
      assert.match(out, /premium-ref/);
      assert.match(out, /operator: llm-gateway\.json report\.baseline/);
      // per-project table + totals
      assert.match(out, /proj-b/);
      assert.match(out, /sandbox/);
      assert.match(out, /TOTALS/);
      // savings lines with their numbers (cfB − cfA = 34.5 − 2.53; cfB − actual = 34.5 − 1.65)
      assert.match(out, /31\.97/, "routing/cache savings (B−A)");
      assert.match(out, /32\.85/, "total savings (B−actual)");
      // work delivered block
      assert.match(out, /Work delivered/i);
      assert.match(out, /5,500,000/, "output tokens");
      assert.match(out, /0\.2 h/, "stream hours at 1 decimal");
      assert.match(out, /100\.0%/);
      assert.match(out, /fallbacks survived/i);
      assert.match(out, /local 1 req/, "local-vs-cloud split");
      assert.match(out, /cloud 4 req/);
      assert.match(out, /ds 80\/98/, "ttfb p50/p95 per provider");
      // assumptions ride along with the numbers
      assert.match(out, /Assumptions/i);
      assert.match(out, /full input rate/);
      assert.match(out, /OVERestimated/i);
      assert.match(out, /Counterfactual A/);
      assert.match(out, /Counterfactual B/);
      // plan honesty + unverified exclusion surface in the render
      assert.match(out, /LIST-PRICE VALUE AVOIDED/);
      assert.match(out, /not cash/i);
      assert.match(out, /unverified pricing/i);
      assert.match(out, /glm-4\.6/);
    } finally {
      cleanupDir(fx.dir);
    }
  });

  it("--json prints the machine-readable report (full honesty fields intact)", async () => {
    const fx = fixture();
    try {
      const out = await captureStdout(() =>
        runCli(["--config", fx.cfgPath, "report", "--month", "2026-08", "--json"]),
      );
      const report = JSON.parse(out) as {
        month: string;
        project: string;
        counterfactual: {
          scope_requests: number;
          total_savings_usd: number;
          routing_cache_savings_usd: number;
          plan_requests: number;
          plan_value_avoided_usd: number;
          plan_notice: string | null;
        };
        work: { agent_turns: number; output_tokens: number; stream_hours: number; reliability_pct: number | null };
        projects: Array<{ project: string }>;
        warnings: string[];
        assumptions: string[];
      };
      assert.equal(report.month, "2026-08");
      assert.equal(report.project, "*");
      assert.equal(report.counterfactual.scope_requests, 3);
      assert.equal(report.counterfactual.plan_requests, 1);
      assert.equal(report.counterfactual.plan_value_avoided_usd, 0.88);
      assert.ok(report.counterfactual.plan_notice);
      assert.ok(Math.abs(report.counterfactual.routing_cache_savings_usd - 31.97) < 5e-9);
      assert.ok(Math.abs(report.counterfactual.total_savings_usd - 32.85) < 5e-9);
      assert.equal(report.work.agent_turns, 5);
      assert.equal(report.work.output_tokens, 5.5 * M);
      assert.equal(report.work.stream_hours, 0.2);
      assert.equal(report.work.reliability_pct, 100);
      assert.deepEqual(report.projects.map((p) => p.project), ["proj-b", "sandbox"]);
      assert.equal(report.warnings.length, 1, "exactly the glm-4.6 unverified warning");
      assert.match(report.warnings[0]!, /glm-4\.6/);
      assert.ok(report.assumptions.length >= 5);
    } finally {
      cleanupDir(fx.dir);
    }
  });

  it("--html writes a self-contained inline-styled receipt", async () => {
    const fx = fixture();
    try {
      const htmlPath = join(fx.dir, "receipt.html");
      const out = await captureStdout(() =>
        runCli(["--config", fx.cfgPath, "report", "--month", "2026-08", "--json", "--html", htmlPath]),
      );
      JSON.parse(out); // --json still prints; --html additionally writes the file
      assert.ok(existsSync(htmlPath), "receipt written");
      const html = readFileSync(htmlPath, "utf8");
      assert.match(html, /<!doctype html>/i);
      assert.match(html, /<style>/, "styling is inline in the file");
      assert.ok(!/src="http/i.test(html) && !/href="http/i.test(html), "no external resources");
      assert.ok(html.trimEnd().endsWith("</html>"));
      assert.match(html, /2026-08/);
      assert.match(html, /32\.85/);
      assert.match(html, /glm-4\.6/, "warnings render in the receipt");
      assert.match(html, /LIST-PRICE VALUE AVOIDED/);
      assert.match(html, /Work delivered/i);
    } finally {
      cleanupDir(fx.dir);
    }
  });

  it("--month 2026-07 isolates the July row", async () => {
    const fx = fixture();
    try {
      const out = await captureStdout(() =>
        runCli(["--config", fx.cfgPath, "report", "--month", "2026-07", "--json"]),
      );
      const report = JSON.parse(out) as {
        month: string;
        work: { agent_turns: number };
        counterfactual: { scope_requests: number };
      };
      assert.equal(report.month, "2026-07");
      assert.equal(report.work.agent_turns, 1);
      assert.equal(report.counterfactual.scope_requests, 1);
    } finally {
      cleanupDir(fx.dir);
    }
  });

  it("--project proj-b scopes everything to that project", async () => {
    const fx = fixture();
    try {
      const out = await captureStdout(() =>
        runCli(["--config", fx.cfgPath, "report", "--month", "2026-08", "--project", "proj-b", "--json"]),
      );
      const report = JSON.parse(out) as {
        project: string;
        totals: { requests: number };
        projects: Array<{ project: string }>;
      };
      assert.equal(report.project, "proj-b");
      assert.equal(report.totals.requests, 1);
      assert.deepEqual(report.projects.map((p) => p.project), ["proj-b"]);
    } finally {
      cleanupDir(fx.dir);
    }
  });

  it("bad report flags are rejected with a usage error", async () => {
    const fx = fixture();
    try {
      await assert.rejects(
        () => runCli(["--config", fx.cfgPath, "report", "--month", "2026-13"]),
        (e: unknown) => e instanceof CliError && /YYYY-MM/.test((e as Error).message),
      );
      await assert.rejects(
        () => runCli(["--config", fx.cfgPath, "report", "--bogus"]),
        (e: unknown) => e instanceof CliError && /unknown (report )?flag/.test((e as Error).message),
      );
      await assert.rejects(
        () => runCli(["--config", fx.cfgPath, "report", "--html"]),
        (e: unknown) => e instanceof CliError && /--html/.test((e as Error).message),
      );
      await assert.rejects(
        () => runCli(["--config", fx.cfgPath, "report", "--project"]),
        (e: unknown) => e instanceof CliError && /--project/.test((e as Error).message),
      );
    } finally {
      cleanupDir(fx.dir);
    }
  });
});
