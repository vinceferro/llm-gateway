/**
 * RED-first tests for off-peak window-aware routing (Phase 2, increment 1).
 *
 * Pinned semantic (also documented in src/router.ts):
 *   A routing class entry may be `string[]` (peak chain) or
 *   `{ chain, off_peak_chain }`. The off_peak_chain is used IFF at least one
 *   provider listed in the off_peak_chain declares an `off_peak` schedule AND
 *   that schedule is currently OFF-PEAK at the request's UTC time. Otherwise
 *   the plain chain is used. Off-peak itself = outside ALL peak windows;
 *   UTC weekdays absent from every window's `days` are ALL-DAY off-peak.
 *   Pinned provider ids (model == provider id) never consult off-peak logic.
 *   Sticky reorder applies AFTER chain selection, within whichever chain won.
 *
 * All clocks are injected — no test reads the real clock.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import type { GatewayConfig, OffPeakSchedule } from "../src/config.ts";
import { loadConfig } from "../src/config.ts";
import { isClassAllowed, isOffPeak, resolveChain } from "../src/router.ts";
import { cleanupDir, tmpDir, mockProvider, startServer, chat, TEST_KEY, type RunningServer } from "./helpers.ts";

/** Capture console.log without printing; restore afterwards. */
function mockLog(): { lines: () => string[]; restore: () => void } {
  const lines: string[] = [];
  const orig = console.log;
  console.log = (...args: unknown[]): void => {
    lines.push(args.map(String).join(" "));
  };
  return { lines: () => lines, restore: () => (console.log = orig) };
}

/** DeepSeek's official lane: peak = 01:00-04:00 & 06:00-10:00 UTC on weekdays only. */
const DEEPSEEK_SCHEDULE: OffPeakSchedule = {
  peak_utc: [
    { days: [1, 2, 3, 4, 5], start: "01:00", end: "04:00" },
    { days: [1, 2, 3, 4, 5], start: "06:00", end: "10:00" },
  ],
};

/** Human-month helper: utcAt(2026, 8, 31, 5, 0) = 2026-08-31T05:00:00Z. */
function utcAt(year: number, month1to12: number, day: number, h: number, min: number, s = 0, ms = 0): Date {
  return new Date(Date.UTC(year, month1to12 - 1, day, h, min, s, ms));
}
// 2026-08-28 is a Friday → 29=Sat, 30=Sun, 31=Mon.
const SAT = { y: 2026, m: 8, d: 29 };
const SUN = { y: 2026, m: 8, d: 30 };
const MON = { y: 2026, m: 8, d: 31 };

describe("isOffPeak (pure predicate of now + schedule)", () => {
  it("is peak inside the first window (01:00-04:00 UTC weekday)", () => {
    assert.equal(isOffPeak(utcAt(MON.y, MON.m, MON.d, 2, 0), DEEPSEEK_SCHEDULE), false);
    assert.equal(isOffPeak(utcAt(MON.y, MON.m, MON.d, 3, 59), DEEPSEEK_SCHEDULE), false);
  });

  it("window start is inclusive: 01:00:00.000 exactly is peak", () => {
    assert.equal(isOffPeak(utcAt(MON.y, MON.m, MON.d, 1, 0, 0, 0), DEEPSEEK_SCHEDULE), false);
  });

  it("window end is exclusive: 04:00:00 exactly is off-peak", () => {
    assert.equal(isOffPeak(utcAt(MON.y, MON.m, MON.d, 4, 0, 0, 0), DEEPSEEK_SCHEDULE), true);
    assert.equal(isOffPeak(utcAt(MON.y, MON.m, MON.d, 3, 59, 59), DEEPSEEK_SCHEDULE), false);
  });

  it("is off-peak in the gap between windows (04:00-06:00)", () => {
    assert.equal(isOffPeak(utcAt(MON.y, MON.m, MON.d, 5, 0), DEEPSEEK_SCHEDULE), true);
  });

  it("is peak inside the second window (06:00-10:00) and off-peak after 10:00", () => {
    assert.equal(isOffPeak(utcAt(MON.y, MON.m, MON.d, 7, 30), DEEPSEEK_SCHEDULE), false);
    assert.equal(isOffPeak(utcAt(MON.y, MON.m, MON.d, 9, 59), DEEPSEEK_SCHEDULE), false);
    assert.equal(isOffPeak(utcAt(MON.y, MON.m, MON.d, 10, 0), DEEPSEEK_SCHEDULE), true);
  });

  it("weekends are ALL-DAY off-peak: hours matching weekday windows are still off-peak", () => {
    for (const d of [SAT, SUN]) {
      assert.equal(isOffPeak(utcAt(d.y, d.m, d.d, 2, 0), DEEPSEEK_SCHEDULE), true, `${d.d} 02:00`);
      assert.equal(isOffPeak(utcAt(d.y, d.m, d.d, 8, 0), DEEPSEEK_SCHEDULE), true, `${d.d} 08:00`);
      assert.equal(isOffPeak(utcAt(d.y, d.m, d.d, 12, 0), DEEPSEEK_SCHEDULE), true, `${d.d} 12:00`);
    }
  });

  it("UTC midnight edges: just before 01:00 and around 00:00 are off-peak", () => {
    assert.equal(isOffPeak(utcAt(MON.y, MON.m, MON.d, 0, 0), DEEPSEEK_SCHEDULE), true);
    assert.equal(isOffPeak(utcAt(MON.y, MON.m, MON.d, 0, 59), DEEPSEEK_SCHEDULE), true);
    assert.equal(isOffPeak(utcAt(SUN.y, SUN.m, SUN.d, 23, 59), DEEPSEEK_SCHEDULE), true);
    assert.equal(isOffPeak(utcAt(MON.y, MON.m, MON.d, 23, 59), DEEPSEEK_SCHEDULE), true);
  });

  it("weekdays absent from a window's days are all-day off-peak (days: [1] only → Tuesday never peaks)", () => {
    const mondayOnly: OffPeakSchedule = { peak_utc: [{ days: [1], start: "01:00", end: "04:00" }] };
    const tue = { y: 2026, m: 9, d: 1 };
    assert.equal(isOffPeak(utcAt(MON.y, MON.m, MON.d, 2, 0), mondayOnly), false); // Monday peaks
    assert.equal(isOffPeak(utcAt(tue.y, tue.m, tue.d, 2, 0), mondayOnly), true); // Tuesday all-day off-peak
  });
});

/** Config with one schedule-declaring provider (ds) and plain providers. */
function offpeakCfg(over: Partial<GatewayConfig> = {}): GatewayConfig {
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
      ds: {
        model_id: "deepseek-v4-flash",
        pricing: { input_per_mtok: 0.22, output_per_mtok: 0.66 },
        task_classes: ["bulk"],
        off_peak: DEEPSEEK_SCHEDULE,
      },
    },
    keys: {},
    routing: {
      bulk: { chain: ["a", "b"], off_peak_chain: ["ds", "a", "b"] },
      plain: ["a", "b"],
      noSched: { chain: ["a", "b"], off_peak_chain: ["a", "c"] },
      default: ["a"],
    },
    budgets: {},
    ...over,
  };
}

const PEAK_MON_0200 = utcAt(MON.y, MON.m, MON.d, 2, 0);
const OFFPEAK_MON_0500 = utcAt(MON.y, MON.m, MON.d, 5, 0);
const OFFPEAK_SAT_0200 = utcAt(SAT.y, SAT.m, SAT.d, 2, 0);

describe("resolveChain off-peak selection (injected clocks)", () => {
  it("no off_peak_chain anywhere → byte-identical behavior at ANY clock", () => {
    for (const now of [PEAK_MON_0200, OFFPEAK_MON_0500, OFFPEAK_SAT_0200]) {
      const d = resolveChain(offpeakCfg(), {}, "k", {}, { taskClass: "plain", now });
      assert.deepEqual(d.chain, ["a", "b"]);
      assert.equal(d.stickyApplied, false);
      assert.equal(d.pinnedProvider, undefined);
      assert.equal(d.offPeakApplied, false);
    }
  });

  it("peak time → the plain chain is used", () => {
    const d = resolveChain(offpeakCfg(), {}, "k", {}, { taskClass: "bulk", now: PEAK_MON_0200 });
    assert.deepEqual(d.chain, ["a", "b"]);
    assert.equal(d.offPeakApplied, false);
  });

  it("off-peak time (schedule-declaring provider off-peak) → off_peak_chain is used", () => {
    const d = resolveChain(offpeakCfg(), {}, "k", {}, { taskClass: "bulk", now: OFFPEAK_MON_0500 });
    assert.deepEqual(d.chain, ["ds", "a", "b"]);
    assert.equal(d.offPeakApplied, true);
  });

  it("weekend all-off-peak → off_peak_chain is used", () => {
    const d = resolveChain(offpeakCfg(), {}, "k", {}, { taskClass: "bulk", now: OFFPEAK_SAT_0200 });
    assert.deepEqual(d.chain, ["ds", "a", "b"]);
    assert.equal(d.offPeakApplied, true);
  });

  it("off_peak_chain with NO schedule-declaring provider never triggers (behaves as plain chain)", () => {
    const d = resolveChain(offpeakCfg(), {}, "k", {}, { taskClass: "noSched", now: OFFPEAK_MON_0500 });
    assert.deepEqual(d.chain, ["a", "b"]);
    assert.equal(d.offPeakApplied, false);
  });

  it("sticky still applies WITHIN the resolved off_peak_chain", () => {
    const d = resolveChain(offpeakCfg(), { k: "b" }, "k", {}, { taskClass: "bulk", now: OFFPEAK_MON_0500 });
    assert.deepEqual(d.chain, ["b", "ds", "a"]);
    assert.equal(d.stickyApplied, true);
    assert.equal(d.offPeakApplied, true);
  });

  it("sticky provider not present in the resolved off_peak_chain → sticky ignored, chain unchanged", () => {
    const cfgSolo = offpeakCfg({
      routing: {
        bulk: { chain: ["a", "b"], off_peak_chain: ["ds", "a"] },
        default: ["a"],
      },
    });
    const d = resolveChain(cfgSolo, { k: "b" }, "k", {}, { taskClass: "bulk", now: OFFPEAK_MON_0500 });
    assert.deepEqual(d.chain, ["ds", "a"]);
    assert.equal(d.stickyApplied, false);
    assert.equal(d.offPeakApplied, true);
  });

  it("pinned provider id never consults off-peak logic (even when pinned provider declares a schedule)", () => {
    const peakPin = resolveChain(offpeakCfg(), {}, "k", {}, { taskClass: "bulk", model: "ds", now: PEAK_MON_0200 });
    assert.deepEqual(peakPin.chain, ["ds"]);
    assert.equal(peakPin.pinnedProvider, "ds");
    assert.equal(peakPin.offPeakApplied, false);

    const offpeakPin = resolveChain(offpeakCfg(), {}, "k", {}, {
      taskClass: "bulk",
      model: "a",
      now: OFFPEAK_MON_0500,
    });
    assert.deepEqual(offpeakPin.chain, ["a"]);
    assert.equal(offpeakPin.pinnedProvider, "a");
    assert.equal(offpeakPin.offPeakApplied, false);
  });

  it("selection is deterministic: same clock → same chain, never load-balanced or rotated", () => {
    const d1 = resolveChain(offpeakCfg(), {}, "k", {}, { taskClass: "bulk", now: OFFPEAK_MON_0500 });
    const d2 = resolveChain(offpeakCfg(), {}, "k", {}, { taskClass: "bulk", now: OFFPEAK_MON_0500 });
    assert.deepEqual(d1, d2);
  });

  it("unknown task class still resolves to an empty chain (server 502s, unchanged)", () => {
    const d = resolveChain(offpeakCfg(), {}, "k", {}, { taskClass: "ghost", now: OFFPEAK_MON_0500 });
    assert.deepEqual(d.chain, []);
  });

  it("class allowlist is per key+class and unaffected by chain shape", () => {
    const k = { allowed_task_classes: ["bulk"] };
    assert.equal(isClassAllowed(k, "bulk"), true);
    assert.equal(isClassAllowed(k, "plain"), false);
  });
});

// ---------------------------------------------------------------------------
// Config validation: off_peak schedules + array/object routing forms.
// ---------------------------------------------------------------------------

function writeCfg(dir: string, obj: unknown): string {
  const p = join(dir, "cfg.json");
  writeFileSync(p, JSON.stringify(obj));
  return p;
}

const VALID_BASE = {
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

describe("off-peak config validation", () => {
  it("accepts a provider with a valid off_peak schedule and preserves it verbatim", () => {
    const dir = tmpDir();
    try {
      const cfg = loadConfig(writeCfg(dir, {
        ...VALID_BASE,
        providers: {
          ...VALID_BASE.providers,
          ds: { ...VALID_BASE.providers.p1, off_peak: DEEPSEEK_SCHEDULE },
        },
      }));
      assert.deepEqual(cfg.providers["ds"]!.off_peak, DEEPSEEK_SCHEDULE);
      assert.equal(cfg.providers["p1"]!.off_peak, undefined);
    } finally {
      cleanupDir(dir);
    }
  });

  it("rejects malformed schedules, naming the provider and field path", () => {
    const cases: Array<[unknown, RegExp]> = [
      ["not-an-object", /off_peak/],
      [{ peak_utc: [] }, /peak_utc/],
      [{ peak_utc: "01:00" }, /peak_utc/],
      [{ peak_utc: [{}] }, /days/],
      [{ peak_utc: [{ days: [7], start: "01:00", end: "02:00" }] }, /days/],
      [{ peak_utc: [{ days: [-1], start: "01:00", end: "02:00" }] }, /days/],
      [{ peak_utc: [{ days: [1.5], start: "01:00", end: "02:00" }] }, /days/],
      [{ peak_utc: [{ days: "mon", start: "01:00", end: "02:00" }] }, /days/],
      [{ peak_utc: [{ days: [], start: "01:00", end: "02:00" }] }, /days/],
      [{ peak_utc: [{ days: [1], start: "1:00", end: "02:00" }] }, /start/],
      [{ peak_utc: [{ days: [1], start: "25:00", end: "26:00" }] }, /start/],
      [{ peak_utc: [{ days: [1], start: "01:60", end: "02:00" }] }, /start/],
      [{ peak_utc: [{ days: [1], start: "0100", end: "02:00" }] }, /start/],
      [{ peak_utc: [{ days: [1], start: "01:00", end: "01:60" }] }, /end/],
      [{ peak_utc: [{ days: [1], start: "10:00", end: "09:00" }] }, /start.*end|end.*start|window/],
      [{ peak_utc: [{ days: [1], start: "09:00", end: "09:00" }] }, /window/],
      [{ peak_utc: [{ days: [1], start: "23:00", end: "02:00" }] }, /window/],
      [{ peak_utc: [{ days: [1], start: "01:00", end: "02:00" }], tz: "UTC" }, /tz|unknown/i],
      [{ peak_utc: [{ days: [1], start: "01:00", end: "02:00", label: "morning" }] }, /label|unknown/i],
    ];
    for (const [offPeak, re] of cases) {
      const dir = tmpDir();
      try {
        const p = writeCfg(dir, {
          ...VALID_BASE,
          providers: { ...VALID_BASE.providers, ds: { ...VALID_BASE.providers.p1, off_peak: offPeak } },
        });
        assert.throws(() => loadConfig(p), re, `expected rejection for ${JSON.stringify(offPeak)}`);
      } finally {
        cleanupDir(dir);
      }
    }
  });

  it("accepts routing entries as arrays OR { chain, off_peak_chain } objects, mixed freely", () => {
    const dir = tmpDir();
    try {
      const cfg = loadConfig(writeCfg(dir, {
        ...VALID_BASE,
        routing: {
          bulk: { chain: ["p1"], off_peak_chain: ["p1"] },
          "long-run": { chain: ["p1"] }, // off_peak_chain omitted — legal
          default: ["p1"], // array form — legal, coexists
        },
      }));
      const bulk = cfg.routing["bulk"]!;
      assert.ok(!Array.isArray(bulk));
      assert.deepEqual(bulk.chain, ["p1"]);
      assert.deepEqual(bulk.off_peak_chain, ["p1"]);
      assert.deepEqual(cfg.routing["default"], ["p1"]);
    } finally {
      cleanupDir(dir);
    }
  });

  it("rejects malformed object routing forms", () => {
    const cases: Array<[unknown, RegExp]> = [
      [{}, /chain/],
      [{ off_peak_chain: ["p1"] }, /chain/],
      [{ chain: [] }, /chain/],
      [{ chain: "p1" }, /chain/],
      [{ chain: ["p1"], off_peak_chain: [] }, /off_peak_chain/],
      [{ chain: ["p1"], off_peak_chain: "p1" }, /off_peak_chain/],
      [{ chain: ["p1"], nope: ["p1"] }, /nope|unknown/i],
      ["p1", /routing/],
      [123, /routing/],
    ];
    for (const [entry, re] of cases) {
      const dir = tmpDir();
      try {
        const p = writeCfg(dir, { ...VALID_BASE, routing: { bulk: entry, default: ["p1"] } });
        assert.throws(() => loadConfig(p), re, `expected rejection for ${JSON.stringify(entry)}`);
      } finally {
        cleanupDir(dir);
      }
    }
  });

  it("rejects unknown provider ids in off_peak_chain (cross-reference check)", () => {
    const dir = tmpDir();
    try {
      const p = writeCfg(dir, {
        ...VALID_BASE,
        routing: { bulk: { chain: ["p1"], off_peak_chain: ["ghost"] }, default: ["p1"] },
      });
      assert.throws(() => loadConfig(p), /routing\.bulk\.off_peak_chain.*unknown provider "ghost"/);
    } finally {
      cleanupDir(dir);
    }
  });

  it("still requires the default chain when another class uses the object form", () => {
    const dir = tmpDir();
    try {
      const p = writeCfg(dir, { ...VALID_BASE, routing: { bulk: { chain: ["p1"] } } });
      assert.throws(() => loadConfig(p), /default/);
    } finally {
      cleanupDir(dir);
    }
  });

  it("shipped config.example.json carries the deepseek off-peak lane", () => {
    const cfg = loadConfig(join(import.meta.dirname, "..", "config.example.json"));
    const ds = cfg.providers["deepseek"];
    assert.ok(ds, "deepseek provider must exist in the example config");
    assert.equal(ds!.model_id, "deepseek-v4-flash");
    assert.equal(ds!.api_key_env, "DEEPSEEK_API_KEY");
    assert.deepEqual(ds!.pricing, { input_per_mtok: 0.22, output_per_mtok: 0.66 });
    assert.deepEqual(ds!.off_peak, DEEPSEEK_SCHEDULE);
    const bulk = cfg.routing["bulk"]!;
    assert.ok(!Array.isArray(bulk), "example routing.bulk must use the object form");
    assert.equal(bulk.chain[0], "deepseek-flash");
    assert.equal(bulk.off_peak_chain![0], "deepseek");
  });
});

// ---------------------------------------------------------------------------
// End-to-end: server honors the resolved chain, logs window=off-peak, pins win.
// ---------------------------------------------------------------------------

const UNSET_KEY = "LG_TEST_OFFPEAK_DEFINITELY_UNSET_KEY";

function serverCfg(dir: string): GatewayConfig {
  return {
    port: 0,
    host: "127.0.0.1",
    storage_dir: dir,
    admin_key: "admin-offpeak-test",
    connect_timeout_ms: 300,
    max_retries_per_provider: 0,
    retry_backoff_base_ms: 1,
    body_limit_mb: 10,
    providers: {
      "peak-mock": mockProvider("peak-mock"),
      "cheap-mock": mockProvider("cheap-mock"),
      // stands in for an unfunded provider: env var never exported → warn+skip
      deepseek: {
        type: "openai",
        base_url: "https://api.invalid.example/v1",
        api_key_env: UNSET_KEY,
        model_id: "deepseek-chat",
        pricing: { input_per_mtok: 0.27, output_per_mtok: 1.1 },
        task_classes: ["bulk"],
        off_peak: DEEPSEEK_SCHEDULE,
      },
    },
    keys: { [TEST_KEY]: { project: "proj-offpeak" } },
    routing: {
      bulk: { chain: ["peak-mock"], off_peak_chain: ["deepseek", "cheap-mock"] },
      default: ["peak-mock"],
    },
    budgets: {},
  };
}

describe("off-peak routing end-to-end (fixed clock)", () => {
  delete process.env[UNSET_KEY]; // stands in for an unfunded provider account

  interface Started {
    srv: RunningServer;
    dir: string;
  }
  async function startAt(now: Date): Promise<Started> {
    const dir = tmpDir();
    const srv = await startServer(serverCfg(dir), dir, { now: () => now });
    return { srv, dir };
  }

  it("off-peak: unfunded off_peak_chain head is warn+skipped, next provider in THAT chain serves", async () => {
    const { srv, dir } = await startAt(OFFPEAK_MON_0500);
    try {
      const r = await chat(srv.port, TEST_KEY, { messages: [{ role: "user", content: "hi" }], stream: false }, { "x-task-class": "bulk" });
      assert.equal(r.status, 200);
      assert.equal(r.headers["x-lg-provider"], "cheap-mock");
      assert.equal(r.headers["x-lg-fallback-used"], "true");
    } finally {
      await srv.close();
      cleanupDir(dir);
    }
  });

  it("peak: the plain chain serves, off_peak_chain never consulted", async () => {
    const { srv, dir } = await startAt(PEAK_MON_0200);
    try {
      const r = await chat(srv.port, TEST_KEY, { messages: [{ role: "user", content: "hi" }], stream: false }, { "x-task-class": "bulk" });
      assert.equal(r.status, 200);
      assert.equal(r.headers["x-lg-provider"], "peak-mock");
      assert.equal(r.headers["x-lg-fallback-used"], "false");
    } finally {
      await srv.close();
      cleanupDir(dir);
    }
  });

  it("weekend: all-day off-peak → off_peak_chain serves", async () => {
    const { srv, dir } = await startAt(OFFPEAK_SAT_0200);
    try {
      const r = await chat(srv.port, TEST_KEY, { messages: [{ role: "user", content: "hi" }], stream: false }, { "x-task-class": "bulk" });
      assert.equal(r.headers["x-lg-provider"], "cheap-mock");
    } finally {
      await srv.close();
      cleanupDir(dir);
    }
  });

  it("request log line notes window=off-peak only when the off_peak_chain resolved", async () => {
    const { srv, dir } = await startAt(OFFPEAK_MON_0500);
    try {
      const capture = mockLog();
      try {
        await chat(srv.port, TEST_KEY, { messages: [{ role: "user", content: "hi" }], stream: false }, { "x-task-class": "bulk" });
        assert.ok(
          capture.lines().some((l) => l.includes("[lg]") && l.includes("window=off-peak")),
          `expected a window=off-peak log line, got:\n${capture.lines().join("\n")}`,
        );
      } finally {
        capture.restore();
      }
    } finally {
      await srv.close();
      cleanupDir(dir);
    }

    const peak = await startAt(PEAK_MON_0200);
    try {
      const capture = mockLog();
      try {
        await chat(peak.srv.port, TEST_KEY, { messages: [{ role: "user", content: "hi" }], stream: false }, { "x-task-class": "bulk" });
        assert.equal(
          capture.lines().some((l) => l.includes("window=off-peak")),
          false,
          "peak-time request must NOT log window=off-peak",
        );
      } finally {
        capture.restore();
      }
    } finally {
      await peak.srv.close();
      cleanupDir(peak.dir);
    }
  });

  it("pinned provider id bypasses off-peak selection even at the HTTP surface", async () => {
    const { srv, dir } = await startAt(OFFPEAK_MON_0500);
    try {
      const r = await chat(srv.port, TEST_KEY, {
        model: "peak-mock",
        messages: [{ role: "user", content: "hi" }],
        stream: false,
      });
      assert.equal(r.status, 200);
      assert.equal(r.headers["x-lg-provider"], "peak-mock");
    } finally {
      await srv.close();
      cleanupDir(dir);
    }
  });
});
