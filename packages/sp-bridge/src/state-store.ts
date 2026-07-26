/**
 * Long-running state store: keeps the materialized state current against the
 * SuperSync op-log and persists a cache (state + cursor) for fast restarts.
 */
import { mkdirSync, readFileSync, renameSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import type { BridgeConfig } from './config';
import { SyncClient } from './sync-client';
import { Materializer, type EntityMap } from './materializer';
import { SyncWebSocket } from './ws-client';
import type { SuperSyncOperation } from '@sp/shared-schema';

const CACHE_FILE = 'bridge-state-cache.json';
/**
 * Poll interval once the websocket is carrying live pushes. The poll becomes a
 * safety net for missed/dropped sockets rather than the primary mechanism, so a
 * long interval keeps it cheap without risking staleness.
 */
const WS_FALLBACK_POLL_MS = 5 * 60_000;

export class StateStore {
  private readonly _client: SyncClient;
  private readonly _materializer: Materializer;
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
    private readonly opts?: {
      mintToken?: (cfg: BridgeConfig) => Promise<string>;
      cacheKey?: string;
      /** Must match the clientId its OpFactory stamps on ops. */
      clientId?: string;
    },
  ) {
    this._client = new SyncClient(cfg, opts?.mintToken, opts?.clientId);
    this._materializer = new Materializer(cfg.encryptionPassword);
  }

  /** True while live push is active (see /api/status). */
  get isLive(): boolean {
    return this._ws?.isConnected ?? false;
  }

  get state(): EntityMap {
    return this._materializer.state;
  }

  get lastServerSeq(): number {
    return this._materializer.lastServerSeq;
  }

  /** This board's sync identity: its own for a per-user board, the container's otherwise. */
  private get _clientId(): string {
    return this.opts?.clientId ?? this.cfg.clientId;
  }

  private get _cachePath(): string {
    const key = this.opts?.cacheKey;
    return join(this.cfg.dataDir, key ? `bridge-state-cache.${key}.json` : CACHE_FILE);
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
    if (existsSync(this._cachePath)) {
      try {
        const cache = JSON.parse(readFileSync(this._cachePath, 'utf-8'));
        this._materializer.restoreFromCache(cache);
        console.log(
          `sp-bridge: restored cache at seq ${this._materializer.lastServerSeq}`,
        );
      } catch {
        console.warn('sp-bridge: cache unreadable; full replay from seq 0');
      }
    }

    // The sync server may still be coming up - `depends_on: service_healthy`
    // orders a `compose up`, but NOT a `compose restart`, which starts every
    // container at once. Without this the first fetch throws, the process
    // exits, and the container crash-loops (recovering, but printing alarming
    // "fetch failed" lines) until the sync server is ready.
    await this._connectWithRetry();
    await this.refresh();

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
  }

  /**
   * Pulls ops after the current cursor and applies them. Serialized: concurrent
   * calls await the in-flight refresh instead of racing the materializer.
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

  private async _doRefresh(): Promise<void> {
    try {
      const since = this._materializer.lastServerSeq;
      const { ops } = await this._client.downloadOpsSince(since);
      if (ops.length > 0) {
        await this._materializer.applyOps(ops);
        this._persist();
        console.log(
          `sp-bridge: applied ${ops.length} ops → seq ${this._materializer.lastServerSeq}`,
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
      console.error(`sp-bridge: refresh failed: ${message}`);
      throw err;
    }
  }

  private _persist(): void {
    const tmp = `${this._cachePath}.tmp`;
    writeFileSync(tmp, JSON.stringify(this._materializer.toCache()));
    renameSync(tmp, this._cachePath);
  }

  private _ownClockFloor = 0;

  /**
   * Vector clock for the bridge's next write: component-wise max of everything
   * seen, with the bridge's own component incremented. A local floor guards
   * against reusing a value before our own ops round-trip back from the server.
   */
  nextWriteClock(): Record<string, number> {
    const clock = this._materializer.mergedClock;
    const own = Math.max(clock[this._clientId] ?? 0, this._ownClockFloor) + 1;
    this._ownClockFloor = own;
    clock[this._clientId] = own;
    return clock;
  }

  /**
   * Uploads ops, then refreshes so the write round-trips through the server
   * and materializes exactly as every other client will see it.
   */
  async submitOps(ops: SuperSyncOperation[]): Promise<void> {
    await this._client.uploadOps(ops, this._materializer.lastServerSeq);
    await this.refresh();
  }
}
