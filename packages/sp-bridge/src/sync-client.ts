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
 * reasons: the bridge authenticating itself (a token per process is fine - the
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
      `sp-bridge: token fetch failed (${res.status}) - is SP_SYNC_AUTO_PROVISION=true on the sync server?`,
    );
  }
  const body = (await res.json()) as { token?: string };
  if (!body.token) {
    throw new Error('sp-bridge: token endpoint returned no token');
  }
  return body.token;
};

const MB = 1024 * 1024;

/**
 * Ops per download page. Long card notes make an op ~100-200KB, so 1000 per page reached ~100MB and
 * got the 512MB sync server OOM-killed during a full rebuild. The server also caps each page by size.
 */
export const DOWNLOAD_PAGE_SIZE = 200;

/**
 * The sync server's "account storage is full" refusal, as a 507 the REST API passes on.
 * As an unlabelled upload error it reached API callers as a bare 500, which read as a request-size bug.
 * nginx also answers 413 for an oversized body, so only the server's own error code counts.
 */
export const quotaFullError = (status: number, body: string): Error | null => {
  if (status !== 413) return null;
  let parsed: {
    errorCode?: unknown;
    storageUsedBytes?: unknown;
    storageQuotaBytes?: unknown;
  };
  try {
    parsed = JSON.parse(body);
  } catch {
    return null;
  }
  if (parsed?.errorCode !== 'STORAGE_QUOTA_EXCEEDED') return null;
  const used = Number(parsed.storageUsedBytes);
  const quota = Number(parsed.storageQuotaBytes);
  const usage =
    Number.isFinite(used) && Number.isFinite(quota)
      ? ` (${(used / MB).toFixed(1)} of ${(quota / MB).toFixed(1)} MB used)`
      : '';
  return Object.assign(
    new Error(
      `Sync storage is full${usage}: the sync server refused this write and nothing was saved. ` +
        'Raise STORAGE_QUOTA_BYTES on the sync server.',
    ),
    { statusCode: 507 },
  );
};

export class SyncClient {
  private _token: string | null = null;

  /**
   * `mintToken` defaults to the container account. A per-user board passes the
   * token for its own user instead - the same one that user's browser gets, so
   * the bridge sees exactly the board they see.
   */
  constructor(
    private readonly cfg: BridgeConfig,
    private readonly mintToken: (
      cfg: BridgeConfig,
    ) => Promise<string> = mintSuperSyncToken,
    /** Must equal the clientId on the ops being uploaded - the server rejects a mismatch. */
    private readonly clientId: string = cfg.clientId,
  ) {}

  async authenticate(): Promise<void> {
    this._token = await this.mintToken(this.cfg);
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
   * Downloads all ops after sinceSeq, following hasMore pagination, in server_seq order.
   * With `onPage`, each page is handed over as it arrives and nothing is kept, so a full rebuild never
   * holds the whole history (100MB+ with long notes) in the bridge's memory; `ops` is then empty.
   */
  async downloadOpsSince(
    sinceSeq: number,
    onPage?: (ops: SuperSyncServerOperation[]) => Promise<void>,
  ): Promise<{ ops: SuperSyncServerOperation[]; latestSeq: number }> {
    const all: SuperSyncServerOperation[] = [];
    let cursor = sinceSeq;
    let latestSeq = sinceSeq;

    for (;;) {
      const url = `${this.cfg.syncServerUrl}/api/sync/ops?sinceSeq=${cursor}&limit=${DOWNLOAD_PAGE_SIZE}`;
      const res = await fetch(url, { headers: this._authHeaders() });
      if (!res.ok) {
        throw new Error(`sp-bridge: ops download failed (${res.status})`);
      }
      const parsed = SuperSyncDownloadOpsResponseSchema.parse(await res.json());
      if (onPage) {
        await onPage(parsed.ops);
      } else {
        all.push(...parsed.ops);
      }
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
      body: JSON.stringify({ ops, clientId: this.clientId, lastKnownServerSeq }),
    });
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      throw (
        quotaFullError(res.status, body) ??
        new Error(`sp-bridge: op upload failed (${res.status}) ${body.slice(0, 300)}`)
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
