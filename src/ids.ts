import { randomBytes } from "node:crypto";

// Crockford base32, lowercase. 32 divides 256, so mapping a random byte with
// `% 32` stays uniform.
const ALPHABET = "0123456789abcdefghjkmnpqrstvwxyz";

/**
 * Time-sortable, prefixed id: `<prefix>_` + 10 chars of millisecond timestamp
 * + 16 random chars (80 bits of entropy).
 */
export function newId(prefix: string): string {
  let time = "";
  let t = Date.now();
  for (let i = 0; i < 10; i++) {
    time = ALPHABET[t % 32] + time;
    t = Math.floor(t / 32);
  }
  let rand = "";
  for (const byte of randomBytes(16)) rand += ALPHABET[byte % 32];
  return `${prefix}_${time}${rand}`;
}
