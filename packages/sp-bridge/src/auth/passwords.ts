/**
 * Password hashing — scrypt via node:crypto (no external dependency).
 *
 * Cost parameters are embedded in every stored hash, so they can be raised
 * later without invalidating existing accounts: an old hash keeps verifying
 * with the parameters it was created with.
 */
import { randomBytes, scrypt, timingSafeEqual } from 'node:crypto';

// OWASP-recommended scrypt parameters.
const SCRYPT_N = 131072; // 2^17
const SCRYPT_R = 8;
const SCRYPT_P = 1;
const SALT_BYTES = 16;
const KEY_BYTES = 32;
// scrypt needs 128 * N * r bytes; the default maxmem (32MB) is too low for N=2^17.
const SCRYPT_MAXMEM = 256 * 1024 * 1024;

const derive = (
  password: string,
  salt: Buffer,
  N: number,
  r: number,
  p: number,
): Promise<Buffer> =>
  new Promise((resolve, reject) => {
    scrypt(password, salt, KEY_BYTES, { N, r, p, maxmem: SCRYPT_MAXMEM }, (err, key) =>
      err ? reject(err) : resolve(key as Buffer),
    );
  });

/** Stored format: scrypt$N$r$p$<salt b64>$<hash b64> */
export const hashPassword = async (password: string): Promise<string> => {
  const salt = randomBytes(SALT_BYTES);
  const key = await derive(password, salt, SCRYPT_N, SCRYPT_R, SCRYPT_P);
  return [
    'scrypt',
    SCRYPT_N,
    SCRYPT_R,
    SCRYPT_P,
    salt.toString('base64'),
    key.toString('base64'),
  ].join('$');
};

/** Verifies a password against a stored hash. Timing-safe. */
export const verifyPassword = async (
  password: string,
  stored: string,
): Promise<boolean> => {
  const parts = stored.split('$');
  if (parts.length !== 6 || parts[0] !== 'scrypt') return false;
  const N = Number.parseInt(parts[1], 10);
  const r = Number.parseInt(parts[2], 10);
  const p = Number.parseInt(parts[3], 10);
  if (!Number.isFinite(N) || !Number.isFinite(r) || !Number.isFinite(p)) return false;
  const salt = Buffer.from(parts[4], 'base64');
  const expected = Buffer.from(parts[5], 'base64');
  let actual: Buffer;
  try {
    actual = await derive(password, salt, N, r, p);
  } catch {
    return false;
  }
  return actual.length === expected.length && timingSafeEqual(actual, expected);
};
