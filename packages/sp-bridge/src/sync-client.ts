/**
 * Minimal SuperSync HTTP client for the bridge (download side, M1).
 * Speaks the contract defined in @sp/shared-schema/supersync-http-contract.
 */
import {
  SuperSyncDownloadOpsResponseSchema,
  type SuperSyncServerOperation,
} from '@sp/shared-schema';
import type { BridgeConfig } from './config';

export class SyncClient {
  private _token: string | null = null;

  constructor(private readonly cfg: BridgeConfig) {}

  /**
   * Access token via the auto-provision internal endpoint (same mechanism the
   * web container's entrypoint uses). Requires SP_SYNC_AUTO_PROVISION=true on
   * the server.
   */
  async authenticate(): Promise<void> {
    const res = await fetch(`${this.cfg.syncServerUrl}/api/internal/token`, {
      method: 'POST',
      headers: { 'X-Internal-Secret': this.cfg.jwtSecret },
    });
    if (!res.ok) {
      throw new Error(
        `sp-bridge: token fetch failed (${res.status}) — is SP_SYNC_AUTO_PROVISION=true on the sync server?`,
      );
    }
    const body = (await res.json()) as { token?: string };
    if (!body.token) {
      throw new Error('sp-bridge: token endpoint returned no token');
    }
    this._token = body.token;
  }

  private _authHeaders(): Record<string, string> {
    if (!this._token) {
      throw new Error('sp-bridge: not authenticated');
    }
    return { Authorization: `Bearer ${this._token}` };
  }

  /**
   * Downloads all ops after sinceSeq, following hasMore pagination.
   * Returns ops in server_seq order plus the latest seq seen.
   */
  async downloadOpsSince(
    sinceSeq: number,
  ): Promise<{ ops: SuperSyncServerOperation[]; latestSeq: number }> {
    const all: SuperSyncServerOperation[] = [];
    let cursor = sinceSeq;
    let latestSeq = sinceSeq;

    for (;;) {
      const url = `${this.cfg.syncServerUrl}/api/sync/ops?sinceSeq=${cursor}&limit=1000`;
      const res = await fetch(url, { headers: this._authHeaders() });
      if (!res.ok) {
        throw new Error(`sp-bridge: ops download failed (${res.status})`);
      }
      const parsed = SuperSyncDownloadOpsResponseSchema.parse(await res.json());
      all.push(...parsed.ops);
      latestSeq = parsed.latestSeq;
      if (!parsed.hasMore || parsed.ops.length === 0) {
        break;
      }
      const last = parsed.ops[parsed.ops.length - 1] as { serverSeq?: number };
      if (typeof last.serverSeq !== 'number') {
        throw new Error('sp-bridge: op without serverSeq in paginated download');
      }
      cursor = last.serverSeq;
    }

    return { ops: all, latestSeq };
  }
}
