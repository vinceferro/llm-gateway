/**
 * Gateway key verification. Keys in config are either plaintext (fine for a
 * chmod-600 local file) or "sha256:<hex>" hashes — `npm run hash-key -- <secret>`.
 */

import { createHash, timingSafeEqual } from "node:crypto";

export function hashSecret(secret: string): string {
  return "sha256:" + createHash("sha256").update(secret).digest("hex");
}

/** Constant-time comparison of a stored secret/hash against a presented bearer value. */
export function verifySecret(stored: string, presented: string): boolean {
  const a =
    stored.startsWith("sha256:")
      ? Buffer.from(stored.slice("sha256:".length), "hex")
      : Buffer.from(stored, "utf8");
  const b = stored.startsWith("sha256:")
    ? Buffer.from(hashSecret(presented).slice("sha256:".length), "hex")
    : Buffer.from(presented, "utf8");
  return a.length === b.length && timingSafeEqual(a, b);
}

export function bearerFrom(headers: { authorization?: string | undefined }): string | null {
  const h = headers.authorization;
  if (!h) return null;
  const m = /^Bearer\s+(.+)$/i.exec(h.trim());
  return m ? m[1]! : null;
}
