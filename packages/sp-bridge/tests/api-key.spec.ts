import { describe, expect, it } from 'vitest';
import {
  CURRENT_KEY_VERSION,
  formatApiKey,
  materialFor,
  mintSalt,
  parseKeyId,
  verifyApiKey,
  type ApiKeyMaterial,
} from '../src/auth/api-key';

const SECRET = 'test-jwt-secret';

const material = (over: Partial<ApiKeyMaterial> = {}): ApiKeyMaterial => ({
  userId: 1,
  keyId: 7,
  salt: 'AAAAAAAAAAAA',
  version: CURRENT_KEY_VERSION,
  ...over,
});

describe('formatApiKey', () => {
  // The whole point of deriving rather than storing: an owner can re-read their key at any time.
  it('is deterministic for the same material and secret', () => {
    expect(formatApiKey(SECRET, material())).toBe(formatApiKey(SECRET, material()));
  });

  it('starts with spk_ and encodes the key id in base36', () => {
    // 36 in base36 is "10", which would collide with a decimal reading of the same id.
    expect(formatApiKey(SECRET, material({ keyId: 36 }))).toMatch(/^spk_10_/);
  });

  it('changes when the version is bumped', () => {
    // Rotation without changing the row id depends on this.
    expect(formatApiKey(SECRET, material({ version: 2 }))).not.toBe(
      formatApiKey(SECRET, material()),
    );
  });

  it('changes when the salt changes', () => {
    expect(formatApiKey(SECRET, material({ salt: 'BBBBBBBBBBBB' }))).not.toBe(
      formatApiKey(SECRET, material()),
    );
  });

  it('changes when the user id changes', () => {
    // Two rows sharing a keyId across users must never derive the same key.
    expect(formatApiKey(SECRET, material({ userId: 2 }))).not.toBe(
      formatApiKey(SECRET, material()),
    );
  });

  it('changes when the signing secret changes', () => {
    expect(formatApiKey('other-secret', material())).not.toBe(
      formatApiKey(SECRET, material()),
    );
  });
});

describe('parseKeyId', () => {
  it('round-trips the key id a formatted key carries', () => {
    for (const keyId of [1, 7, 35, 36, 1295, 1296]) {
      const key = formatApiKey(SECRET, material({ keyId }));
      expect(parseKeyId(key)).toBe(keyId);
    }
  });

  it('rejects anything without the spk_ prefix', () => {
    expect(parseKeyId('7_abcdef')).toBeNull();
    expect(parseKeyId('')).toBeNull();
    expect(parseKeyId('Bearer spk_7_abcdef')).toBeNull();
  });

  it('rejects a key with no digest half', () => {
    expect(parseKeyId('spk_7')).toBeNull();
    expect(parseKeyId('spk_7_')).toBeNull();
  });

  it('rejects a non-positive or unparseable id', () => {
    expect(parseKeyId('spk_0_abcdef')).toBeNull();
    expect(parseKeyId('spk___abcdef')).toBeNull();
  });
});

describe('verifyApiKey', () => {
  it('accepts the key its own material produces', () => {
    const m = material();
    expect(verifyApiKey(formatApiKey(SECRET, m), SECRET, m)).toBe(true);
  });

  it('rejects a key minted under a different secret', () => {
    const m = material();
    expect(verifyApiKey(formatApiKey('other-secret', m), SECRET, m)).toBe(false);
  });

  it('rejects a key from a superseded version', () => {
    // Bumping the stored version is how revocation-by-rotation works.
    const old = formatApiKey(SECRET, material({ version: 1 }));
    expect(verifyApiKey(old, SECRET, material({ version: 2 }))).toBe(false);
  });

  it('rejects a key whose row now holds a different salt', () => {
    const key = formatApiKey(SECRET, material());
    expect(verifyApiKey(key, SECRET, material({ salt: 'BBBBBBBBBBBB' }))).toBe(false);
  });

  it('rejects a truncated key without throwing', () => {
    // timingSafeEqual throws on length mismatch, so the length guard has to come first.
    const key = formatApiKey(SECRET, material());
    expect(() => verifyApiKey(key.slice(0, -1), SECRET, material())).not.toThrow();
    expect(verifyApiKey(key.slice(0, -1), SECRET, material())).toBe(false);
  });

  it('rejects an empty presented key', () => {
    expect(verifyApiKey('', SECRET, material())).toBe(false);
  });
});

describe('materialFor', () => {
  it('uses the row primary key as the key id', () => {
    const m = materialFor({ id: 42, userId: 3, salt: 'CCCCCCCCCCCC', version: 1 });
    expect(m).toEqual({ keyId: 42, userId: 3, salt: 'CCCCCCCCCCCC', version: 1 });
  });
});

describe('mintSalt', () => {
  it('produces a fresh base64url salt each call', () => {
    const salts = new Set(Array.from({ length: 50 }, () => mintSalt()));
    expect(salts.size).toBe(50);
    for (const s of salts) expect(s).toMatch(/^[A-Za-z0-9_-]+$/);
  });
});
