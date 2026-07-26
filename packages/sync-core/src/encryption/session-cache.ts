import { DerivedKey, deriveKeyFromPassword } from './argon2';
import { hashPasswordForCache } from './web-crypto';
import { clearLegacyKeyCache } from './legacy';

// ============================================================================
// SESSION-LEVEL KEY CACHING
// ============================================================================
// Avoids repeated Argon2id derivations (500ms-2000ms per call on mobile).
// In memory by default; a host may install a KeyCacheStore to carry the cache
// across reloads, which is what stops a cold load re-deriving every key it
// already derived last time. Call clearSessionKeyCache() on password change.

interface SessionCacheEntry {
  key: DerivedKey;
  passwordHash: string;
  saltKey: string;
}

// Encrypt cache: most-recently-used key for new encryptions
let sessionEncryptKeyCache: SessionCacheEntry | null = null;

/**
 * Salt every new encryption uses, when the deployment supplies one.
 *
 * Without it each session invents its own salt, so ops written on different days derive different keys.
 * Reading them back costs one ~200ms Argon2id derivation per distinct salt, so an old board takes many seconds to open.
 *
 * One deployment-wide salt makes that a single derivation, which is a salt's intended use rather than a weakening of it.
 * It is random per deployment, so it still blocks precomputation; per-message uniqueness is the IV's job.
 *
 * Decryption is unaffected either way: every payload carries the salt it was written with.
 */
let deploymentEncryptSalt: Uint8Array | null = null;

const saltCacheKey = (salt: Uint8Array | null): string =>
  salt
    ? Array.from(salt, (b) => b.toString(16).padStart(2, '0')).join('')
    : 'per-session';

/** Sets (or with `null` clears) the deployment-wide encryption salt. Clears the encrypt cache, whose key depends on it. */
export const setDeploymentEncryptSalt = (salt: Uint8Array | null): void => {
  const next = saltCacheKey(salt);
  if (saltCacheKey(deploymentEncryptSalt) === next) return;
  deploymentEncryptSalt = salt;
  sessionEncryptKeyCache = null;
};

export const getDeploymentEncryptSalt = (): Uint8Array | null => deploymentEncryptSalt;

// Decrypt cache: "passwordHash:saltBase64" -> derived key (LRU-ish)
const sessionDecryptKeyCache = new Map<string, DerivedKey>();

const SESSION_DECRYPT_CACHE_MAX_SIZE = 100;

/**
 * Somewhere a host can keep the derived-key cache across reloads.
 *
 * Without one, every page load re-derives every key it derived last time.
 * That is the whole cost of a cold load: a board written under 46 salts pays 46 derivations at ~200ms each, every time.
 *
 * Left unset by default, so a host opts in.
 * What gets written is `keyBytes`, which is strictly less sensitive than the password it came from.
 * Anyone who can read this store can already read the sync config beside it, which under container authority holds the password.
 * Hosts that do NOT persist the password should not install a store.
 */
export interface KeyCacheStore {
  load(): string | null;
  save(serialized: string): void;
}

let keyCacheStore: KeyCacheStore | null = null;

const toBase64 = (bytes: Uint8Array): string => {
  let s = '';
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s);
};

const fromBase64 = (b64: string): Uint8Array =>
  Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));

/** Serializes only the key bytes: the salt is recoverable from the cache key, so storing it twice is redundant. */
const persistDecryptCache = (): void => {
  if (!keyCacheStore) return;
  const out: Record<string, string> = {};
  for (const [cacheKey, derived] of sessionDecryptKeyCache) {
    out[cacheKey] = toBase64(derived.keyBytes);
  }
  try {
    keyCacheStore.save(JSON.stringify(out));
  } catch {
    // A full or unavailable store must not break sync: the cost is slowness, not incorrectness.
  }
};

/**
 * Installs a persistence store and hydrates the decrypt cache from it.
 *
 * Entries are keyed by password hash, so a stored key is only found again by the same password; foreign entries are never hit.
 */
export const setKeyCacheStore = (store: KeyCacheStore | null): void => {
  keyCacheStore = store;
  if (!store) return;
  let parsed: Record<string, unknown>;
  try {
    const raw = store.load();
    if (!raw) return;
    parsed = JSON.parse(raw) as Record<string, unknown>;
  } catch {
    // Corrupt or unreadable cache is discarded rather than repaired: it is a cache, and re-deriving is always correct.
    return;
  }
  for (const [cacheKey, value] of Object.entries(parsed)) {
    // lastIndexOf, NOT indexOf: password hashes can contain colons and base64 cannot, so only the final colon starts the salt.
    const saltBase64 = cacheKey.slice(cacheKey.lastIndexOf(':') + 1);
    if (typeof value !== 'string' || !saltBase64) continue;
    try {
      sessionDecryptKeyCache.set(cacheKey, {
        keyBytes: fromBase64(value),
        salt: fromBase64(saltBase64),
      });
    } catch {
      // One unreadable entry must not cost the others: skip it and let that single key be re-derived on demand.
    }
  }
};

/**
 * Clears all session key caches (encrypt + decrypt + legacy PBKDF2).
 * Call when:
 * - User changes their encryption password
 * - User logs out or disables encryption
 * - For security-sensitive operations
 */
export const clearSessionKeyCache = (): void => {
  sessionEncryptKeyCache = null;
  sessionDecryptKeyCache.clear();
  clearLegacyKeyCache();
  // Must reach the store too: those entries are now unreachable, and on logout they should not outlive the session.
  persistDecryptCache();
};

/**
 * Gets statistics about the session key cache (for debugging/monitoring).
 */
export const getSessionKeyCacheStats = (): {
  hasEncryptKey: boolean;
  decryptKeyCount: number;
} => ({
  hasEncryptKey: sessionEncryptKeyCache !== null,
  decryptKeyCount: sessionDecryptKeyCache.size,
});

/**
 * Returns the session-cached encrypt key for the given password, deriving and
 * caching a fresh one on miss.
 */
export const getOrDeriveEncryptKey = async (password: string): Promise<DerivedKey> => {
  const passwordHash = hashPasswordForCache(password);
  const saltKey = saltCacheKey(deploymentEncryptSalt);
  if (
    sessionEncryptKeyCache &&
    sessionEncryptKeyCache.passwordHash === passwordHash &&
    sessionEncryptKeyCache.saltKey === saltKey
  ) {
    return sessionEncryptKeyCache.key;
  }
  const key = await deriveKeyFromPassword(password, deploymentEncryptSalt ?? undefined);
  sessionEncryptKeyCache = { key, passwordHash, saltKey };
  return key;
};

export const getDecryptCache = (cacheKey: string): DerivedKey | undefined =>
  sessionDecryptKeyCache.get(cacheKey);

export const setDecryptCache = (cacheKey: string, key: DerivedKey): void => {
  if (sessionDecryptKeyCache.size >= SESSION_DECRYPT_CACHE_MAX_SIZE) {
    const firstKey = sessionDecryptKeyCache.keys().next().value;
    if (firstKey) {
      sessionDecryptKeyCache.delete(firstKey);
    }
  }
  sessionDecryptKeyCache.set(cacheKey, key);
  persistDecryptCache();
};
