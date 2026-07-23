/**
 * Live push from the sync server.
 *
 * The server emits `new_ops` whenever another client uploads, so the bridge can
 * materialize within milliseconds instead of waiting out a poll interval. The
 * poll is kept as a long fallback: a dropped socket must never mean stale data,
 * and reconnects are not guaranteed to be prompt.
 *
 * Protocol mirrors the web client (super-sync-websocket.service.ts):
 *   GET {baseUrl→ws}/api/sync/ws?token=<jwt>&clientId=<id>
 *   messages: { type: 'connected' | 'new_ops' | 'ping' }
 */

const RECONNECT_BASE_MS = 1_000;
const RECONNECT_MAX_MS = 60_000;
/** Server closes with 4001/4003 on missing/invalid token — reconnecting won't help. */
const AUTH_CLOSE_CODES = new Set([4001, 4003]);

export interface WsClientOptions {
  syncServerUrl: string;
  clientId: string;
  /** Read at connect time so a re-authentication is picked up automatically. */
  getToken: () => string | null;
  /** Invoked when the server reports new operations are available. */
  onNewOps: () => void;
  /** Invoked when the socket is closed for an auth reason (token rotated). */
  onAuthFailure: () => Promise<void>;
}

export class SyncWebSocket {
  private _ws: WebSocket | null = null;
  private _timer: NodeJS.Timeout | null = null;
  private _attempts = 0;
  private _stopped = true;

  constructor(private readonly opts: WsClientOptions) {}

  get isConnected(): boolean {
    return this._ws?.readyState === 1; // OPEN
  }

  start(): void {
    this._stopped = false;
    this._connect();
  }

  stop(): void {
    this._stopped = true;
    if (this._timer) {
      clearTimeout(this._timer);
      this._timer = null;
    }
    this._ws?.close();
    this._ws = null;
  }

  private _url(): string | null {
    const token = this.opts.getToken();
    if (!token) return null;
    const base = this.opts.syncServerUrl
      .replace(/^https:\/\//, 'wss://')
      .replace(/^http:\/\//, 'ws://');
    return `${base}/api/sync/ws?token=${encodeURIComponent(token)}&clientId=${encodeURIComponent(this.opts.clientId)}`;
  }

  private _connect(): void {
    if (this._stopped) return;
    const url = this._url();
    if (!url) {
      // Not authenticated yet — retry on the normal backoff schedule.
      this._scheduleReconnect();
      return;
    }

    let ws: WebSocket;
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

    ws.addEventListener('message', (ev: MessageEvent) => {
      let msg: { type?: string };
      try {
        msg = JSON.parse(String(ev.data));
      } catch {
        return;
      }
      if (msg.type === 'new_ops') {
        this.opts.onNewOps();
      }
      // 'connected' and 'ping' need no action; the socket staying open is the signal.
    });

    ws.addEventListener('error', () => {
      // 'close' always follows; reconnect is handled there.
    });

    ws.addEventListener('close', (ev) => {
      this._ws = null;
      if (this._stopped) return;
      const code = (ev as { code?: number }).code ?? 0;
      if (AUTH_CLOSE_CODES.has(code)) {
        console.warn(`sp-bridge: ws rejected auth (code ${code}); re-authenticating`);
        void this.opts
          .onAuthFailure()
          .catch(() => undefined)
          .finally(() => this._scheduleReconnect());
        return;
      }
      this._scheduleReconnect();
    });
  }

  private _scheduleReconnect(): void {
    if (this._stopped || this._timer) return;
    const delay = Math.min(RECONNECT_BASE_MS * 2 ** this._attempts, RECONNECT_MAX_MS);
    this._attempts++;
    this._timer = setTimeout(() => {
      this._timer = null;
      this._connect();
    }, delay);
  }
}
