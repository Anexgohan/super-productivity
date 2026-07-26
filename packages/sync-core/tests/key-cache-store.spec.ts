import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  clearSessionKeyCache,
  decrypt,
  encrypt,
  getSessionKeyCacheStats,
  setArgon2ParamsForTesting,
  setDeploymentEncryptSalt,
  setKeyCacheStore,
  type KeyCacheStore,
} from '../src/encryption';

/** Stands in for localStorage, and records writes so a "reload" can replay them. */
const createStore = (): KeyCacheStore & { value: string | null; saves: number } => ({
  value: null,
  saves: 0,
  load() {
    return this.value;
  },
  save(serialized: string) {
    this.value = serialized;
    this.saves++;
  },
});

const PASSWORD = 'correct horse battery staple';

describe('key cache persistence', () => {
  beforeAll(() => {
    setArgon2ParamsForTesting({ parallelism: 1, memorySize: 8, iterations: 1 });
  });

  afterAll(() => {
    setArgon2ParamsForTesting();
    setKeyCacheStore(null);
    setDeploymentEncryptSalt(null);
  });

  beforeEach(() => {
    setKeyCacheStore(null);
    setDeploymentEncryptSalt(null);
    clearSessionKeyCache();
  });

  it('survives a reload, so the second load derives nothing', async () => {
    const store = createStore();
    setKeyCacheStore(store);

    const cipher = await encrypt('hello', PASSWORD);
    expect(await decrypt(cipher, PASSWORD)).toBe('hello');
    expect(getSessionKeyCacheStats().decryptKeyCount).toBe(1);
    expect(store.value).not.toBeNull();

    // A reload: memory is gone, the store is not.
    const persisted = store.value;
    clearSessionKeyCache();
    expect(getSessionKeyCacheStats().decryptKeyCount).toBe(0);

    store.value = persisted;
    setKeyCacheStore(store);
    expect(getSessionKeyCacheStats().decryptKeyCount).toBe(1);
    expect(await decrypt(cipher, PASSWORD)).toBe('hello');
  });

  it('keeps one entry per salt, which is the cost being avoided', async () => {
    const store = createStore();
    setKeyCacheStore(store);

    // Two payloads written under different salts, as ops from different days are.
    setDeploymentEncryptSalt(new Uint8Array(16).fill(1));
    const first = await encrypt('one', PASSWORD);
    setDeploymentEncryptSalt(new Uint8Array(16).fill(2));
    const second = await encrypt('two', PASSWORD);

    await decrypt(first, PASSWORD);
    await decrypt(second, PASSWORD);
    expect(getSessionKeyCacheStats().decryptKeyCount).toBe(2);

    const persisted = store.value;
    clearSessionKeyCache();
    store.value = persisted;
    setKeyCacheStore(store);

    expect(getSessionKeyCacheStats().decryptKeyCount).toBe(2);
    expect(await decrypt(first, PASSWORD)).toBe('one');
    expect(await decrypt(second, PASSWORD)).toBe('two');
  });

  it('ignores entries derived from a different password', async () => {
    const store = createStore();
    setKeyCacheStore(store);
    const cipher = await encrypt('secret', PASSWORD);
    await decrypt(cipher, PASSWORD);

    const persisted = store.value;
    clearSessionKeyCache();
    store.value = persisted;
    setKeyCacheStore(store);

    // The entry is present but keyed by the other password's hash, so it is never consulted, and the wrong password still fails.
    await expect(decrypt(cipher, 'a different password')).rejects.toBeTruthy();
  });

  it('discards a corrupt store rather than failing to decrypt', async () => {
    const store = createStore();
    store.value = 'not json at all';
    setKeyCacheStore(store);
    expect(getSessionKeyCacheStats().decryptKeyCount).toBe(0);

    const cipher = await encrypt('still works', PASSWORD);
    expect(await decrypt(cipher, PASSWORD)).toBe('still works');
  });

  it('does not touch a store when none is installed', async () => {
    const store = createStore();
    setKeyCacheStore(null);
    const cipher = await encrypt('no store', PASSWORD);
    await decrypt(cipher, PASSWORD);
    expect(store.saves).toBe(0);
    expect(store.value).toBeNull();
  });
});
