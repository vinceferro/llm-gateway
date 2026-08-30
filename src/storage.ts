/**
 * File-based sticky-affinity state: <storage_dir>/sticky.json
 * Maps gateway key -> last-good provider id. Persisted so prompt-cache
 * affinity survives gateway restarts. Atomic-ish writes (tmp + rename).
 */

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export const STICKY_FILE = "sticky.json";

export type StickyMap = Record<string, string>;

function stickyPath(storageDir: string): string {
  return join(storageDir, STICKY_FILE);
}

export function loadSticky(storageDir: string): StickyMap {
  const p = stickyPath(storageDir);
  if (!existsSync(p)) return {};
  try {
    const parsed = JSON.parse(readFileSync(p, "utf8")) as unknown;
    if (typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)) {
      return parsed as StickyMap;
    }
  } catch {
    /* corrupt — start empty */
  }
  return {};
}

export function saveSticky(storageDir: string, map: StickyMap): void {
  mkdirSync(storageDir, { recursive: true });
  const p = stickyPath(storageDir);
  const tmp = `${p}.tmp`;
  writeFileSync(tmp, JSON.stringify(map, null, 2), "utf8");
  renameSync(tmp, p);
}
