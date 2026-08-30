/**
 * Print a hash-safe representation of a secret for pasting into config:
 *   npm run hash-key -- sk-my-gateway-key
 * -> sha256:<hex>
 *
 * Config accepts either plaintext (fine for a chmod-600 local file) or this
 * hash form. Hashed keys cannot be recovered — keep the plaintext in your
 * password manager / opencode config.
 */

import { createHash } from "node:crypto";

const secret = process.argv[2];
if (!secret) {
  console.error("usage: npm run hash-key -- <secret>");
  process.exit(2);
}
console.log("sha256:" + createHash("sha256").update(secret).digest("hex"));
