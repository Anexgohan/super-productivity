/**
 * One materialized board per user (anex/container-parity).
 *
 * The bridge used to hold a single StateStore for the container account, so
 * every API request read and wrote that one board however the caller had
 * authenticated. With real accounts that is wrong: an operator's key must reach
 * the operator's notes, not the admin's.
 *
 * A board is created on first use and torn down after a period of disuse - each
 * one carries a full materialized state and a websocket, and the bridge runs
 * under a small memory limit, so keeping every account resident forever is not
 * an option on a household-sized deployment either.
 */
import type { BridgeConfig } from './config';
import { StateStore } from './state-store';
import { BridgeCore } from './core';
import { OpFactory } from './op-factory';
import type { UserRow } from './auth/store';
import type { SyncIdentityProvider } from './auth/sync-identity';

export interface Board {
  core: BridgeCore;
  store: StateStore;
}

interface Entry extends Board {
  lastUsedAt: number;
  starting: Promise<Board> | null;
}

/** Boards resident at once before the least recently used is evicted. */
const DEFAULT_MAX_RESIDENT = 8;

/** Idle time after which a board is torn down. */
const DEFAULT_IDLE_MS = 30 * 60_000;

export class UserBoards {
  private readonly _boards = new Map<number, Entry>();
  private _sweeper: NodeJS.Timeout | null = null;

  constructor(
    private readonly _cfg: BridgeConfig,
    private readonly _identities: SyncIdentityProvider,
    private readonly _container: Board,
    private readonly _opts: { maxResident?: number; idleMs?: number } = {},
  ) {}

  /** The container account's board - the one started at boot. */
  get containerBoard(): Board {
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
  async forUser(user: UserRow, isContainerAccount: boolean): Promise<Board> {
    if (isContainerAccount) {
      return this._container;
    }

    const existing = this._boards.get(user.id);
    if (existing) {
      existing.lastUsedAt = Date.now();
      // A concurrent request may still be starting this board; share its promise
      // rather than building a second store for the same user.
      return existing.starting ? existing.starting : existing;
    }

    // One id per board: the server rejects an upload whose envelope clientId
    // disagrees with the ops inside it, so store and factory must agree.
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

    const starting = (async (): Promise<Board> => {
      await store.start(this._cfg.pollIntervalSec * 1000);
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
  stopAll(): void {
    if (this._sweeper) {
      clearInterval(this._sweeper);
      this._sweeper = null;
    }
    for (const [id, entry] of this._boards) {
      entry.store.stop();
      this._boards.delete(id);
    }
  }

  private _ensureSweeper(): void {
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
      Math.max(idleMs / 4, 60_000),
    );
    // Never hold the process open for a cache sweep.
    this._sweeper.unref?.();
  }

  private _evictOverflow(): void {
    const max = this._opts.maxResident ?? DEFAULT_MAX_RESIDENT;
    while (this._boards.size > max) {
      let oldestId: number | null = null;
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
}
