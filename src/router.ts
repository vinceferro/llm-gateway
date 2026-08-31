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

import { providerCapabilities, type GatewayConfig, type OffPeakSchedule, type RoutingChain } from "./config.ts";
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
  /**
   * Set (and chain empty) when a capability requirement filtered the chain
   * down to nothing — server surfaces it as HTTP 422. Never silently downgraded.
   */
  capabilityError?: string;
}

/** Only the key fields routing actually reads — keeps these functions decoupled from full KeyConfig. */
export interface RoutingKeyInfo {
  sticky_provider_hint?: string;
  allowed_task_classes?: string[];
}

/**
 * True when the request carries image content: any message whose `content` is
 * an array containing a part with `type === "image_url"`. Deliberately NARROW:
 * only image_url gates routing this round (input_audio and other part types
 * do not). String content and unknown part types never trigger the gate.
 */
export function requiresVision(body: unknown): boolean {
  if (typeof body !== "object" || body === null) return false;
  const msgs = (body as { messages?: unknown }).messages;
  if (!Array.isArray(msgs)) return false;
  for (const m of msgs) {
    if (typeof m !== "object" || m === null) continue;
    const content = (m as { content?: unknown }).content;
    if (!Array.isArray(content)) continue;
    for (const part of content) {
      if (typeof part === "object" && part !== null && (part as { type?: unknown }).type === "image_url") {
        return true;
      }
    }
  }
  return false;
}

/**
 * Build the attempt order for one request.
 * - model naming a configured provider → pinned single-provider chain (never
 *   consults off-peak logic)
 * - otherwise cfg.routing[taskClass]; for object-form entries the
 *   off_peak_chain replaces the chain when the pinned off-peak rule fires
 * - when opts.requiresVision, providers that do not CLAIM vision (see
 *   providerCapabilities) are skipped IN ORDER — a capability failure, not
 *   load-balancing; the configured order survives. Empty after filtering →
 *   explicit capabilityError (422 upstream), never a silent downgrade.
 *   Requests WITHOUT image parts are never filtered (empty capabilities
 *   change nothing for text).
 * - sticky state (observed last-good, else key hint) is promoted to head if
 *   present in the RESOLVED chain — vision filtering runs BEFORE sticky
 *   reorder, so a text-only sticky provider is skipped for image requests
 */
export function resolveChain(
  cfg: Pick<GatewayConfig, "providers" | "routing">,
  sticky: StickyMap,
  keyId: string,
  keyCfg: RoutingKeyInfo | undefined,
  opts: { taskClass: string; model?: unknown; now?: Date; requiresVision?: boolean },
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

  // Capability gate BEFORE sticky reorder: an image request skips providers
  // that do not claim vision, keeping the configured order (capability
  // failure ≠ load-balancing). Text requests never enter this branch, so
  // chains with no declared capabilities are untouched.
  if (opts.requiresVision) {
    base = base.filter((pid) => providerCapabilities(cfg.providers[pid]).vision);
    if (base.length === 0) {
      return {
        chain: [],
        pinnedProvider,
        stickyApplied: false,
        offPeakApplied,
        capabilityError: `no vision-capable provider in chain for task class "${opts.taskClass}"`,
      };
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
