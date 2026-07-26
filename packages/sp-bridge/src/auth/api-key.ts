/**
 * Per-user API keys for the machine surface (anex/container-parity).
 *
 * A key is DERIVED, never stored:
 *
 *   HMAC(JWT_SECRET, "api-key:v1:<userId>:<keyId>:<salt>:<version>")
 *
 * so the database holds only the ingredients (user id, key id, salt, version) and none of them is a secret.
 * A leaked backup yields no working key, and there is no digest sitting in the process to steal either.
 *
 * The property that shapes the UI: derivation is repeatable, so a key can be shown to its owner whenever they ask.
 * Upstream-style "copy it now, you will never see it again" exists only because the server threw the plaintext away.
 *
 * Rotation without changing the id: bump `version`. The previous derivation stops verifying and the row keeps its history.
 *
 * HMAC-SHA256 rather than scrypt because this is a 96-bit random secret with no dictionary to slow down, checked on every request.
 */
import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

const KEY_PREFIX = 'spk_';

/** 96 bits of base64url is 16 chars; with the prefix and key id a whole key is ~23, short enough to paste by hand. */
const DIGEST_BITS = 96;
const DIGEST_CHARS = DIGEST_BITS / 6;

/** Only has to make two rows sharing a (userId, keyId) derive differently. */
const SALT_BYTES = 9;

export const CURRENT_KEY_VERSION = 1;

export interface ApiKeyMaterial {
  userId: number;
  keyId: number;
  salt: string;
  version: number;
}

export const mintSalt = (): string => randomBytes(SALT_BYTES).toString('base64url');

/** Adapts a stored row to derivation material: the row's primary key IS the key id. */
export const materialFor = (row: {
  id: number;
  userId: number;
  salt: string;
  version: number;
}): ApiKeyMaterial => ({
  userId: row.userId,
  keyId: row.id,
  salt: row.salt,
  version: row.version,
});

/** Deterministic: the same material always yields the same string, which is what lets an owner re-read their key. */
const deriveDigest = (jwtSecret: string, m: ApiKeyMaterial): string =>
  createHmac('sha256', jwtSecret)
    .update(`api-key:v1:${m.userId}:${m.keyId}:${m.salt}:${m.version}`)
    .digest('base64url')
    .slice(0, DIGEST_CHARS);

/** The key id travels in the clear (base36) so verification is one indexed lookup, not a scan deriving every row. */
export const formatApiKey = (jwtSecret: string, m: ApiKeyMaterial): string =>
  `${KEY_PREFIX}${m.keyId.toString(36)}_${deriveDigest(jwtSecret, m)}`;

/** The key id a presented key claims, or null when it is not one of ours. */
export const parseKeyId = (presented: string): number | null => {
  if (!presented.startsWith(KEY_PREFIX)) return null;
  const [rawId, digest] = presented.slice(KEY_PREFIX.length).split('_');
  if (!rawId || !digest) return null;
  const keyId = Number.parseInt(rawId, 36);
  return Number.isInteger(keyId) && keyId > 0 ? keyId : null;
};

/**
 * Constant-time check of a presented key against the material its claimed row holds.
 * Callers look the row up by parseKeyId() first; a revoked or absent row must never reach here.
 */
export const verifyApiKey = (
  presented: string,
  jwtSecret: string,
  m: ApiKeyMaterial,
): boolean => {
  const expected = Buffer.from(formatApiKey(jwtSecret, m));
  const actual = Buffer.from(presented);
  // Lengths are fixed by construction, so a mismatch means a malformed key. timingSafeEqual throws on unequal lengths, and a throw is a timing signal.
  return actual.length === expected.length && timingSafeEqual(actual, expected);
};
