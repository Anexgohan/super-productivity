import { StateStore } from './chunk-HHNXVA7Q.js';
import './chunk-BKQKDC6L.js';
import { BridgeCore } from './chunk-KF4YJYKW.js';
import { OpFactory } from './chunk-H2ZLCBDZ.js';

// src/user-boards.ts
var DEFAULT_MAX_RESIDENT = 8;
var DEFAULT_IDLE_MS = 30 * 6e4;
var UserBoards = class {
  constructor(_cfg, _identities, _container, _opts = {}) {
    this._cfg = _cfg;
    this._identities = _identities;
    this._container = _container;
    this._opts = _opts;
  }
  _boards = /* @__PURE__ */ new Map();
  _sweeper = null;
  /** The container account's board - the one started at boot. */
  get containerBoard() {
    return this._container;
  }
  /**
   * The board belonging to `user`, starting it if needed.
   *
   * The first user reuses the container account, so it returns the already
   * running store rather than opening a second connection to the same board -
   * two stores on one account would double the websockets and fight over the
   * cursor cache.
   */
  async forUser(user, isContainerAccount) {
    if (isContainerAccount) {
      return this._container;
    }
    const existing = this._boards.get(user.id);
    if (existing) {
      existing.lastUsedAt = Date.now();
      return existing.starting ? existing.starting : existing;
    }
    const clientId = `${this._cfg.clientId}-u${user.id}`;
    const store = new StateStore(this._cfg, {
      mintToken: () => this._identities.tokenForUser(user),
      cacheKey: `user-${user.id}`,
      clientId,
    });
    const core = new BridgeCore(
      store,
      new OpFactory(clientId, this._cfg.encryptionPassword),
    );
    const starting = (async () => {
      await store.start(this._cfg.pollIntervalSec * 1e3);
      const entry = this._boards.get(user.id);
      if (entry) entry.starting = null;
      return { core, store };
    })();
    this._boards.set(user.id, { core, store, lastUsedAt: Date.now(), starting });
    this._ensureSweeper();
    await starting;
    this._evictOverflow();
    return { core, store };
  }
  /** Stops every per-user board. The container board is owned by the caller. */
  stopAll() {
    if (this._sweeper) {
      clearInterval(this._sweeper);
      this._sweeper = null;
    }
    for (const [id, entry] of this._boards) {
      entry.store.stop();
      this._boards.delete(id);
    }
  }
  _ensureSweeper() {
    if (this._sweeper) return;
    const idleMs = this._opts.idleMs ?? DEFAULT_IDLE_MS;
    this._sweeper = setInterval(
      () => {
        const cutoff = Date.now() - idleMs;
        for (const [id, entry] of this._boards) {
          if (entry.starting || entry.lastUsedAt > cutoff) continue;
          entry.store.stop();
          this._boards.delete(id);
        }
      },
      Math.max(idleMs / 4, 6e4),
    );
    this._sweeper.unref?.();
  }
  _evictOverflow() {
    const max = this._opts.maxResident ?? DEFAULT_MAX_RESIDENT;
    while (this._boards.size > max) {
      let oldestId = null;
      let oldest = Infinity;
      for (const [id, entry] of this._boards) {
        if (entry.starting) continue;
        if (entry.lastUsedAt < oldest) {
          oldest = entry.lastUsedAt;
          oldestId = id;
        }
      }
      if (oldestId === null) return;
      this._boards.get(oldestId)?.store.stop();
      this._boards.delete(oldestId);
    }
  }
};
export { UserBoards };
