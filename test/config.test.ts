/**
 * RED-first tests for config loading/validation, including the shipped example config.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { chmodSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { ConfigError, configFilePermWarning, loadConfig } from "../src/config.ts";
import { cleanupDir, tmpDir } from "./helpers.ts";

function writeCfg(dir: string, obj: unknown): string {
  const p = join(dir, "cfg.json");
  writeFileSync(p, JSON.stringify(obj));
  return p;
}

const VALID = {
  providers: {
    p1: {
      type: "openai",
      base_url: "https://api.example.com/v1",
      api_key_env: "EXAMPLE_API_KEY",
      model_id: "m1",
      pricing: { input_per_mtok: 1, output_per_mtok: 2 },
      task_classes: ["bulk"],
    },
  },
  keys: { k1: { project: "proj" } },
  routing: { default: ["p1"] },
};

describe("loadConfig", () => {
  it("accepts the shipped config.example.json unchanged", () => {
    const cfg = loadConfig(join(import.meta.dirname, "..", "config.example.json"));
    assert.ok(Object.keys(cfg.providers).length >= 5);
    assert.ok(Array.isArray(cfg.routing["agentic-coding"]));
    // bulk demonstrates the object routing form; peak chain still leads with deepseek-flash
    const bulk = cfg.routing["bulk"]!;
    assert.ok(!Array.isArray(bulk), "example routing.bulk uses the object { chain, off_peak_chain } form");
    assert.equal(bulk.chain[0], "deepseek-flash");
    // provider keys must be env var NAMES, never literals
    for (const p of Object.values(cfg.providers)) {
      if ((p as { type?: string }).type === "mock") continue;
      if ("api_key_env" in p) {
        const v = (p as { api_key_env?: string }).api_key_env ?? "";
        assert.ok(!/sk-|secret|key=/i.test(v), `provider key literal leaked into config: ${v}`);
      }
    }
  });

  it("applies defaults for omitted fields", () => {
    const dir = tmpDir();
    try {
      const cfg = loadConfig(writeCfg(dir, VALID));
      assert.equal(cfg.port, 8090);
      assert.ok(cfg.storage_dir.length > 0);
      assert.equal(cfg.max_retries_per_provider, 2);
    } finally {
      cleanupDir(dir);
    }
  });

  it("reports ALL validation problems at once", () => {
    const dir = tmpDir();
    try {
      const p = writeCfg(dir, {
        port: "http",
        providers: { bad: { model_id: "x", pricing: { input_per_mtok: "a", output_per_mtok: 1 }, task_classes: [] } },
        keys: {},
        routing: { bulk: ["ghost"], default: ["ghost"] },
      });
      let err: unknown;
      try {
        loadConfig(p);
      } catch (e) {
        err = e;
      }
      assert.ok(err instanceof ConfigError);
      const msg = (err as Error).message;
      assert.match(msg, /port/);
      assert.match(msg, /providers\.bad\.base_url/);
      assert.match(msg, /providers\.bad\.pricing/);
      assert.match(msg, /keys/);
      assert.match(msg, /routing\.bulk.*unknown provider "ghost"/);
      // all issues in ONE error, not fail-first
      assert.ok(msg.split("\n").length > 4);
    } finally {
      cleanupDir(dir);
    }
  });

  it("rejects a missing default chain", () => {
    const dir = tmpDir();
    try {
      const p = writeCfg(dir, { ...VALID, routing: { bulk: ["p1"] } });
      assert.throws(() => loadConfig(p), /default/);
    } finally {
      cleanupDir(dir);
    }
  });

  it("rejects provider keys written literally in api_key_env-looking places? no — but requires base_url for openai type", () => {
    const dir = tmpDir();
    try {
      const p = writeCfg(dir, {
        ...VALID,
        providers: { p1: { model_id: "m", pricing: { input_per_mtok: 1, output_per_mtok: 1 }, task_classes: [] } },
      });
      assert.throws(() => loadConfig(p), /base_url/);
    } finally {
      cleanupDir(dir);
    }
  });

  it("allows mock-type providers without base_url or api_key_env", () => {
    const dir = tmpDir();
    try {
      const p = writeCfg(dir, {
        ...VALID,
        providers: {
          m: { type: "mock", model_id: "mm", pricing: { input_per_mtok: 0, output_per_mtok: 0 }, task_classes: [] },
        },
        routing: { default: ["m"] },
      });
      const cfg = loadConfig(p);
      assert.equal(cfg.providers["m"]!.type, "mock");
    } finally {
      cleanupDir(dir);
    }
  });

  describe("Finding 2: provider-id prefix collisions", () => {
    // "openai-eu" is invalid; "openai" is fully valid but its id is a string
    // prefix of the invalid one. The old prefix-matching issue check dropped
    // "openai" silently, which then surfaced as a bogus
    // `routing.default: references unknown provider "openai"` line.
    it("reports only the invalid provider's problems and keeps the valid one usable", () => {
      const dir = tmpDir();
      try {
        const p = writeCfg(dir, {
          providers: {
            "openai-eu": {
              type: "openai",
              model_id: "eu-model",
              pricing: { input_per_mtok: 1, output_per_mtok: 2 },
              task_classes: ["bulk"],
              // base_url missing -> the ONLY problem in this config
            },
            openai: {
              type: "openai",
              base_url: "https://api.openai.com/v1",
              api_key_env: "OPENAI_API_KEY",
              model_id: "gpt-model",
              pricing: { input_per_mtok: 1, output_per_mtok: 2 },
              task_classes: [],
            },
          },
          keys: { k: { project: "p" } },
          routing: { default: ["openai"] },
        });
        let err: unknown;
        try {
          loadConfig(p);
        } catch (e) {
          err = e;
        }
        assert.ok(err instanceof ConfigError);
        const msg = (err as Error).message;
        assert.match(msg, /providers\.openai-eu\.base_url/); // real problem named…
        assert.doesNotMatch(msg, /unknown provider "openai"/); // …no prefix-collision fallout
        assert.equal(msg.includes("providers.openai:"), false);
      } finally {
        cleanupDir(dir);
      }
    });

    it("valid provider survives into cfg.providers once the invalid superstring-prefix sibling is removed", () => {
      const dir = tmpDir();
      try {
        const p = writeCfg(dir, {
          providers: {
            openai: {
              type: "openai",
              base_url: "https://api.openai.com/v1",
              api_key_env: "OPENAI_API_KEY",
              model_id: "gpt-model",
              pricing: { input_per_mtok: 1, output_per_mtok: 2 },
              task_classes: [],
            },
          },
          keys: { k: { project: "p" } },
          routing: { default: ["openai"] },
        });
        const cfg = loadConfig(p);
        assert.ok(cfg.providers["openai"], `"openai" must survive validation`);
      } finally {
        cleanupDir(dir);
      }
    });
  });

  describe("Finding 3: literal secrets rejected", () => {
    it('rejects unknown provider fields; for api_key/token suggests api_key_env without echoing values', () => {
      const dir = tmpDir();
      try {
        const p = writeCfg(dir, {
          ...VALID,
          providers: {
            p1: {
              type: "openai",
              base_url: "https://api.example.com/v1",
              api_key: "sk-live-SUPERSECRETVALUE123", // pragma: allowlist secret — fixture: validator must reject this
              temperature_cap: 7, // plain unknown field — also rejected
              model_id: "m1",
              pricing: { input_per_mtok: 1, output_per_mtok: 2 },
              task_classes: [],
            },
          },
        });
        let err: unknown;
        try {
          loadConfig(p);
          throw new Error("expected ConfigError, got successful load");
        } catch (e) {
          err = e;
        }
        assert.ok(err instanceof ConfigError);
        const msg = (err as Error).message;
        assert.match(msg, /unknown field "api_key"/);
        assert.match(msg, /did you mean api_key_env\?/i);
        assert.match(msg, /unknown field "temperature_cap"/);
        // the secret VALUE must never be echoed into the error/log surface
        assert.ok(!msg.includes("SUPERSECRETVALUE123"), "error message leaked the secret value");
      } finally {
        cleanupDir(dir);
      }
    });
  });

  describe("Finding 5: api_key_env must be an env-var NAME, never key material", () => {
    it("rejects a literal key pasted into api_key_env (would silently lose auth)", () => {
      const dir = tmpDir();
      try {
        const p = writeCfg(dir, {
          ...VALID,
          providers: {
            p1: {
              type: "openai",
              base_url: "https://api.example.com/v1",
              api_key_env: "sk-live-SUPERSECRETVALUE123", // pragma: allowlist secret — fixture: validator must reject this
              model_id: "m1",
              pricing: { input_per_mtok: 1, output_per_mtok: 2 },
              task_classes: [],
            },
          },
        });
        let err: unknown;
        try {
          loadConfig(p);
          throw new Error("expected ConfigError, got successful load");
        } catch (e) {
          err = e;
        }
        assert.ok(err instanceof ConfigError);
        const msg = (err as Error).message;
        assert.match(msg, /api_key_env/);
        assert.match(msg, /NAME of an environment variable/i);
        assert.match(msg, /did you paste a secret\?/i);
        // key-shaped values must never be echoed back into the error surface
        assert.ok(!msg.includes("SUPERSECRETVALUE123"), "error message leaked the pasted key");
      } finally {
        cleanupDir(dir);
      }
    });

    it("rejects non-name shapes (hyphens, spaces, leading digit)", () => {
      const dir = tmpDir();
      try {
        for (const bad of ["MY-KEY", "MY KEY", "1PASTED", "deepseek key!"]) {
          const p = writeCfg(dir, {
            ...VALID,
            providers: {
              p1: {
                type: "openai",
                base_url: "https://api.example.com/v1",
                api_key_env: bad,
                model_id: "m1",
                pricing: { input_per_mtok: 1, output_per_mtok: 2 },
                task_classes: [],
              },
            },
          });
          assert.throws(() => loadConfig(p), ConfigError, `expected rejection for ${JSON.stringify(bad)}`);
        }
      } finally {
        cleanupDir(dir);
      }
    });

    it("still loads valid env-var names, including lowercase (POSIX allows them)", () => {
      const dir = tmpDir();
      try {
        const p = writeCfg(dir, {
          ...VALID,
          providers: {
            upper: { ...VALID.providers.p1, api_key_env: "EXAMPLE_API_KEY" },
            lower: { ...VALID.providers.p1, api_key_env: "my_provider_key" },
            underscore: { ...VALID.providers.p1, api_key_env: "_hidden_fallback_2" },
          },
          routing: { default: ["upper"] },
        });
        const cfg = loadConfig(p);
        assert.equal(cfg.providers["lower"]!.api_key_env, "my_provider_key");
        assert.equal(cfg.providers["upper"]!.api_key_env, "EXAMPLE_API_KEY");
        assert.equal(cfg.providers["underscore"]!.api_key_env, "_hidden_fallback_2");
      } finally {
        cleanupDir(dir);
      }
    });
  });

  describe("provider capabilities", () => {
    it("accepts valid capabilities blocks (full, partial, empty, absent)", () => {
      const dir = tmpDir();
      try {
        const p = writeCfg(dir, {
          ...VALID,
          providers: {
            full: { ...VALID.providers.p1, capabilities: { vision: true, tools: true, reasoning: false } },
            partial: { ...VALID.providers.p1, capabilities: { vision: true } },
            empty: { ...VALID.providers.p1, capabilities: {} },
            absent: { ...VALID.providers.p1 }, // no capabilities key at all
          },
          routing: { default: ["full"] },
        });
        const cfg = loadConfig(p);
        assert.deepEqual(cfg.providers["full"]!.capabilities, { vision: true, tools: true, reasoning: false });
        assert.deepEqual(cfg.providers["partial"]!.capabilities, { vision: true });
        assert.deepEqual(cfg.providers["empty"]!.capabilities, {});
        assert.equal(cfg.providers["absent"]!.capabilities, undefined);
      } finally {
        cleanupDir(dir);
      }
    });

    it("rejects mistyped capability values (vision: \"yes\") with the strict error style", () => {
      const dir = tmpDir();
      try {
        const p = writeCfg(dir, {
          ...VALID,
          providers: {
            p1: { ...VALID.providers.p1, capabilities: { vision: "yes" } },
          },
        });
        let err: unknown;
        try {
          loadConfig(p);
          throw new Error("expected ConfigError, got successful load");
        } catch (e) {
          err = e;
        }
        assert.ok(err instanceof ConfigError);
        const msg = (err as Error).message;
        assert.match(msg, /providers\.p1\.capabilities\.vision: expected boolean/);
        assert.match(msg, /"yes"/);
      } finally {
        cleanupDir(dir);
      }
    });

    it("rejects unknown capability fields and a non-object capabilities block", () => {
      const dir = tmpDir();
      try {
        const bad1 = writeCfg(dir, {
          ...VALID,
          providers: { p1: { ...VALID.providers.p1, capabilities: { vision: true, omnipotent: true } } },
        });
        assert.throws(() => loadConfig(bad1), /capabilities: unknown field "omnipotent"/);
        const bad2 = writeCfg(dir, {
          ...VALID,
          providers: { p1: { ...VALID.providers.p1, capabilities: "vision-capable" } },
        });
        assert.throws(() => loadConfig(bad2), /capabilities: expected object/);
      } finally {
        cleanupDir(dir);
      }
    });
  });

  describe("Finding 4: config file perms warning actually exists", () => {
    it("warns when group/other bits are set, stays quiet at 0600", () => {
      const dir = tmpDir();
      try {
        const p = join(dir, "cfg.json");
        writeFileSync(p, JSON.stringify(VALID));
        chmodSync(p, 0o644);
        const warn = configFilePermWarning(p);
        assert.ok(warn, "expected a perms warning for 0644");
        assert.match(warn, /chmod 600/);
        chmodSync(p, 0o600);
        assert.equal(configFilePermWarning(p), null);
      } finally {
        cleanupDir(dir);
      }
    });
  });
});
