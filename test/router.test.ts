/**
 * RED-first tests for pure routing decisions: task-class resolution, sticky
 * cache-affinity reordering, pinned models, allowlists, budget gating.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { GatewayConfig, ProviderConfig } from "../src/config.ts";
import {
  budgetExceeded,
  isClassAllowed,
  requiresVision,
  resolveChain,
  resolveTaskClass,
} from "../src/router.ts";

/** Provider with an optional capabilities block, for capability-routing tests. */
function capProvider(id: string, caps?: ProviderConfig["capabilities"]): ProviderConfig {
  return {
    model_id: `${id}-m`,
    pricing: { input_per_mtok: 1, output_per_mtok: 1 },
    task_classes: [],
    ...(caps !== undefined ? { capabilities: caps } : {}),
  };
}

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

describe("requiresVision (image-part detector)", () => {
  it("string content → false", () => {
    assert.equal(requiresVision({ messages: [{ role: "user", content: "hello" }] }), false);
  });

  it("array content containing an image_url part → true", () => {
    const body = {
      messages: [
        { role: "system", content: "you are helpful" },
        {
          role: "user",
          content: [
            { type: "text", text: "what is this?" },
            { type: "image_url", image_url: { url: "data:image/png;base64,AAAA" } },
          ],
        },
      ],
    };
    assert.equal(requiresVision(body), true);
  });

  it("array content without image parts (text only) → false", () => {
    assert.equal(
      requiresVision({
        messages: [{ role: "user", content: [{ type: "text", text: "plain" }] }],
      }),
      false,
    );
  });

  it("array content with only UNKNOWN part types → false (gate is image_url-only this round)", () => {
    assert.equal(
      requiresVision({
        messages: [{ role: "user", content: [{ type: "input_audio", input_audio: { data: "xx", format: "wav" } }] }],
      }),
      false,
    );
  });
});

describe("vision-capability chain filtering", () => {
  function visionCfg(over: Partial<GatewayConfig> = {}): GatewayConfig {
    return {
      ...cfg(),
      providers: {
        a: capProvider("a"), // text-only, no capabilities declared
        b: capProvider("b", { vision: true }),
        c: capProvider("c"),
      },
      routing: {
        bulk: ["a", "b"],
        mixed: ["a", "b", "c"], // b (vision) sits mid-chain; order must survive
        visionless: ["a", "c"], // no vision anywhere
        default: ["b"],
      },
      ...over,
    };
  }

  const IMG = {
    messages: [
      { role: "user", content: [{ type: "image_url", image_url: { url: "data:image/png;base64,AAAA" } }] },
    ],
  };
  const TEXT = { messages: [{ role: "user", content: "hello" }] };

  it("image request: text-only head is skipped IN ORDER, chain filtered to the vision-capable provider", () => {
    const d = resolveChain(visionCfg(), {}, "key1", {}, { taskClass: "bulk", requiresVision: true });
    assert.deepEqual(d.chain, ["b"]);
    assert.equal(d.capabilityError, undefined);
  });

  it("image request: multiple vision-capable providers keep their configured relative order", () => {
    const c2 = visionCfg();
    c2.providers = { ...c2.providers, c: capProvider("c", { vision: true }) };
    const d = resolveChain(c2, {}, "key1", {}, { taskClass: "mixed", requiresVision: true });
    assert.deepEqual(d.chain, ["b", "c"]);
  });

  it("image request + no vision anywhere: explicit capability error naming the task class and vision", () => {
    const d = resolveChain(visionCfg(), {}, "key1", {}, { taskClass: "visionless", requiresVision: true });
    assert.deepEqual(d.chain, []);
    assert.match(d.capabilityError ?? "", /no vision-capable provider in chain for task class "visionless"/);
  });

  it("text request + providers with EMPTY/absent capabilities: chain unchanged (backward compat)", () => {
    const d = resolveChain(visionCfg(), {}, "key1", {}, { taskClass: "bulk", requiresVision: false });
    assert.deepEqual(d.chain, ["a", "b"]);
    assert.equal(d.stickyApplied, false);
  });

  it("sticky text-only provider is skipped for image requests (capability failure, not load-balancing)", () => {
    const d = resolveChain(visionCfg(), { key1: "a" }, "key1", {}, { taskClass: "bulk", requiresVision: true });
    assert.deepEqual(d.chain, ["b"]);
    assert.equal(d.stickyApplied, false);
    // and a vision-capable sticky provider is still promoted within the filtered set
    const d2 = resolveChain(visionCfg(), { key1: "b" }, "key1", {}, { taskClass: "bulk", requiresVision: true });
    assert.deepEqual(d2.chain, ["b"]);
    assert.equal(d2.stickyApplied, true);
  });

  it("pinned provider without vision + image request → capability error; vision-claimed pin passes", () => {
    const pinnedText = resolveChain(visionCfg(), {}, "key1", {}, {
      taskClass: "default",
      model: "a",
      requiresVision: true,
    });
    assert.deepEqual(pinnedText.chain, []);
    assert.match(pinnedText.capabilityError ?? "", /vision/);
    const pinnedVision = resolveChain(visionCfg(), {}, "key1", {}, {
      taskClass: "default",
      model: "b",
      requiresVision: true,
    });
    assert.deepEqual(pinnedVision.chain, ["b"]);
    assert.equal(pinnedVision.pinnedProvider, "b");
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
