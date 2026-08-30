/**
 * RED-first tests for the dated, sourced list-price table (src/prices.ts) and
 * the strictly-validated `report` config section that can override it.
 *
 * Honesty contract under test:
 *  - verified entries carry source + asOf (e.g. deepseek-v4-flash @ 2026-08-28)
 *  - unverified entries are ZERO-priced placeholders, never usable as a
 *    counterfactual baseline or silently in savings math
 *  - operator-supplied prices/overrides ARE the attestation (verified: true)
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { ConfigError, loadConfig } from "../src/config.ts";
import {
  DEFAULT_BASELINE_ID,
  LIST_PRICES,
  PriceError,
  resolveReportPricing,
} from "../src/prices.ts";
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

describe("LIST_PRICES table", () => {
  it("deepseek-v4-flash carries the verified 2026-08-28 api-docs.deepseek.com pricing", () => {
    const p = LIST_PRICES["deepseek-v4-flash"];
    assert.ok(p, "deepseek-v4-flash must exist");
    assert.equal(p.input_per_mtok, 0.22);
    assert.equal(p.output_per_mtok, 0.66);
    assert.equal(p.source, "api-docs.deepseek.com");
    assert.equal(p.asOf, "2026-08-28");
    assert.equal(p.verified, true);
  });

  it("Z.ai GLM entries are zero-priced UNVERIFIED placeholders", () => {
    const p = LIST_PRICES["glm-4.6"];
    assert.ok(p, "glm-4.6 must exist as a placeholder");
    assert.equal(p.input_per_mtok, 0);
    assert.equal(p.output_per_mtok, 0);
    assert.equal(p.verified, false, "GLM prices are NOT verified");
    assert.equal(p.asOf, "unverified");
    assert.match(p.source, /placeholder/i);
  });

  it("every entry is internally consistent (finite non-negative rates, provenance present)", () => {
    for (const [id, p] of Object.entries(LIST_PRICES)) {
      assert.ok(Number.isFinite(p.input_per_mtok) && p.input_per_mtok >= 0, `${id} input rate`);
      assert.ok(Number.isFinite(p.output_per_mtok) && p.output_per_mtok >= 0, `${id} output rate`);
      assert.ok(p.source.length > 0, `${id} must name its source`);
      assert.ok(p.asOf.length > 0, `${id} must name its asOf`);
      if (!p.verified) {
        assert.equal(p.asOf, "unverified", `${id}: unverified entries must carry asOf "unverified"`);
      }
    }
  });
});

describe("resolveReportPricing", () => {
  it("defaults to the verified deepseek-v4-flash baseline; table entries pass through", () => {
    const r = resolveReportPricing(undefined);
    assert.equal(r.baseline.id, DEFAULT_BASELINE_ID);
    assert.equal(r.baseline.verified, true);
    assert.equal(r.baseline.input_per_mtok, 0.22);
    assert.equal(r.baseline.output_per_mtok, 0.66);
    assert.equal(r.prices["glm-4.6"]!.verified, false, "placeholder stays unverified by default");
  });

  it("baseline by table id", () => {
    const r = resolveReportPricing({ baseline: "deepseek-v4-flash" });
    assert.equal(r.baseline.id, "deepseek-v4-flash");
    assert.equal(r.baseline.verified, true);
  });

  it("inline baseline object is operator-attested (verified, operator provenance)", () => {
    const r = resolveReportPricing({
      baseline: { model: "my-ref-provider", input_per_mtok: 1.25, output_per_mtok: 5 },
    });
    assert.equal(r.baseline.id, "my-ref-provider");
    assert.equal(r.baseline.input_per_mtok, 1.25);
    assert.equal(r.baseline.output_per_mtok, 5);
    assert.equal(r.baseline.verified, true);
    assert.match(r.baseline.source, /operator/i);
  });

  it("rejects an unknown baseline id", () => {
    assert.throws(
      () => resolveReportPricing({ baseline: "not-a-model" }),
      (e: unknown) => e instanceof PriceError && /not-a-model/.test((e as Error).message),
    );
  });

  it("rejects a baseline id that is still an unverified placeholder (never invent savings)", () => {
    assert.throws(
      () => resolveReportPricing({ baseline: "glm-4.6" }),
      (e: unknown) => e instanceof PriceError && /unverified/i.test((e as Error).message),
    );
  });

  it("rejects an all-zero inline baseline (savings math would be meaningless)", () => {
    assert.throws(
      () => resolveReportPricing({ baseline: { input_per_mtok: 0, output_per_mtok: 0 } }),
      (e: unknown) => e instanceof PriceError && /zero/i.test((e as Error).message),
    );
  });

  it("rejects non-finite/negative inline baseline rates", () => {
    assert.throws(() => resolveReportPricing({ baseline: { input_per_mtok: -1, output_per_mtok: 1 } }), PriceError);
    assert.throws(() => resolveReportPricing({ baseline: { input_per_mtok: "x" as unknown as number, output_per_mtok: 1 } }), PriceError);
  });

  it("price overrides mark the entry verified with operator provenance — and make it a legal baseline", () => {
    const overrides = { prices: { "glm-4.6": { input_per_mtok: 0.6, output_per_mtok: 2.2 } } };
    const r = resolveReportPricing(overrides);
    const p = r.prices["glm-4.6"]!;
    assert.equal(p.verified, true, "operator-supplied price IS the attestation");
    assert.equal(p.input_per_mtok, 0.6);
    assert.equal(p.output_per_mtok, 2.2);
    assert.equal(p.asOf, "operator-configured");
    assert.match(p.source, /operator/i);
    assert.equal(resolveReportPricing({ ...overrides, baseline: "glm-4.6" }).baseline.id, "glm-4.6");
  });

  it("price overrides honor explicit source/as_of provenance", () => {
    const r = resolveReportPricing({
      prices: { "glm-4.6": { input_per_mtok: 0.6, output_per_mtok: 2.2, source: "z.ai docs", as_of: "2026-08-29" } },
    });
    const p = r.prices["glm-4.6"]!;
    assert.equal(p.source, "z.ai docs");
    assert.equal(p.asOf, "2026-08-29");
  });

  it("rejects malformed overrides (bad rates) with a named-model message", () => {
    assert.throws(
      () => resolveReportPricing({ prices: { "glm-4.6": { input_per_mtok: -5, output_per_mtok: 2 } } }),
      (e: unknown) => e instanceof PriceError && /glm-4\.6/.test((e as Error).message),
    );
  });

  it("does not mutate the shared table", () => {
    resolveReportPricing({ prices: { "glm-4.6": { input_per_mtok: 9, output_per_mtok: 9 } } });
    assert.equal(LIST_PRICES["glm-4.6"]!.input_per_mtok, 0, "module constant stays pristine");
    assert.equal(LIST_PRICES["glm-4.6"]!.verified, false);
  });
});

describe("config report section (strict validation)", () => {
  it("accepts a verified baseline id, an inline baseline, and price overrides", () => {
    const dir = tmpDir();
    try {
      const cfg = loadConfig(
        writeCfg(dir, {
          ...VALID,
          report: {
            baseline: "deepseek-v4-flash",
            prices: { "glm-4.6": { input_per_mtok: 0.6, output_per_mtok: 2.2 } },
          },
        }),
      );
      assert.equal(cfg.report!.baseline, "deepseek-v4-flash");
      assert.equal(cfg.report!.prices!["glm-4.6"]!.input_per_mtok, 0.6);
      const cfg2 = loadConfig(
        writeCfg(dir, { ...VALID, report: { baseline: { model: "x", input_per_mtok: 1, output_per_mtok: 2 } } }),
      );
      assert.deepEqual(cfg2.report!.baseline, { model: "x", input_per_mtok: 1, output_per_mtok: 2 });
    } finally {
      cleanupDir(dir);
    }
  });

  it("rejects unknown report fields (strictly validated)", () => {
    const dir = tmpDir();
    try {
      assert.throws(
        () => loadConfig(writeCfg(dir, { ...VALID, report: { baseline: "deepseek-v4-flash", bogus: 1 } })),
        ConfigError,
      );
      assert.throws(
        () => loadConfig(writeCfg(dir, { ...VALID, report: { bogus: 1 } })),
        /unknown field "bogus"/,
      );
    } finally {
      cleanupDir(dir);
    }
  });

  it("rejects a non-object report section", () => {
    const dir = tmpDir();
    try {
      assert.throws(() => loadConfig(writeCfg(dir, { ...VALID, report: 42 })), /report/);
    } finally {
      cleanupDir(dir);
    }
  });

  it("rejects baseline objects with non-numeric rates or unknown fields", () => {
    const dir = tmpDir();
    try {
      assert.throws(
        () => loadConfig(writeCfg(dir, { ...VALID, report: { baseline: { input_per_mtok: "a", output_per_mtok: 1 } } })),
        ConfigError,
      );
      assert.throws(
        () => loadConfig(writeCfg(dir, { ...VALID, report: { baseline: { model: "x", wat: 1 } } })),
        ConfigError,
      );
    } finally {
      cleanupDir(dir);
    }
  });

  it("rejects a baseline id that is not in the price table", () => {
    const dir = tmpDir();
    try {
      assert.throws(
        () => loadConfig(writeCfg(dir, { ...VALID, report: { baseline: "made-up-model" } })),
        /made-up-model/,
      );
    } finally {
      cleanupDir(dir);
    }
  });

  it("rejects an UNVERIFIED baseline id at load — the operator must verify under report.prices first", () => {
    const dir = tmpDir();
    try {
      assert.throws(
        () => loadConfig(writeCfg(dir, { ...VALID, report: { baseline: "glm-4.6" } })),
        /unverified/i,
      );
      // ...but once the operator supplies the price, the same id loads fine
      const cfg = loadConfig(
        writeCfg(dir, {
          ...VALID,
          report: {
            baseline: "glm-4.6",
            prices: { "glm-4.6": { input_per_mtok: 0.6, output_per_mtok: 2.2 } },
          },
        }),
      );
      assert.equal(cfg.report!.baseline, "glm-4.6");
    } finally {
      cleanupDir(dir);
    }
  });

  it("rejects malformed price overrides", () => {
    const dir = tmpDir();
    try {
      assert.throws(
        () => loadConfig(writeCfg(dir, { ...VALID, report: { prices: { m: { input_per_mtok: "x", output_per_mtok: 1 } } } })),
        ConfigError,
      );
      assert.throws(
        () => loadConfig(writeCfg(dir, { ...VALID, report: { prices: { m: { input_per_mtok: 1, output_per_mtok: 1, nope: true } } } })),
        ConfigError,
      );
      assert.throws(
        () => loadConfig(writeCfg(dir, { ...VALID, report: { prices: { m: { input_per_mtok: 1 } } } })),
        ConfigError,
      );
    } finally {
      cleanupDir(dir);
    }
  });
});
