/**
 * Long-running state store: keeps the materialized state current against the
 * SuperSync op-log and persists a cache (state + cursor) for fast restarts.
 */
import { mkdirSync, readFileSync, renameSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import type { BridgeConfig } from './config';
import { SyncClient } from './sync-client';
import { Materializer, type EntityMap } from './materializer';

const CACHE_FILE = 'bridge-state-cache.json';

export class StateStore {
  private readonly _client: SyncClient;
  private readonly _materializer: Materializer;
  private _timer: NodeJS.Timeout | null = null;
  private _refreshInFlight: Promise<void> | null = null;
  lastSyncAt = 0;
  lastError: string | null = null;

  constructor(private readonly cfg: BridgeConfig) {
    this._client = new SyncClient(cfg);
    this._materializer = new Materializer(cfg.encryptionPassword);
  }

  get state(): EntityMap {
    return this._materializer.state;
  }

  get lastServerSeq(): number {
    return this._materializer.lastServerSeq;
  }

  private get _cachePath(): string {
    return join(this.cfg.dataDir, CACHE_FILE);
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

    await this._client.authenticate();
    await this.refresh();

    this._timer = setInterval(() => {
      void this.refresh().catch(() => undefined);
    }, pollIntervalMs);
  }

  stop(): void {
    if (this._timer) clearInterval(this._timer);
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
}
