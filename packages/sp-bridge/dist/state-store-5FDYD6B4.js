import { Materializer, SyncClient } from './chunk-P3LHLXUO.js';

// src/state-store.ts
import { mkdirSync, readFileSync, renameSync, writeFileSync, existsSync } from 'fs';
import { join } from 'path';

// src/ws-client.ts
var RECONNECT_BASE_MS = 1e3;
var RECONNECT_MAX_MS = 6e4;
var AUTH_CLOSE_CODES = /* @__PURE__ */ new Set([4001, 4003]);
var SyncWebSocket = class {
  constructor(opts) {
    this.opts = opts;
  }
  _ws = null;
  _timer = null;
  _attempts = 0;
  _stopped = true;
  get isConnected() {
    return this._ws?.readyState === 1;
  }
  start() {
    this._stopped = false;
    this._connect();
  }
  stop() {
    this._stopped = true;
    if (this._timer) {
      clearTimeout(this._timer);
      this._timer = null;
    }
    this._ws?.close();
    this._ws = null;
  }
  _url() {
    const token = this.opts.getToken();
    if (!token) return null;
    const base = this.opts.syncServerUrl
      .replace(/^https:\/\//, 'wss://')
      .replace(/^http:\/\//, 'ws://');
    return `${base}/api/sync/ws?token=${encodeURIComponent(token)}&clientId=${encodeURIComponent(this.opts.clientId)}`;
  }
  _connect() {
    if (this._stopped) return;
    const url = this._url();
    if (!url) {
      this._scheduleReconnect();
      return;
    }
    let ws;
    try {
      ws = new WebSocket(url);
    } catch (err) {
      console.warn(`sp-bridge: ws connect failed: ${String(err)}`);
      this._scheduleReconnect();
      return;
    }
    this._ws = ws;
    ws.addEventListener('open', () => {
      this._attempts = 0;
      console.log('sp-bridge: ws connected (live push active)');
    });
    ws.addEventListener('message', (ev) => {
      let msg;
      try {
        msg = JSON.parse(String(ev.data));
      } catch {
        return;
      }
      if (msg.type === 'new_ops') {
        this.opts.onNewOps();
      }
    });
    ws.addEventListener('error', () => {});
    ws.addEventListener('close', (ev) => {
      this._ws = null;
      if (this._stopped) return;
      const code = ev.code ?? 0;
      if (AUTH_CLOSE_CODES.has(code)) {
        console.warn(`sp-bridge: ws rejected auth (code ${code}); re-authenticating`);
        void this.opts
          .onAuthFailure()
          .catch(() => void 0)
          .finally(() => this._scheduleReconnect());
        return;
      }
      this._scheduleReconnect();
    });
  }
  _scheduleReconnect() {
    if (this._stopped || this._timer) return;
    const delay = Math.min(RECONNECT_BASE_MS * 2 ** this._attempts, RECONNECT_MAX_MS);
    this._attempts++;
    this._timer = setTimeout(() => {
      this._timer = null;
      this._connect();
    }, delay);
  }
};

// src/state-store.ts
var CACHE_FILE = 'bridge-state-cache.json';
var WS_FALLBACK_POLL_MS = 5 * 6e4;
var StateStore = class {
  constructor(cfg) {
    this.cfg = cfg;
    this._client = new SyncClient(cfg);
    this._materializer = new Materializer(cfg.encryptionPassword);
  }
  _client;
  _materializer;
  _timer = null;
  _refreshInFlight = null;
  _ws = null;
  lastSyncAt = 0;
  lastError = null;
  /** True while live push is active (see /api/status). */
  get isLive() {
    return this._ws?.isConnected ?? false;
  }
  get state() {
    return this._materializer.state;
  }
  get lastServerSeq() {
    return this._materializer.lastServerSeq;
  }
  get _cachePath() {
    return join(this.cfg.dataDir, CACHE_FILE);
  }
  async start(pollIntervalMs) {
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
    this._ws = new SyncWebSocket({
      syncServerUrl: this.cfg.syncServerUrl,
      clientId: this.cfg.clientId,
      getToken: () => this._client.token,
      onNewOps: () => {
        void this.refresh().catch(() => void 0);
      },
      onAuthFailure: () => this._client.authenticate(),
    });
    this._ws.start();
    this._timer = setInterval(
      () => {
        if (this.isLive && Date.now() - this.lastSyncAt < WS_FALLBACK_POLL_MS) {
          return;
        }
        void this.refresh().catch(() => void 0);
      },
      Math.min(pollIntervalMs, 3e4),
    );
  }
  stop() {
    if (this._timer) clearInterval(this._timer);
    this._ws?.stop();
  }
  /**
   * Pulls ops after the current cursor and applies them. Serialized: concurrent
   * calls await the in-flight refresh instead of racing the materializer.
   */
  async refresh() {
    if (this._refreshInFlight) {
      return this._refreshInFlight;
    }
    this._refreshInFlight = this._doRefresh().finally(() => {
      this._refreshInFlight = null;
    });
    return this._refreshInFlight;
  }
  async _doRefresh() {
    try {
      const since = this._materializer.lastServerSeq;
      const { ops } = await this._client.downloadOpsSince(since);
      if (ops.length > 0) {
        await this._materializer.applyOps(ops);
        this._persist();
        console.log(
          `sp-bridge: applied ${ops.length} ops \u2192 seq ${this._materializer.lastServerSeq}`,
        );
      }
      this.lastSyncAt = Date.now();
      this.lastError = null;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.lastError = message;
      if (message.includes('(401)')) {
        await this._client.authenticate().catch(() => void 0);
      }
      console.error(`sp-bridge: refresh failed: ${message}`);
      throw err;
    }
  }
  _persist() {
    const tmp = `${this._cachePath}.tmp`;
    writeFileSync(tmp, JSON.stringify(this._materializer.toCache()));
    renameSync(tmp, this._cachePath);
  }
  _ownClockFloor = 0;
  /**
   * Vector clock for the bridge's next write: component-wise max of everything
   * seen, with the bridge's own component incremented. A local floor guards
   * against reusing a value before our own ops round-trip back from the server.
   */
  nextWriteClock() {
    const clock = this._materializer.mergedClock;
    const own = Math.max(clock[this.cfg.clientId] ?? 0, this._ownClockFloor) + 1;
    this._ownClockFloor = own;
    clock[this.cfg.clientId] = own;
    return clock;
  }
  /**
   * Uploads ops, then refreshes so the write round-trips through the server
   * and materializes exactly as every other client will see it.
   */
  async submitOps(ops) {
    await this._client.uploadOps(ops, this._materializer.lastServerSeq);
    await this.refresh();
  }
};
export { StateStore };
