/**
 * API key handling for the machine surface (anex/container-parity).
 *
 * Follows the same shape as Pankha's agent tokens: a prefixed random secret,
 * only ever compared as a SHA-256 digest, verified in constant time.
 *
 * Two things this fixes over the previous plain `===` check:
 *  - a string compare short-circuits on the first differing byte and on a
 *    length mismatch, which leaks both
 *  - the running process no longer needs the plaintext at all — it holds the
 *    digest, so the key cannot be read back out of the bridge
 *
 * SHA-256 rather than scrypt (which `passwords.ts` uses for accounts) on
 * purpose: this is a 192-bit random secret, not a human-chosen password, so
 * there is no dictionary to slow down — and the check runs on every single
 * API request, where a deliberately expensive KDF would be the bottleneck.
 */
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';

const KEY_PREFIX = 'spb_';
const KEY_BYTES = 24;

/** Where the digest lives when the bridge mints its own key. */
export const API_KEY_HASH_SETTING_KEY = 'bridge.api_key_hash';

/** Self-identifying so a leaked key is recognisable in a log or a paste. */
export const mintApiKey = (): string =>
  KEY_PREFIX + randomBytes(KEY_BYTES).toString('base64url');

export const hashApiKey = (key: string): string =>
  createHash('sha256').update(key).digest('hex');

/** Constant-time check of a presented key against a stored digest. */
export const verifyApiKey = (
  presented: string,
  storedHash: string | null | undefined,
): boolean => {
  if (!presented || !storedHash) return false;
  const actual = Buffer.from(hashApiKey(presented), 'hex');
  const expected = Buffer.from(storedHash, 'hex');
  // Digests are fixed-width, so this only guards against a malformed stored
  // value — timingSafeEqual throws on length mismatch, and a throw is itself
  // a timing signal.
  return actual.length === expected.length && timingSafeEqual(actual, expected);
};
