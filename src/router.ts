/**
 * Pure routing decisions — no I/O. Sticky cache-affinity is failure-only:
 * the last-good provider is moved to the chain head; it is never load-balanced
 * away from while it keeps succeeding.
 *
 * OFF-PEAK SEMANTIC (pinned — do not drift):
 *   A routing class entry may be `string[]` (the chain, always) or
 *   `{ chain, off_peak_chain }`. The off_peak_chain is used IFF at least one
 *   provider LISTED IN IT declares an `off_peak` schedule AND that schedule is
 *   currently off-peak at the request's UTC time (see isOffPeak); otherwise
 *   the plain chain is used. Off-peak is a pure predicate of (now, schedule)
 *   evaluated per provider — schedule-less providers never trigger (or block)
 *   the switch. Pinned provider ids (model == provider id) bypass chain
 *   resolution entirely, including this check. Sticky reorder happens AFTER
 *   the chain is chosen, within whichever chain won. `now` is injectable for
 *   deterministic tests; production callers default to the real clock.
 */

import type { GatewayConfig, OffPeakSchedule, RoutingChain } from "./config.ts";
import type { StickyMap } from "./storage.ts";

const HHMM_RE = /^([01]\d|2[0-3]):([0-5]\d)$/;

/** "HH:MM" (validated shape) -> minutes-of-day. */
function hhmmMinutes(s: string): number {
  const m = HHMM_RE.exec(s)!;
  return Number(m[1]) * 60 + Number(m[2]);
}

/**
 * Off-peak = outside ALL peak windows. Window bounds are minute-resolution,
 * half-open [start, end): start inclusive, end exclusive, so 01:00:00 is peak
 * and 04:00:00 is off-peak. UTC weekdays absent from every window's `days`
 * are ALL-DAY off-peak (that is how "weekends all off-peak" is encoded).
 * Requires a config-validated schedule (windows never cross midnight).
 */
export function isOffPeak(now: Date, schedule: OffPeakSchedule): boolean {
  const day = now.getUTCDay();
  const minutes = now.getUTCHours() * 60 + now.getUTCMinutes();
  for (const w of schedule.peak_utc) {
    if (!w.days.includes(day)) continue;
    if (minutes >= hhmmMinutes(w.start) && minutes < hhmmMinutes(w.end)) return false;
  }
  return true;
}

export interface TaskClassDecision {
  taskClass: string; // always a key of cfg.routing (validated config guarantees "default")
  unknownClass: boolean;
}

/** Resolve the effective task class from X-Task-Class header. Unknown → "default" chain (per spec). */
export function resolveTaskClass(
  routing: GatewayConfig["routing"],
  opts: { headerValue?: string | null },
): TaskClassDecision {
  const v = opts.headerValue?.trim();
  if (!v) return { taskClass: "default", unknownClass: false };
  if (v in routing) return { taskClass: v, unknownClass: false };
  return { taskClass: "default", unknownClass: true };
}

export interface RouteDecision {
  /** ordered provider ids to attempt */
  chain: string[];
  pinnedProvider?: string;
  stickyApplied: boolean;
  /** true when the off_peak_chain resolved the chain (surfaced on the [lg] request line) */
  offPeakApplied: boolean;
}

/** Only the key fields routing actually reads — keeps these functions decoupled from full KeyConfig. */
export interface RoutingKeyInfo {
  sticky_provider_hint?: string;
  allowed_task_classes?: string[];
}

/**
 * Build the attempt order for one request.
 * - model naming a configured provider → pinned single-provider chain (never
 *   consults off-peak logic)
 * - otherwise cfg.routing[taskClass]; for object-form entries the
 *   off_peak_chain replaces the chain when the pinned off-peak rule fires
 * - sticky state (observed last-good, else key hint) is promoted to head if
 *   present in the RESOLVED chain
 */
export function resolveChain(
  cfg: Pick<GatewayConfig, "providers" | "routing">,
  sticky: StickyMap,
  keyId: string,
  keyCfg: RoutingKeyInfo | undefined,
  opts: { taskClass: string; model?: unknown; now?: Date },
): RouteDecision {
  const model = typeof opts.model === "string" ? opts.model : undefined;

  let base: string[];
  let pinnedProvider: string | undefined;
  let offPeakApplied = false;
  if (model && model in cfg.providers) {
    pinnedProvider = model;
    base = [model];
  } else {
    const entry: RoutingChain | undefined = cfg.routing[opts.taskClass];
    base = [...(Array.isArray(entry) ? entry : entry?.chain ?? [])];
    const offPeakChain = Array.isArray(entry) ? undefined : entry?.off_peak_chain;
    if (offPeakChain !== undefined && offPeakChain.length > 0) {
      const now = opts.now ?? new Date();
      // The pinned rule: switch chains iff some provider in the
      // off_peak_chain declares a schedule and is off-peak right now.
      const triggered = offPeakChain.some((pid) => {
        const schedule = cfg.providers[pid]?.off_peak;
        return schedule !== undefined && isOffPeak(now, schedule);
      });
      if (triggered) {
        base = [...offPeakChain];
        offPeakApplied = true;
      }
    }
  }

  const stickyProvider = sticky[keyId] ?? keyCfg?.sticky_provider_hint;
  let chain = base;
  let stickyApplied = false;
  if (stickyProvider && base.includes(stickyProvider)) {
    chain = [stickyProvider, ...base.filter((p) => p !== stickyProvider)];
    stickyApplied = true;
  }
  return { chain, pinnedProvider, stickyApplied, offPeakApplied };
}

export function isClassAllowed(keyCfg: RoutingKeyInfo | undefined, taskClass: string): boolean {
  const allowed = keyCfg?.allowed_task_classes;
  if (!allowed || allowed.length === 0) return true;
  return allowed.includes(taskClass);
}

export function budgetExceeded(spendUsd: number, capUsd: number): boolean {
  return spendUsd >= capUsd;
}
