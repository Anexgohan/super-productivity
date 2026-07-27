import { describe, expect, it } from 'vitest';
import { randomBytes, scrypt } from 'node:crypto';
import { hashPassword, verifyPassword } from '../src/auth/passwords';

// Builds a stored hash at caller-chosen cost, which hashPassword cannot do (its parameters are fixed).
const hashAt = (password: string, N: number, r: number, p: number): Promise<string> => {
  const salt = randomBytes(16);
  return new Promise((resolve, reject) => {
    scrypt(password, salt, 32, { N, r, p, maxmem: 256 * 1024 * 1024 }, (err, key) =>
      err
        ? reject(err)
        : resolve(
            ['scrypt', N, r, p, salt.toString('base64'), key.toString('base64')].join(
              '$',
            ),
          ),
    );
  });
};

describe('hashPassword', () => {
  it('produces the documented scrypt$N$r$p$salt$hash shape', async () => {
    const stored = await hashPassword('correct horse');
    const parts = stored.split('$');
    expect(parts).toHaveLength(6);
    expect(parts[0]).toBe('scrypt');
    // Parameters travel with the hash so they can be raised later without invalidating old accounts.
    expect(Number(parts[1])).toBe(131072);
    expect(Number(parts[2])).toBe(8);
    expect(Number(parts[3])).toBe(1);
  });

  it('salts, so the same password hashes differently every time', async () => {
    const [a, b] = await Promise.all([hashPassword('same'), hashPassword('same')]);
    expect(a).not.toBe(b);
  });
});

describe('verifyPassword', () => {
  it('accepts the password that produced the hash', async () => {
    const stored = await hashPassword('correct horse');
    expect(await verifyPassword('correct horse', stored)).toBe(true);
  });

  it('rejects a wrong password', async () => {
    const stored = await hashPassword('correct horse');
    expect(await verifyPassword('correct horsf', stored)).toBe(false);
  });

  it('rejects an empty password against a real hash', async () => {
    const stored = await hashPassword('correct horse');
    expect(await verifyPassword('', stored)).toBe(false);
  });

  it('verifies a hash stored at different cost parameters', async () => {
    // The forward-compatibility promise: raising SCRYPT_N later must not lock existing accounts out.
    const cheap = await hashAt('legacy pw', 16384, 8, 1);
    expect(await verifyPassword('legacy pw', cheap)).toBe(true);
    expect(await verifyPassword('wrong', cheap)).toBe(false);
  });

  it('rejects malformed stored values instead of throwing', async () => {
    const malformed = [
      '',
      'not-a-hash',
      'scrypt$131072$8$1$onlyfiveparts',
      'scrypt$131072$8$1$c2FsdA==$aGFzaA==$extra',
      'bcrypt$131072$8$1$c2FsdA==$aGFzaA==',
      'scrypt$notanumber$8$1$c2FsdA==$aGFzaA==',
      'scrypt$131072$notanumber$1$c2FsdA==$aGFzaA==',
    ];
    for (const stored of malformed) {
      expect(await verifyPassword('anything', stored)).toBe(false);
    }
  });

  it('rejects rather than throws when scrypt itself refuses the parameters', async () => {
    // N must be a power of two greater than 1; scrypt throws, and a throw would 500 the login route.
    expect(await verifyPassword('pw', 'scrypt$3$8$1$c2FsdA==$aGFzaA==')).toBe(false);
  });
});
