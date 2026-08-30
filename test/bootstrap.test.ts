/**
 * RED-first tests for src/bootstrap.ts — fresh-install config generation.
 * Covers: generated config passes loadConfig, 256-bit unique keys,
 * refuse-overwrite, local-runtime detection with injected fetch (no network),
 * and the CLI entrypoint used by install.sh.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import {
  BootstrapError,
  DEFAULT_PROBE_PORTS,
  buildBootstrapConfig,
  detectLocalRuntimes,
  generateAdminKey,
  generateGatewayKey,
  writeBootstrapConfig,
} from "../src/bootstrap.ts";
import { loadConfig } from "../src/config.ts";
import { cleanupDir, tmpDir } from "./helpers.ts";

const REPO_ROOT = join(import.meta.dirname, "..");

function runtime(port: number, models: string[]) {
  return { port, name: null as string | null, models };
}

/** Minimal fetch stub matching the FetchLike shape bootstrap accepts. */
function fetchOf(responses: Record<number, unknown | "garbage">) {
  const calls: string[] = [];
  const fn = (url: string, _init?: { signal?: AbortSignal }) => {
    calls.push(url);
    const port = Number(new URL(url).port);
    const body = responses[port];
    return Promise.resolve({
      ok: body !== undefined,
      status: body !== undefined ? 200 : 0,
      json: () =>
        body === "garbage" ? Promise.reject(new Error("bad json")) : Promise.resolve(body),
    });
  };
  return { fn: fn as typeof fetch, calls };
}

describe("bootstrap key generation", () => {
  it("generates 256-bit admin keys (64 hex chars)", () => {
    const k = generateAdminKey();
    assert.match(k, /^[0-9a-f]{64}$/, "admin key must be 64 hex chars (256-bit)");
  });

  it("generates sk-lg- prefixed gateway keys with 256 bits of entropy", () => {
    const k = generateGatewayKey();
    assert.match(k, /^sk-lg-[0-9a-f]{64}$/);
  });

  it("generates unique keys across many runs", () => {
    const admins = new Set(Array.from({ length: 200 }, () => generateAdminKey()));
    const gateways = new Set(Array.from({ length: 200 }, () => generateGatewayKey()));
    assert.equal(admins.size, 200, "admin keys must be unique");
    assert.equal(gateways.size, 200, "gateway keys must be unique");
  });
});

describe("buildBootstrapConfig", () => {
  it("produces a config that passes loadConfig unchanged (with a detected runtime)", () => {
    const dir = tmpDir();
    try {
      const out = join(dir, "cfg.json");
      const cfgObj = buildBootstrapConfig({
        adminKey: generateAdminKey(),
        gatewayKey: generateGatewayKey(),
        storageDir: join(dir, "storage"),
        runtimes: [runtime(11434, ["qwen3:8b", "llama3:latest"])],
      });
      writeBootstrapConfig(out, cfgObj);
      const cfg = loadConfig(out); // must not throw
      assert.equal(cfg.port, 8090);
      assert.equal(cfg.host, "127.0.0.1");
      // local provider entry derived from the detected runtime
      assert.ok(cfg.providers["local-11434"], "detected runtime becomes a provider");
      const p = cfg.providers["local-11434"]!;
      assert.equal(p.base_url, "http://127.0.0.1:11434/v1");
      assert.equal(p.model_id, "qwen3:8b", "model_id = first reported model");
      assert.deepEqual(p.pricing, { input_per_mtok: 0, output_per_mtok: 0 });
      assert.ok(p.task_classes!.includes("autocomplete"));
      // routing only references known providers
      assert.ok(Array.isArray(cfg.routing["default"]));
      assert.equal((cfg.routing["default"] as string[])[0], "local-11434");
      // exactly one gateway key, project set
      const keyIds = Object.keys(cfg.keys);
      assert.equal(keyIds.length, 1);
      assert.match(keyIds[0]!, /^sk-lg-[0-9a-f]{64}$/);
      assert.ok(cfg.keys[keyIds[0]!]!.project.length > 0);
      // admin key present
      assert.ok(cfg.admin_key && cfg.admin_key.length > 0);
    } finally {
      cleanupDir(dir);
    }
  });

  it("falls back to the in-process mock provider when nothing is detected (config still valid)", () => {
    const dir = tmpDir();
    try {
      const out = join(dir, "cfg.json");
      writeBootstrapConfig(
        out,
        buildBootstrapConfig({
          adminKey: generateAdminKey(),
          gatewayKey: generateGatewayKey(),
          storageDir: join(dir, "storage"),
          runtimes: [],
        }),
      );
      const cfg = loadConfig(out);
      assert.ok(cfg.providers["mock-local"], "mock fallback present so routing.default resolves");
      assert.equal((cfg.routing["default"] as string[])[0], "mock-local");
    } finally {
      cleanupDir(dir);
    }
  });

  it("chains multiple detected runtimes in port order (ascending — local-1234 < local-11434)", () => {
    const cfgObj = buildBootstrapConfig({
      adminKey: "a".repeat(64),
      gatewayKey: "sk-lg-" + "b".repeat(64),
      storageDir: "/tmp/x",
      runtimes: [runtime(11434, ["m-ollama"]), runtime(1234, ["m-studio"])],
    }) as { routing: Record<string, string[]> };
    assert.deepEqual(cfgObj.routing["default"], ["local-1234", "local-11434"], "port-ascending");
  });
});

describe("writeBootstrapConfig", () => {
  it("refuses to overwrite an existing config and leaves the file untouched", () => {
    const dir = tmpDir();
    try {
      const out = join(dir, "llm-gateway.json");
      writeBootstrapConfig(out, { marker: 1 });
      const before = readFileSync(out, "utf8");
      assert.throws(
        () => writeBootstrapConfig(out, { marker: 2 }),
        (e: unknown) => e instanceof BootstrapError && /refus/i.test((e as Error).message),
      );
      assert.equal(readFileSync(out, "utf8"), before, "existing config untouched");
    } finally {
      cleanupDir(dir);
    }
  });

  it("creates the config with 0600 perms (it holds gateway keys)", () => {
    const dir = tmpDir();
    try {
      const out = join(dir, "nested", "cfg.json");
      writeBootstrapConfig(out, { marker: 1 });
      assert.equal(statSync(out).mode & 0o777, 0o600);
    } finally {
      cleanupDir(dir);
    }
  });
});

describe("detectLocalRuntimes", () => {
  it("probes only the given ports and reports hits with their first model", async () => {
    const { fn, calls } = fetchOf({
      8081: { object: "list", data: [{ id: "qwen3-8b-q4" }, { id: "other" }] },
      11434: "garbage", // JSON parse failure = miss
      1234: { nope: true }, // unexpected shape = miss
    });
    const found = await detectLocalRuntimes({
      ports: [11434, 1234, 8081, 9999],
      fetchImpl: fn,
      timeoutMs: 50,
    });
    assert.equal(found.length, 1);
    assert.equal(found[0]!.port, 8081);
    // model ids come back sorted (first one becomes the provider's model_id)
    assert.deepEqual(found[0]!.models, ["other", "qwen3-8b-q4"]);
    assert.deepEqual(calls.sort(), [8081, 9999, 11434, 1234].map((p) => `http://127.0.0.1:${p}/v1/models`).sort());
  });

  it("treats fetch rejections and non-ok responses as silent misses", async () => {
    const fn = ((url: string) => {
      const port = Number(new URL(url).port);
      if (port === 1) return Promise.reject(new Error("ECONNREFUSED"));
      if (port === 2) return Promise.resolve({ ok: false, status: 500, json: () => Promise.resolve({}) });
      return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve({ data: [{ id: "m" }] }) });
    }) as unknown as typeof fetch;
    const found = await detectLocalRuntimes({ ports: [1, 2, 3], fetchImpl: fn, timeoutMs: 50 });
    assert.equal(found.length, 1);
    assert.equal(found[0]!.port, 3);
  });

  it("default probe list covers ollama, llama.cpp and LM Studio ports, with no network when ports injected", async () => {
    assert.deepEqual([...DEFAULT_PROBE_PORTS].sort((a, b) => a - b), [1234, 8081, 8082, 11434]);
    let external = false;
    const fn = ((url: string) => {
      if (!url.startsWith("http://127.0.0.1:")) external = true;
      return Promise.reject(new Error("down"));
    }) as unknown as typeof fetch;
    const found = await detectLocalRuntimes({ ports: [1], fetchImpl: fn, timeoutMs: 10 });
    assert.deepEqual(found, []);
    assert.ok(!external, "injected ports must be the only traffic targets");
  });
});

describe("bootstrap CLI (install.sh entrypoint)", () => {
  const node = process.execPath;
  const script = join(REPO_ROOT, "src", "bootstrap.ts");
  const args = ["--disable-warning=ExperimentalWarning", "--experimental-strip-types", script];

  it("generates a valid config and prints the gateway key", () => {
    const dir = tmpDir();
    try {
      const out = join(dir, "llm-gateway.json");
      const stdout = execFileSync(node, [...args, "--out", out], { encoding: "utf8", timeout: 30_000 });
      assert.match(stdout, /sk-lg-[0-9a-f]{64}/, "CLI prints the generated gateway key");
      assert.ok(existsSync(out));
      assert.doesNotThrow(() => loadConfig(out));
      // config file must not be group/world readable
      assert.equal(statSync(out).mode & 0o077, 0);
    } finally {
      cleanupDir(dir);
    }
  });

  it("refuses a second run against the same --out (never overwrites)", () => {
    const dir = tmpDir();
    try {
      const out = join(dir, "llm-gateway.json");
      execFileSync(node, [...args, "--out", out], { encoding: "utf8", timeout: 30_000 });
      let failed = false;
      try {
        execFileSync(node, [...args, "--out", out], { encoding: "utf8", timeout: 30_000 });
      } catch (e) {
        failed = true;
        const err = e as { stderr?: string; status?: number };
        assert.notEqual(err.status, 0);
        assert.match(err.stderr ?? "", /refus/i);
      }
      assert.ok(failed, "second bootstrap run must fail");
    } finally {
      cleanupDir(dir);
    }
  });

  it("requires --out", () => {
    assert.throws(
      () => execFileSync(node, args, { encoding: "utf8", timeout: 30_000, stdio: "pipe" }),
      (e: unknown) => (e as { status?: number }).status !== 0,
    );
  });
});
