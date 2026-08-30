/**
 * RED-first tests for the append-only JSONL usage ledger and USD math.
 */

import assert from "node:assert/strict";
import { appendFileSync, chmodSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, it } from "node:test";
import {
  appendRecord,
  computeCost,
  monthSpend,
  summarizeLedger,
  type UsageRecord,
} from "../src/ledger.ts";
import { cleanupDir, tmpDir } from "./helpers.ts";

function rec(over: Partial<UsageRecord> = {}): UsageRecord {
  return {
    ts: new Date().toISOString(),
    project: "proj-a",
    provider: "good",
    model: "good-model",
    task_class: "bulk",
    input_tokens: 1000,
    output_tokens: 500,
    usd: 0.0015,
    latency_ms: 42,
    stream: false,
    fallback_used: false,
    attempts: 1,
    ...over,
  };
}

describe("computeCost", () => {
  it("computes (in*pin + out*pout)/1e6 with 1e-6 rounding", () => {
    // 1000 tok @ $0.27/Mtok in + 500 tok @ $1.10/Mtok out
    const usd = computeCost({ input_per_mtok: 0.27, output_per_mtok: 1.1 }, 1000, 500);
    const expected = (1000 * 0.27 + 500 * 1.1) / 1e6; // 0.00082
    assert.ok(Math.abs(usd - expected) < 5e-9, `expected ~${expected}, got ${usd}`);
    assert.equal(usd, Math.round(usd * 1e9) / 1e9);
  });

  it("rounds away float noise at the 7th decimal", () => {
    const usd = computeCost({ input_per_mtok: 0.1, output_per_mtok: 0.1 }, 3, 3);
    assert.equal(usd, 0.0000006);
  });

  it("zero pricing yields zero cost (local models)", () => {
    assert.equal(computeCost({ input_per_mtok: 0, output_per_mtok: 0 }, 12345, 999), 0);
  });
});

describe("ledger file behavior", () => {
  it("appendRecord creates the dir and appends one JSON line per record", () => {
    const dir = tmpDir();
    try {
      appendRecord(dir, rec({ project: "p1" }));
      appendRecord(dir, rec({ project: "p2" }));
      const lines = summarizeLedger(dir, {});
      assert.equal(lines.totals.requests, 2);
    } finally {
      cleanupDir(dir);
    }
  });

  it("summarizeLedger filters by month (YYYY-MM prefix of ts)", () => {
    const dir = tmpDir();
    try {
      appendRecord(dir, rec({}));
      appendRecord(dir, rec({ ts: "2020-01-15T10:00:00.000Z", usd: 9 }));
      const all = summarizeLedger(dir, {});
      assert.equal(all.totals.requests, 2);
      const aug = summarizeLedger(dir, { month: new Date().toISOString().slice(0, 7) });
      assert.equal(aug.totals.requests, 1);
      assert.equal(summarizeLedger(dir, { month: "2020-01" }).totals.usd, 9);
    } finally {
      cleanupDir(dir);
    }
  });

  it("summarizeLedger groups by project+provider+model", () => {
    const dir = tmpDir();
    try {
      appendRecord(dir, rec({ provider: "a", usd: 1 }));
      appendRecord(dir, rec({ provider: "a", usd: 2 }));
      appendRecord(dir, rec({ provider: "b", project: "p2", usd: 4 }));
      const s = summarizeLedger(dir, {});
      assert.equal(s.totals.usd, 7);
      const groupA = s.groups.find((g) => g.provider === "a");
      assert.ok(groupA);
      assert.equal(groupA.project, "proj-a");
      assert.equal(groupA.requests, 2);
      assert.equal(groupA.usd, 3);
    } finally {
      cleanupDir(dir);
    }
  });

  it("monthSpend sums only matching project+month", () => {
    const dir = tmpDir();
    try {
      appendRecord(dir, rec({ usd: 1 }));
      appendRecord(dir, rec({ project: "other", usd: 100 }));
      appendRecord(dir, rec({ ts: "2020-01-01T00:00:00.000Z", usd: 50 }));
      const month = new Date().toISOString().slice(0, 7);
      assert.equal(monthSpend(dir, "proj-a", month), 1);
      assert.equal(monthSpend(dir, "other", month), 100);
    } finally {
      cleanupDir(dir);
    }
  });

  it("tolerates a missing ledger file and corrupt lines", () => {
    const dir = tmpDir();
    try {
      assert.deepEqual(summarizeLedger(dir, {}).totals.requests, 0);
      appendRecord(dir, rec({ usd: 1 }));
      // simulate a torn/corrupt write
      appendFileSync(join(dir, "usage.jsonl"), "{not json\n");
      const s = summarizeLedger(dir, {});
      assert.equal(s.totals.requests, 1);
      assert.equal(s.totals.usd, 1);
    } finally {
      cleanupDir(dir);
    }
  });

  it("appendRecord never merges a new record onto a torn final line (crash signature: no trailing newline)", () => {
    const dir = tmpDir();
    try {
      appendRecord(dir, rec({ usd: 1 }));
      // real crash signature: torn partial-JSON tail, trailing newline never flushed
      appendFileSync(join(dir, "usage.jsonl"), JSON.stringify(rec({ usd: 99 })).slice(0, 60));
      appendRecord(dir, rec({ usd: 2 }));
      const s = summarizeLedger(dir, {});
      // torn tail must be swallowed (still skipped as corrupt) WITHOUT swallowing
      // the post-tear record: 1 pre-tear + 1 post-tear, torn contributes 0
      assert.equal(s.totals.requests, 2);
      assert.equal(s.totals.usd, 3);
      assert.equal(
        monthSpend(dir, "proj-a", new Date().toISOString().slice(0, 7)),
        3,
        "budget math must see both real records after a tear",
      );
      // the torn line must survive AS ITS OWN LINE (readable-as-corrupt), not
      // become the prefix of the appended record
      const raw = readFileSync(join(dir, "usage.jsonl"), "utf8");
      const lines = raw.split("\n");
      assert.equal(lines.length, 4, "expected 3 lines + trailing newline, got raw: " + JSON.stringify(raw));
      assert.equal(JSON.parse(lines[0]!).usd, 1);
      assert.throws(() => JSON.parse(lines[1]!), "torn line must remain its own corrupt line");
      assert.equal(JSON.parse(lines[2]!).usd, 2);
    } finally {
      cleanupDir(dir);
    }
  });

  // Characterization tests (2026-08-30 close-out): both behaviors were proven
  // by the adversarial reviewer's execution and are pinned here so future
  // READER changes cannot silently break them. They were born green.
  it("characterization: CRLF-authored ledger (records ending \\r\\n) counts correctly", () => {
    const dir = tmpDir();
    try {
      // authored on Windows / by tools writing CRLF — every record ends \r\n
      appendFileSync(
        join(dir, "usage.jsonl"),
        JSON.stringify(rec({ usd: 1 })) + "\r\n" + JSON.stringify(rec({ usd: 2 })) + "\r\n",
      );
      const s = summarizeLedger(dir, {});
      assert.equal(s.totals.requests, 2, "both CRLF-terminated records must parse (JSON \\r is whitespace)");
      assert.equal(s.totals.usd, 3);
    } finally {
      cleanupDir(dir);
    }
  });

  it("characterization: complete JSON line with NO trailing newline counts once, next append separates cleanly", () => {
    const dir = tmpDir();
    try {
      const first = JSON.stringify(rec({ usd: 1 }));
      appendFileSync(join(dir, "usage.jsonl"), first); // complete record, trailing \n never written
      const before = summarizeLedger(dir, {});
      assert.equal(before.totals.requests, 1, "unterminated-but-complete line counts exactly once");
      assert.equal(before.totals.usd, 1);
      appendRecord(dir, rec({ usd: 2 }));
      const lines = readFileSync(join(dir, "usage.jsonl"), "utf8").split("\n");
      assert.equal(lines.length, 3, "raw lines after append: record, new record, empty tail");
      assert.equal(JSON.parse(lines[0]!).usd, 1);
      assert.equal(JSON.parse(lines[1]!).usd, 2);
      assert.equal(lines[2], "");
    } finally {
      cleanupDir(dir);
    }
  });

  it("appendRecord onto a torn-ONLY file still lands the record intact", () => {
    const dir = tmpDir();
    try {
      // the very first append after a crash whose torn write was the ONLY content
      appendFileSync(join(dir, "usage.jsonl"), JSON.stringify(rec({ usd: 42 })).slice(0, 30));
      appendRecord(dir, rec({ usd: 5 }));
      const s = summarizeLedger(dir, {});
      assert.equal(s.totals.requests, 1, "torn line skipped, appended record counted");
      assert.equal(s.totals.usd, 5);
    } finally {
      cleanupDir(dir);
    }
  });

  it("appendRecord succeeds on a WRITE-ONLY (0200) ledger — probe errors must never block the append", () => {
    // Regression guard for the trailing-newline probe: finalize runs from
    // stream event handlers OUTSIDE handle()'s try/catch (src/server.ts), so
    // a sync throw here would kill the process. The old (pre-probe) append
    // worked on 0200 files; the probe's O_RDONLY open must not regress that.
    const dir = tmpDir();
    try {
      appendRecord(dir, rec({ usd: 1 }));
      const p = join(dir, "usage.jsonl");
      chmodSync(p, 0o200); // owner-writable, NOT readable: probe's openSync("r") throws EACCES
      appendRecord(dir, rec({ usd: 2 }));
      chmodSync(p, 0o600); // restore so we can verify below
      const s = summarizeLedger(dir, {});
      assert.equal(s.totals.requests, 2, "both records must land despite the unreadable probe");
      assert.equal(
        monthSpend(dir, "proj-a", new Date().toISOString().slice(0, 7)),
        3,
        "budget math must see both records",
      );
    } finally {
      try {
        chmodSync(join(dir, "usage.jsonl"), 0o600);
      } catch {
        /* nothing to restore */
      }
      cleanupDir(dir);
    }
  });

  it("tolerates a TRUNCATED final line (crash mid-append: valid-JSON prefix, no trailing newline)", () => {
    const dir = tmpDir();
    try {
      appendRecord(dir, rec({ usd: 1 }));
      // crash mid-append: the torn tail is a PREFIX of a real record and the
      // newline was never flushed — the actual crash signature, distinct from
      // a complete-but-garbage line (previous test).
      appendFileSync(join(dir, "usage.jsonl"), JSON.stringify(rec({ usd: 2 })).slice(0, 60));
      const s = summarizeLedger(dir, {});
      assert.equal(s.totals.requests, 1, "the torn tail must not count as a request");
      assert.equal(s.totals.usd, 1);
      assert.equal(
        monthSpend(dir, "proj-a", new Date().toISOString().slice(0, 7)),
        1,
        "budget math must skip the torn tail too",
      );
    } finally {
      cleanupDir(dir);
    }
  });
});
