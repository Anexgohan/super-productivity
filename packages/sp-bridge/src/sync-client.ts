/**
 * Minimal SuperSync HTTP client for the bridge (download side, M1).
 * Speaks the contract defined in @sp/shared-schema/supersync-http-contract.
 */
import {
  SuperSyncDownloadOpsResponseSchema,
  SuperSyncUploadOpsResponseSchema,
  type SuperSyncOperation,
  type SuperSyncServerOperation,
} from '@sp/shared-schema';
import type { BridgeConfig } from './config';

/**
 * Mints a fresh access token from the sync server's auto-provision endpoint.
 *
 * Standalone rather than a method because two callers need it for different
 * reasons: the bridge authenticating itself (a token per process is fine — the
 * bridge keeps its cursor in its own data dir, not under a token-derived key),
 * and WebappTokenProvider minting the ONE durable token served browsers embed.
 * Requires SP_SYNC_AUTO_PROVISION=true on the server.
 */
export const mintSuperSyncToken = async (cfg: BridgeConfig): Promise<string> => {
  const res = await fetch(`${cfg.syncServerUrl}/api/internal/token`, {
    method: 'POST',
    headers: { 'X-Internal-Secret': cfg.jwtSecret },
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
  return body.token;
};

export class SyncClient {
  private _token: string | null = null;

  constructor(private readonly cfg: BridgeConfig) {}

  async authenticate(): Promise<void> {
    this._token = await mintSuperSyncToken(this.cfg);
  }

  /** Current access token, or null before authenticate(). Used by the WS client. */
  get token(): string | null {
    return this._token;
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

  /**
   * Uploads ops. The server validates each op independently and reports
   * per-op results; any rejection here is surfaced as an error (the bridge
   * never silently drops a write).
   */
  async uploadOps(
    ops: SuperSyncOperation[],
    lastKnownServerSeq: number,
  ): Promise<{ latestSeq: number }> {
    const res = await fetch(`${this.cfg.syncServerUrl}/api/sync/ops`, {
      method: 'POST',
      headers: { ...this._authHeaders(), 'Content-Type': 'application/json' },
      body: JSON.stringify({ ops, clientId: this.cfg.clientId, lastKnownServerSeq }),
    });
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      throw new Error(
        `sp-bridge: op upload failed (${res.status}) ${body.slice(0, 300)}`,
      );
    }
    const parsed = SuperSyncUploadOpsResponseSchema.parse(await res.json());
    const results = (parsed as { results?: { accepted?: boolean; error?: string }[] })
      .results;
    const rejected = (results ?? []).filter((r) => r.accepted === false);
    if (rejected.length > 0) {
      throw new Error(
        `sp-bridge: ${rejected.length} op(s) rejected: ${JSON.stringify(rejected).slice(0, 300)}`,
      );
    }
    return { latestSeq: (parsed as { latestSeq?: number }).latestSeq ?? 0 };
  }
}
