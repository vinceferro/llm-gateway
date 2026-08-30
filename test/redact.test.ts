/**
 * RED-first tests for the unset-env warning redaction (close-out Grey 1).
 *
 * `api_key_env` is validated to be NAME-shaped, but name-shape is a weak
 * filter: pasted key material can still parse as an env-var NAME (sk_live_*,
 * ghp_* with underscores stripped to shape, letter-leading hex). When the
 * startup warning prints an unset env-var name, the raw value would leak key
 * material into logs/journal. Rule: values longer than 24 chars print as
 * first 8 chars + "…(redacted)"; real env names are short and print in full.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { redactLong } from "../src/redact.ts";

describe("redactLong (unset-env warning redaction)", () => {
  it("redacts long NAME-shaped strings (pasted key material) to first 8 + marker", () => {
    const leaks = [
      "sk_live_abc123XYZdef456789", // sk-style key that happens to be name-shaped (27 chars)
      "ghp_" + "A1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6Q7r8", // 40-char GitHub-PAT-shaped
      "A" + "a1".repeat(32), // letter-leading 64-hex secret
    ];
    for (const leak of leaks) {
      assert.ok(leak.length > 24, "test input must exceed the 24-char threshold");
      const out = redactLong(leak);
      assert.equal(out, leak.slice(0, 8) + "…(redacted)");
      assert.ok(!out.includes(leak.slice(8)), "no tail of the long value may survive");
    }
  });

  it("prints short legit env names in full (debug value preserved)", () => {
    assert.equal(redactLong("ZAI_API_KEY"), "ZAI_API_KEY");
    assert.equal(redactLong("DEEPSEEK_API_KEY"), "DEEPSEEK_API_KEY");
    assert.equal(redactLong("_hidden_fallback_2"), "_hidden_fallback_2");
    assert.equal(redactLong("MY_KEY"), "MY_KEY");
  });

  it("boundary: exactly 24 chars prints as-is, 25 redacts", () => {
    const twentyFour = "A".repeat(24);
    assert.equal(redactLong(twentyFour), twentyFour, "≤24 prints as-is");
    assert.equal(redactLong("A".repeat(25)), "AAAAAAAA…(redacted)");
  });
});
