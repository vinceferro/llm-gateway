/**
 * RED-first tests for bench/summarize.ts — A/B bench JSONL aggregation.
 * Pairing contract under test: bench-ab.sh appends gateway-then-direct per
 * prompt, so pairs form by (pass, ordinal-within-pass), never across passes.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { renderMarkdown, summarize, type BenchRow } from "../bench/summarize.ts";

/** One JSONL line exactly as bench-ab.sh writes it (usage = [in, out, cached]). */
function line(
  arm: "gateway" | "direct",
  kind: string,
  pass: number,
  lat: number,
  usage: [number | null, number | null, number | null] = [28, 8, 0],
): string {
  const [inp, out, cached] = usage;
  return JSON.stringify({ arm, kind, pass, latency_s: lat, in: inp, out, cached });
}

/** Harness failure row: arm/kind/pass + error, no latency, no usage. */
function errorLine(arm: "gateway" | "direct", kind: string, pass: number): string {
  return JSON.stringify({ arm, kind, pass, error: "request_failed" });
}

describe("pairing + token drift", () => {
  it("zero-drift pairs report drifted_pairs 0 and max delta 0", () => {
    const text = [
      line("gateway", "tiny", 1, 0.9),
      line("direct", "tiny", 1, 1.1),
      line("gateway", "tiny", 2, 0.8),
      line("direct", "tiny", 2, 0.95),
    ].join("\n");
    const s = summarize(text);
    assert.equal(s.skipped_malformed, 0);
    assert.equal(s.total_rows, 4);
    assert.equal(s.pairs, 2);
    assert.equal(s.incomplete_pairs, 0);
    assert.equal(s.unpaired_rows, 0);
    assert.equal(s.token_drift.comparable_pairs, 2);
    assert.equal(s.token_drift.excluded_pairs, 0);
    assert.equal(s.token_drift.drifted_pairs, 0);
    assert.deepEqual(s.token_drift.max_delta, { in: 0, out: 0, cached: 0 });
  });

  it("detects in/out drift with the correct max absolute delta", () => {
    const text = [
      line("gateway", "med", 1, 5.0, [44, 300, 0]),
      line("direct", "med", 1, 5.5, [42, 297, 0]), // in |−2|, out |−3|
    ].join("\n");
    const s = summarize(text);
    assert.equal(s.token_drift.comparable_pairs, 1);
    assert.equal(s.token_drift.drifted_pairs, 1);
    assert.deepEqual(s.token_drift.max_delta, { in: 2, out: 3, cached: 0 });
  });

  it("detects cached-token drift as the max delta on that metric", () => {
    const text = [
      line("gateway", "long", 1, 15.0, [51, 700, 128]),
      line("direct", "long", 1, 15.5, [51, 700, 0]), // cached |128|
    ].join("\n");
    const s = summarize(text);
    assert.equal(s.token_drift.drifted_pairs, 1);
    assert.deepEqual(s.token_drift.max_delta, { in: 0, out: 0, cached: 128 });
  });

  it("null-usage sides are excluded from drift comparison, never counted as drift", () => {
    const text = [
      line("gateway", "long", 1, 30.6, [null, null, null]),
      line("direct", "long", 1, 15.0, [51, 700, 0]),
    ].join("\n");
    const s = summarize(text);
    assert.equal(s.pairs, 1);
    assert.equal(s.token_drift.comparable_pairs, 0);
    assert.equal(s.token_drift.excluded_pairs, 1);
    assert.equal(s.token_drift.drifted_pairs, 0);
  });

  it("error rows keep their ordinal (incomplete pair); orphan rows count as unpaired", () => {
    const text = [
      errorLine("gateway", "med", 1),
      line("direct", "med", 1, 5.5, [44, 300, 0]),
      line("gateway", "tiny", 2, 0.9), // no direct follows in pass 2 → orphan
      line("direct", "tiny", 3, 1.0), // direct-first in pass 3 → orphan
      line("gateway", "tiny", 3, 0.9), // trailing gateway in pass 3 → orphan
    ].join("\n");
    const s = summarize(text);
    assert.equal(s.pairs, 1); // only the pass-1 (error) pair forms
    assert.equal(s.incomplete_pairs, 1);
    assert.equal(s.unpaired_rows, 3);
    assert.equal(s.token_drift.comparable_pairs, 0);
    assert.equal(s.token_drift.excluded_pairs, 1);
    // error side contributes no latency; healthy rows still aggregate per arm
    assert.equal(s.latency.gateway.n, 2);
    assert.equal(s.latency.direct.n, 2);
  });

  it("back-to-back gateway rows orphan the earlier one; the later still pairs", () => {
    // summarize.ts:148: a second gateway row while one is pending counts the
    // EARLIER row unpaired; the later row stays pending for the next direct.
    const text = [
      line("gateway", "tiny", 1, 0.9),
      line("gateway", "tiny", 1, 1.0), // no direct between the two gateway rows
      line("direct", "tiny", 1, 1.1),
    ].join("\n");
    const s = summarize(text);
    assert.equal(s.pairs, 1); // second gateway pairs with the direct
    assert.equal(s.unpaired_rows, 1); // first gateway orphaned
    assert.equal(s.token_drift.comparable_pairs, 1);
  });

  it("two consecutive gateway rows with no direct after them are both unpaired", () => {
    const text = [
      line("gateway", "tiny", 1, 0.9),
      line("gateway", "tiny", 1, 1.0), // second one orphaned: no direct follows
    ].join("\n");
    const s = summarize(text);
    assert.equal(s.pairs, 0);
    assert.equal(s.unpaired_rows, 2);
  });
});

describe("published 2026-08-29 shape", () => {
  // Mirrors bench/results-2026-08-29.jsonl: ONE benchmark session of two
  // harness invocations — an aborted attempt (10 pairs whose 3 `long`
  // gateway rows returned null usage mid-stream) plus a full re-run, both
  // recorded under pass=1 — then a third clean pass (pass=2). Strict
  // gateway/direct alternation throughout, same kind within every pair.
  function publishedShape(): string {
    const rows: string[] = [];
    const usageByKind: Record<string, [number, number, number]> = {
      tiny: [28, 8, 0],
      med: [37, 300, 0],
      long: [51, 700, 0],
    };
    const addPair = (pass: number, kind: string, nullUsage: boolean): void => {
      rows.push(
        line("gateway", kind, pass, kind === "long" ? 30.6 : 5.5,
          nullUsage ? [null, null, null] : usageByKind[kind]),
      );
      rows.push(line("direct", kind, pass, kind === "long" ? 15.5 : 5.7, usageByKind[kind]));
    };
    const kinds = ["tiny", "tiny", "tiny", "med", "med", "med", "med", "long", "long", "long"];
    // invocation 1 — aborted attempt: long gateway rows came back null-usage
    for (const [i, k] of kinds.entries()) addPair(1, k, k === "long");
    // invocation 2 — full re-run (pass 1) + third clean pass (pass 2)
    for (const pass of [1, 2]) for (const k of kinds) addPair(pass, k, false);
    return rows.join("\n");
  }

  it("30 pairs, 27 comparable, 3 excluded, 0 drifted, 0 unpaired/incomplete", () => {
    const s = summarize(publishedShape());
    assert.equal(s.total_rows, 60);
    assert.equal(s.pairs, 30);
    assert.equal(s.token_drift.comparable_pairs, 27);
    assert.equal(s.token_drift.excluded_pairs, 3);
    assert.equal(s.token_drift.drifted_pairs, 0);
    assert.deepEqual(s.token_drift.max_delta, { in: 0, out: 0, cached: 0 });
    assert.equal(s.unpaired_rows, 0);
    assert.equal(s.incomplete_pairs, 0);
    assert.equal(s.skipped_malformed, 0);
  });

  it("0 cross-kind pairs: order-based pairing keeps every pair same-kind", () => {
    // Test-side walk of the same order-based pairing, asserting the published
    // property the summarizer does not expose directly.
    const rows: Array<{ arm: string; kind: string }> = publishedShape()
      .split("\n")
      .map((l) => JSON.parse(l));
    let cross = 0;
    let pendingKind: string | null = null;
    for (const r of rows) {
      if (r.arm === "gateway") pendingKind = r.kind;
      else if (pendingKind !== null) {
        if (pendingKind !== r.kind) cross++;
        pendingKind = null;
      }
    }
    assert.equal(cross, 0);
    assert.equal(pendingKind, null); // no trailing gateway left over either
  });
});

describe("latency aggregates", () => {
  it("exact medians, p95 (linear interpolation), per-kind stats, delta %", () => {
    const text = [
      line("gateway", "tiny", 1, 1.0), line("direct", "tiny", 1, 2.0),
      line("gateway", "tiny", 1, 2.0), line("direct", "tiny", 1, 4.0),
      line("gateway", "med", 1, 3.0), line("direct", "med", 1, 6.0),
      line("gateway", "med", 1, 4.0), line("direct", "med", 1, 8.0),
    ].join("\n");
    const s = summarize(text);
    assert.equal(s.latency.gateway.n, 4);
    assert.equal(s.latency.gateway.median_s, 2.5);
    assert.equal(s.latency.gateway.p95_s, 3.85);
    assert.equal(s.latency.direct.n, 4);
    assert.equal(s.latency.direct.median_s, 5);
    assert.equal(s.latency.direct.p95_s, 7.7);
    assert.equal(s.median_delta_pct, -50);
    assert.equal(s.latency.gateway.by_kind.tiny!.n, 2);
    assert.equal(s.latency.gateway.by_kind.tiny!.median_s, 1.5);
    assert.equal(s.latency.gateway.by_kind.tiny!.p95_s, 1.95);
    assert.equal(s.latency.gateway.by_kind.med!.median_s, 3.5);
    assert.equal(s.latency.gateway.by_kind.med!.p95_s, 3.95); // 3 + 0.95*(4-3)
    assert.equal(s.latency.direct.by_kind.tiny!.median_s, 3);
    assert.equal(s.latency.direct.by_kind.med!.p95_s, 7.9);
  });

  it("empty input yields a zeroed summary with null medians (no crash)", () => {
    const s = summarize("");
    assert.equal(s.total_rows, 0);
    assert.equal(s.pairs, 0);
    assert.equal(s.latency.gateway.median_s, null);
    assert.equal(s.latency.direct.p95_s, null);
    assert.equal(s.median_delta_pct, null);
  });
});

describe("malformed rows", () => {
  it("skips and counts unparseable/invalid rows without shifting pairs", () => {
    const text = [
      "not json at all",
      JSON.stringify({ kind: "tiny", pass: 1, latency_s: 1 }), // missing arm
      JSON.stringify({ arm: "banana", kind: "tiny", pass: 1 }), // unknown arm
      line("gateway", "tiny", 1, 0.9),
      line("direct", "tiny", 1, 1.0),
    ].join("\n");
    const s = summarize(text);
    assert.equal(s.skipped_malformed, 3);
    assert.equal(s.total_rows, 2);
    assert.equal(s.pairs, 1);
    assert.equal(s.token_drift.drifted_pairs, 0);
  });
});

describe("renderMarkdown", () => {
  it("renders compact tables with medians and a drift line", () => {
    const s = summarize(
      [line("gateway", "tiny", 1, 0.9), line("direct", "tiny", 1, 1.0)].join("\n"),
    );
    const md = renderMarkdown(s);
    assert.match(md, /\| metric \| gateway \| direct \|/);
    assert.match(md, /median_s/);
    assert.match(md, /drifted 0/);
    assert.match(md, /median delta:/);
  });
});
