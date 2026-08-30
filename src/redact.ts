/**
 * Redaction for values interpolated into startup warnings (close-out Grey 1).
 *
 * `api_key_env` is validated to be NAME-shaped (src/config.ts), but
 * name-shape is a weak filter: pasted key material can still parse as an
 * env-var NAME (`sk_live_…`, letter-leading hex). When the startup warning
 * prints an unset provider env-var name, the raw value would leak key
 * material into logs/journal. Rule: values longer than 24 chars print as
 * their first 8 chars + "…(redacted)"; values ≤24 chars print as-is — real
 * env-var names are short, so their debug value is preserved.
 */
export function redactLong(value: string): string {
  return value.length > 24 ? value.slice(0, 8) + "…(redacted)" : value;
}
