/**
 * RED-first tests for pure routing decisions: task-class resolution, sticky
 * cache-affinity reordering, pinned models, allowlists, budget gating.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { GatewayConfig } from "../src/config.ts";
import {
  budgetExceeded,
  isClassAllowed,
  resolveChain,
  resolveTaskClass,
} from "../src/router.ts";

function cfg(over: Partial<GatewayConfig> = {}): GatewayConfig {
  return {
    port: 0,
    host: "127.0.0.1",
    storage_dir: "/tmp/unused",
    connect_timeout_ms: 1000,
    max_retries_per_provider: 2,
    retry_backoff_base_ms: 1,
    body_limit_mb: 10,
    providers: {
      a: { model_id: "a-m", pricing: { input_per_mtok: 1, output_per_mtok: 1 }, task_classes: [] },
      b: { model_id: "b-m", pricing: { input_per_mtok: 1, output_per_mtok: 1 }, task_classes: [] },
      c: { model_id: "c-m", pricing: { input_per_mtok: 1, output_per_mtok: 1 }, task_classes: [] },
    },
    keys: {},
    routing: {
      bulk: ["a", "b"],
      "agentic-coding": ["b", "c"],
      default: ["c"],
    },
    budgets: {},
    ...over,
  };
}

describe("resolveTaskClass", () => {
  it("uses the X-Task-Class header value when it is a known class", () => {
    const d = resolveTaskClass(cfg().routing, { headerValue: "bulk" });
    assert.equal(d.taskClass, "bulk");
    assert.equal(d.unknownClass, false);
  });

  it("falls back to default for unknown header values (failure-free, per spec)", () => {
    const d = resolveTaskClass(cfg().routing, { headerValue: "research" });
    assert.equal(d.taskClass, "default");
    assert.equal(d.unknownClass, true);
  });

  it("falls back to default when no header is sent", () => {
    const d = resolveTaskClass(cfg().routing, {});
    assert.equal(d.taskClass, "default");
    assert.equal(d.unknownClass, false);
  });
});

describe("resolveChain", () => {
  it("keeps configured order when nothing is sticky", () => {
    const d = resolveChain(cfg(), {}, "key1", {}, { taskClass: "bulk" });
    assert.deepEqual(d.chain, ["a", "b"]);
    assert.equal(d.stickyApplied, false);
    assert.equal(d.pinnedProvider, undefined);
  });

  it("moves the sticky provider to the front of the chain", () => {
    // last-good provider was b; bulk prefers a first — sticky must win the head position
    const d = resolveChain(cfg(), { key1: "b" }, "key1", {}, { taskClass: "bulk" });
    assert.deepEqual(d.chain, ["b", "a"]);
    assert.equal(d.stickyApplied, true);
  });

  it("ignores sticky provider when it is not part of this class's chain", () => {
    // key sticky on 'a', but agentic-coding only contains b,c
    const d = resolveChain(cfg(), { key1: "a" }, "key1", {}, { taskClass: "agentic-coding" });
    assert.deepEqual(d.chain, ["b", "c"]);
    assert.equal(d.stickyApplied, false);
  });

  it("seeds stickiness from key's sticky_provider_hint before any observed success", () => {
    const d = resolveChain(cfg(), {}, "key1", { sticky_provider_hint: "b" }, { taskClass: "bulk" });
    assert.deepEqual(d.chain, ["b", "a"]);
    assert.equal(d.stickyApplied, true);
  });

  it("observed sticky state wins over the hint", () => {
    const d = resolveChain(
      cfg(),
      { key1: "a" },
      "key1",
      { sticky_provider_hint: "b" },
      { taskClass: "bulk" },
    );
    assert.deepEqual(d.chain, ["a", "b"]);
  });

  it("pins the chain to a single provider when the requested model names one", () => {
    const d = resolveChain(cfg(), { key1: "c" }, "key1", {}, { taskClass: "default", model: "b" });
    assert.deepEqual(d.chain, ["b"]);
    assert.equal(d.pinnedProvider, "b");
  });

  it("treats an unknown model string as opaque and routes by task class", () => {
    const d = resolveChain(cfg(), {}, "key1", {}, { taskClass: "bulk", model: "gpt-4o" });
    assert.deepEqual(d.chain, ["a", "b"]);
    assert.equal(d.pinnedProvider, undefined);
  });
});

describe("isClassAllowed", () => {
  it("allows everything when allowlist omitted or empty", () => {
    assert.equal(isClassAllowed({}, "bulk"), true);
    assert.equal(isClassAllowed({ allowed_task_classes: [] }, "bulk"), true);
  });

  it("enforces the allowlist", () => {
    const k = { allowed_task_classes: ["bulk"] };
    assert.equal(isClassAllowed(k, "bulk"), true);
    assert.equal(isClassAllowed(k, "long-run"), false);
  });
});

describe("budgetExceeded", () => {
  it("fires at exactly the cap and above", () => {
    assert.equal(budgetExceeded(5.0, 5.0), true);
    assert.equal(budgetExceeded(5.01, 5.0), true);
  });

  it("does not fire below the cap", () => {
    assert.equal(budgetExceeded(4.99, 5.0), false);
    assert.equal(budgetExceeded(0, 5.0), false);
  });

  it("handles float noise deterministically via rounding", () => {
    // 0.1+0.2 > 0.3 in raw floats — must still compare cleanly
    assert.equal(budgetExceeded(0.1 + 0.2, 0.3), true);
    assert.equal(budgetExceeded(0.1 + 0.2 - 0.0000001, 0.3), false);
  });
});
