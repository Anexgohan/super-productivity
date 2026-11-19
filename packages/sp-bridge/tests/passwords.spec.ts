import { describe, expect, it } from 'vitest';
import { randomBytes, scrypt } from 'node:crypto';
import { hashPassword, needsRehash, verifyPassword } from '../src/auth/passwords';

// Builds a scrypt hash, as stored before the switch to Argon2id, at caller-chosen cost.
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
  it('stores Argon2id at OWASP 19 MiB, 2 passes, in the standard self-describing format', async () => {
    const stored = await hashPassword('correct horse');
    // Parameters travel with the hash so they can be raised later without invalidating old accounts.
    expect(stored).toMatch(
      /^\$argon2id\$v=19\$m=19456,t=2,p=1\$[A-Za-z0-9+/]{22}\$[A-Za-z0-9+/]{43}$/,
    );
    expect(needsRehash(stored)).toBe(false);
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

  it('still verifies a scrypt hash made before the switch, and asks for it to be replaced', async () => {
    // Existing accounts must keep signing in; the matching password is then rehashed with Argon2id.
    const legacy = await hashAt('legacy pw', 16384, 8, 1);
    expect(await verifyPassword('legacy pw', legacy)).toBe(true);
    expect(await verifyPassword('wrong', legacy)).toBe(false);
    expect(needsRehash(legacy)).toBe(true);
  });

  it('asks for a rehash when an Argon2id hash was made at another setting', async () => {
    const stored = await hashPassword('pw');
    const older = stored.replace('m=19456,t=2', 'm=9216,t=4');
    expect(needsRehash(older)).toBe(true);
  });

  it('refuses a stored hash whose cost was tampered upward, instead of allocating it', async () => {
    const stored = await hashPassword('pw');
    expect(await verifyPassword('pw', stored.replace('m=19456', 'm=4194304'))).toBe(
      false,
    );
    expect(await verifyPassword('pw', stored.replace('t=2', 't=99'))).toBe(false);
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
      '$argon2id$v=19$m=19456,t=2,p=1$onlysalt',
      '$argon2id$v=19$m=19456,t=2$c2FsdA$aGFzaA',
      '$argon2i$v=19$m=19456,t=2,p=1$c2FsdA$aGFzaA',
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
