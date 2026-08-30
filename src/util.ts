/** Small shared helpers. */

/** Deterministic char-based token estimate (matches common ~4 chars/token rule of thumb). */
export function estTokens(s: string): number {
  return estTokensFromChars(s.length);
}

/** Same estimate when you already have a character COUNT (e.g. summed SSE deltas). */
export function estTokensFromChars(chars: number): number {
  return Math.max(1, Math.ceil(chars / 4));
}

export function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

export function nowIso(): string {
  return new Date().toISOString();
}

export function currentMonth(): string {
  return new Date().toISOString().slice(0, 7);
}
