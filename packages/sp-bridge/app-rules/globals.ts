/**
 * The few browser globals the app's code reads while loading (anex/app-rules).
 *
 * Imported first by the worker, so these exist before any app module evaluates. They live only in the worker's own global scope:
 * the bridge's main thread never sees a `window`, so Fastify and pg can't mistake themselves for running in a browser.
 *
 * `navigator` is replaced even on Node versions that ship one, so the app rules behave the same on every Node.
 * Its `locks` is a minimal in-process Web Locks: one promise chain per lock name, the same serialization the app's LockService
 * fallback gives. Without it LockService works the same but logs a multi-tab "DATA LOSS" warning on every archive op,
 * which is meaningless in a single-threaded worker and alarming in the bridge's log.
 */
const define = (name: string, value: unknown): void => {
  Object.defineProperty(globalThis, name, { value, configurable: true, writable: true });
};

type LockCallback = (lock: { name: string; mode: 'exclusive' }) => unknown;
const lockChains = new Map<string, Promise<unknown>>();
const locks = {
  request: (
    name: string,
    optionsOrCallback: unknown,
    maybeCallback?: LockCallback,
  ): Promise<unknown> => {
    const callback = (
      typeof optionsOrCallback === 'function' ? optionsOrCallback : maybeCallback
    ) as LockCallback;
    const previous = lockChains.get(name) ?? Promise.resolve();
    const run = previous.then(() => callback({ name, mode: 'exclusive' }));
    // The next holder waits for this one to finish, whether it succeeded or threw.
    lockChains.set(
      name,
      run.catch(() => undefined),
    );
    return run;
  },
};

define('window', globalThis);
define('navigator', {
  userAgent: 'sp-bridge-app-rules',
  platform: 'linux',
  language: 'en',
  locks,
});
define('localStorage', {
  getItem: (): null => null,
  setItem: (): void => undefined,
  removeItem: (): void => undefined,
  clear: (): void => undefined,
});
// Angular's CDK, which the repeat rules' dialog imports, probes these while loading; no event ever fires in a worker.
define('addEventListener', (): void => undefined);
define('removeEventListener', (): void => undefined);
// The app's dev-only error helpers call these; the production environment never does, but a dialog must never block a worker.
define('alert', (): void => undefined);
define('confirm', (): boolean => false);
