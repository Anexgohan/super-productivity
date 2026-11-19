/**
 * Long-running state store for one board: keeps the board current against the SuperSync op-log.
 *
 * The board is computed by the app's own rules (anex/app-rules), the same code a browser runs, so the API answers exactly
 * what every browser shows. They are the one source: when they cannot answer, the API says so (503) rather than answering
 * from anything else. Their cache file (in the worker) holds the board and the sync cursor for fast restarts.
 */
import { existsSync, mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import type { BridgeConfig } from './config';
import { SyncClient } from './sync-client';
import { SyncWebSocket } from './ws-client';
import type { SuperSyncOperation } from '@sp/shared-schema';
import type { AppRulesWorker } from './app-rules-worker';
import { AppRulesBoard, type AppRulesBoardStatus } from './app-rules-board';
import type { EntityMap } from './state-view';

/**
 * Poll interval once the websocket is carrying live pushes. The poll becomes a
 * safety net for missed/dropped sockets rather than the primary mechanism, so a
 * long interval keeps it cheap without risking staleness.
 */
const WS_FALLBACK_POLL_MS = 5 * 60_000;

/** The cache of the bridge's former rewritten copy of the app's rules; nothing reads it any more. */
const FORMER_CACHE_FILE = 'bridge-state-cache';

export class StateStore {
  private readonly _client: SyncClient;
  private readonly _board: AppRulesBoard;
  private _timer: NodeJS.Timeout | null = null;
  private _refreshInFlight: Promise<void> | null = null;
  private _ws: SyncWebSocket | null = null;
  lastSyncAt = 0;
  lastError: string | null = null;

  /**
   * `opts` is absent for the container's own board. A per-user board supplies
   * that user's token and a distinct `cacheKey`, so two boards never write over
   * each other's cache file.
   */
  constructor(
    private readonly cfg: BridgeConfig,
    private readonly _worker: AppRulesWorker,
    private readonly opts?: {
      mintToken?: (cfg: BridgeConfig) => Promise<string>;
      cacheKey?: string;
      /** Must match the clientId its OpFactory stamps on ops. */
      clientId?: string;
    },
  ) {
    this._client = new SyncClient(cfg, opts?.mintToken, opts?.clientId);
    const key = opts?.cacheKey;
    this._board = new AppRulesBoard(_worker, {
      board: key ?? 'container',
      clientId: this._clientId,
      cachePath: join(
        cfg.dataDir,
        key ? `app-rules-cache.${key}.json` : 'app-rules-cache.json',
      ),
      encryptionPassword: cfg.encryptionPassword,
      onReopened: () => void this.refresh().catch(() => undefined),
    });
  }

  /** True while live push is active (see /api/status). */
  get isLive(): boolean {
    return this._ws?.isConnected ?? false;
  }

  /** The board as the app's own rules computed it. Throws a 503 when they cannot answer. */
  get state(): EntityMap {
    return this._board.view;
  }

  get lastServerSeq(): number {
    return this._board.seq;
  }

  get appRulesStatus(): AppRulesBoardStatus {
    return this._board.status;
  }

  /** This board's sync identity: its own for a per-user board, the container's otherwise. */
  private get _clientId(): string {
    return this.opts?.clientId ?? this.cfg.clientId;
  }

  /**
   * Authenticates, waiting out a sync server that is not listening yet.
   *
   * Bounded rather than infinite: a genuinely wrong JWT_SECRET or a missing
   * SP_SYNC_AUTO_PROVISION should still surface as a failed start, not as a
   * bridge that sits there looking alive while never syncing.
   */
  private async _connectWithRetry(attempts = 15, delayMs = 2_000): Promise<void> {
    for (let attempt = 1; ; attempt++) {
      try {
        await this._client.authenticate();
        return;
      } catch (err) {
        if (attempt >= attempts) throw err;
        console.warn(
          `sp-bridge: sync server not ready (${(err as Error).message}); retry ${attempt}/${attempts}`,
        );
        await new Promise((r) => setTimeout(r, delayMs));
      }
    }
  }

  async start(pollIntervalMs: number): Promise<void> {
    mkdirSync(this.cfg.dataDir, { recursive: true });
    this._removeFormerCache();
    try {
      await this._board.open();
      console.log(
        `sp-bridge: ${this._boardName}: app rules open at seq ${this._board.seq}`,
      );
    } catch (err) {
      // The worker is down or restarting; the board reopens and syncs when it is back.
      console.error(
        `sp-bridge: ${this._boardName}: app rules not available yet: ${(err as Error).message}`,
      );
    }

    // The sync server may still be coming up - `depends_on: service_healthy`
    // orders a `compose up`, but NOT a `compose restart`, which starts every
    // container at once. Without this the first fetch throws, the process
    // exits, and the container crash-loops (recovering, but printing alarming
    // "fetch failed" lines) until the sync server is ready.
    await this._connectWithRetry();
    await this.refresh().catch(() => undefined);

    // Live push; the poll below stays on as a fallback.
    this._ws = new SyncWebSocket({
      syncServerUrl: this.cfg.syncServerUrl,
      clientId: this._clientId,
      getToken: () => this._client.token,
      onNewOps: () => {
        void this.refresh().catch(() => undefined);
      },
      onAuthFailure: () => this._client.authenticate(),
    });
    this._ws.start();

    // Once live, poll rarely - but never stop entirely, so a silently dead
    // socket degrades to "slightly stale" instead of "permanently stale".
    this._timer = setInterval(
      () => {
        if (this.isLive && Date.now() - this.lastSyncAt < WS_FALLBACK_POLL_MS) {
          return;
        }
        void this.refresh().catch(() => undefined);
      },
      Math.min(pollIntervalMs, 30_000),
    );
  }

  stop(): void {
    if (this._timer) clearInterval(this._timer);
    this._ws?.stop();
    void this._board.close();
  }

  /**
   * Pulls ops after the current cursor and applies them. Serialized: concurrent
   * calls await the in-flight refresh instead of racing the app rules.
   */
  async refresh(): Promise<void> {
    if (this._refreshInFlight) {
      return this._refreshInFlight;
    }
    this._refreshInFlight = this._doRefresh().finally(() => {
      this._refreshInFlight = null;
    });
    return this._refreshInFlight;
  }

  private get _boardName(): string {
    return this.opts?.cacheKey ?? 'container';
  }

  private async _doRefresh(): Promise<void> {
    // Stopped at a change only a newer build can read: syncing again would only stop there again.
    if (this._board.blocked) return;
    try {
      const since = this._board.seq;
      // One board at a time through the worker, so at most one downloaded page is held, however many boards are resident.
      await this._worker.exclusive(async () => {
        // Applied and saved page by page: the cursor advances with each page, so an interrupted rebuild resumes where it stopped.
        await this._client.downloadOpsSince(since, (page) => this._board.apply(page));
        // Reads after this see every change just applied, including the caller's own write.
        await this._board.updateView();
      });
      if (this._board.seq > since) {
        console.log(
          `sp-bridge: ${this._boardName}: applied ops ${since + 1}-${this._board.seq}`,
        );
      }
      this.lastSyncAt = Date.now();
      this.lastError = null;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.lastError = message;
      // 401 → token expired/rotated: re-auth once, next poll retries
      if (message.includes('(401)')) {
        await this._client.authenticate().catch(() => undefined);
      }
      console.error(`sp-bridge: ${this._boardName}: refresh failed: ${message}`);
      throw err;
    }
  }

  private _ownClockFloor = 0;

  /**
   * Vector clock for the bridge's next write: component-wise max of everything
   * seen, with the bridge's own component incremented. A local floor guards
   * against reusing a value before our own ops round-trip back from the server.
   */
  nextWriteClock(): Record<string, number> {
    const clock = this._board.mergedClock;
    const own = Math.max(clock[this._clientId] ?? 0, this._ownClockFloor) + 1;
    this._ownClockFloor = own;
    clock[this._clientId] = own;
    return clock;
  }

  /**
   * Uploads ops, then refreshes so the write round-trips through the server
   * and comes back through the app rules exactly as every other client will see it.
   * Refused while the app rules cannot answer: a write the server cannot then read back would be blind.
   */
  async submitOps(ops: SuperSyncOperation[]): Promise<void> {
    void this._board.view;
    await this._client.uploadOps(ops, this._board.seq);
    await this.refresh();
  }

  /** The former rewritten copy's cache: dead data now, removed so it cannot mislead anyone reading the data folder. */
  private _removeFormerCache(): void {
    const key = this.opts?.cacheKey;
    const path = join(
      this.cfg.dataDir,
      key ? `${FORMER_CACHE_FILE}.${key}.json` : `${FORMER_CACHE_FILE}.json`,
    );
    if (existsSync(path)) {
      rmSync(path, { force: true });
      console.log(
        `sp-bridge: ${this._boardName}: removed the former bridge cache ${path}`,
      );
    }
  }
}
