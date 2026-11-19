/**
 * Password hashing (anex/argon2id-passwords): Argon2id at OWASP's headline setting, 19 MiB with 2 passes.
 *
 * Argon2id is OWASP's first choice; OWASP rates this setting as strong as scrypt at N=2^17, which needed 128 MB per hash.
 * On a 256 MB bridge that also runs the app's rules, one scrypt sign-in was enough to get the container killed for memory.
 *
 * Cost parameters travel with every stored hash, so they can be raised later without locking anyone out. Hashes made
 * before the switch (scrypt) still verify; `needsRehash` tells the caller to store a fresh Argon2id hash the moment the
 * password has been typed and checked, so each old account moves over at its next sign-in.
 */
import { randomBytes, scrypt, timingSafeEqual } from 'node:crypto';
import { deriveArgon2idPasswordHash, type Argon2idPasswordParams } from '@sp/sync-core';

/** OWASP Password Storage Cheat Sheet: m=19456 (19 MiB), t=2, p=1. */
const ARGON2ID: Argon2idPasswordParams = {
  memoryKiB: 19456,
  iterations: 2,
  parallelism: 1,
  hashLength: 32,
};
const SALT_BYTES = 16;
/** Ceilings for parameters read back from storage, so a tampered row cannot make one sign-in allocate gigabytes. */
const MAX_MEMORY_KIB = 262144;
const MAX_ITERATIONS = 10;

const ARGON2ID_PREFIX = '$argon2id$v=19$';
/** Stored format, the standard one: $argon2id$v=19$m=<KiB>,t=<passes>,p=<lanes>$<salt>$<hash>, unpadded base64. */
const ARGON2ID_FORMAT =
  /^\$argon2id\$v=19\$m=(\d+),t=(\d+),p=(\d+)\$([A-Za-z0-9+/]+)\$([A-Za-z0-9+/]+)$/;

const b64 = (bytes: Uint8Array): string =>
  Buffer.from(bytes).toString('base64').replace(/=+$/, '');

export const hashPassword = async (password: string): Promise<string> => {
  const salt = randomBytes(SALT_BYTES);
  const hash = await deriveArgon2idPasswordHash(password, salt, ARGON2ID);
  const { memoryKiB: m, iterations: t, parallelism: p } = ARGON2ID;
  return `${ARGON2ID_PREFIX}m=${m},t=${t},p=${p}$${b64(salt)}$${b64(hash)}`;
};

/** True when the stored hash is not Argon2id at today's setting: store a fresh one once the password has been checked. */
export const needsRehash = (stored: string): boolean => {
  const match = ARGON2ID_FORMAT.exec(stored);
  if (!match) return true;
  return (
    Number(match[1]) !== ARGON2ID.memoryKiB ||
    Number(match[2]) !== ARGON2ID.iterations ||
    Number(match[3]) !== ARGON2ID.parallelism
  );
};

/** Verifies a password against a stored hash, Argon2id or the older scrypt. Timing-safe; never throws. */
export const verifyPassword = async (
  password: string,
  stored: string,
): Promise<boolean> => {
  if (stored.startsWith(ARGON2ID_PREFIX)) return verifyArgon2id(password, stored);
  if (stored.startsWith('scrypt$')) return verifyScrypt(password, stored);
  return false;
};

const verifyArgon2id = async (password: string, stored: string): Promise<boolean> => {
  const match = ARGON2ID_FORMAT.exec(stored);
  if (!match) return false;
  const [memoryKiB, iterations, parallelism] = [match[1], match[2], match[3]].map(Number);
  if (
    memoryKiB > MAX_MEMORY_KIB ||
    iterations > MAX_ITERATIONS ||
    iterations < 1 ||
    parallelism !== 1
  ) {
    return false;
  }
  const salt = Buffer.from(match[4], 'base64');
  const expected = Buffer.from(match[5], 'base64');
  try {
    const actual = Buffer.from(
      await deriveArgon2idPasswordHash(password, salt, {
        memoryKiB,
        iterations,
        parallelism,
        hashLength: expected.length,
      }),
    );
    return actual.length === expected.length && timingSafeEqual(actual, expected);
  } catch {
    return false;
  }
};

// ── Hashes made before the switch: scrypt$N$r$p$<salt b64>$<hash b64> ─────────────────────────────────────────────────

// scrypt needs 128 * N * r bytes; the default maxmem (32MB) is too low for the N=2^17 these were made with.
const SCRYPT_MAXMEM = 256 * 1024 * 1024;

const verifyScrypt = async (password: string, stored: string): Promise<boolean> => {
  const parts = stored.split('$');
  if (parts.length !== 6) return false;
  const N = Number.parseInt(parts[1], 10);
  const r = Number.parseInt(parts[2], 10);
  const p = Number.parseInt(parts[3], 10);
  if (!Number.isFinite(N) || !Number.isFinite(r) || !Number.isFinite(p)) return false;
  const salt = Buffer.from(parts[4], 'base64');
  const expected = Buffer.from(parts[5], 'base64');
  let actual: Buffer;
  try {
    actual = await new Promise<Buffer>((resolve, reject) => {
      scrypt(
        password,
        salt,
        expected.length || 32,
        { N, r, p, maxmem: SCRYPT_MAXMEM },
        (err, key) => (err ? reject(err) : resolve(key as Buffer)),
      );
    });
  } catch {
    return false;
  }
  return actual.length === expected.length && timingSafeEqual(actual, expected);
};
