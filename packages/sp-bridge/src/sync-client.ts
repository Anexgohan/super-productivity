/**
 * Minimal SuperSync HTTP client for the bridge (download side, M1).
 * Speaks the contract defined in @sp/shared-schema/supersync-http-contract.
 */
import { gzipSync } from 'node:zlib';
import {
  SuperSyncDownloadOpsResponseSchema,
  SuperSyncSnapshotUploadResponseSchema,
  SuperSyncUploadOpsResponseSchema,
  type SuperSyncOperation,
  type SuperSyncServerOperation,
  type SuperSyncUploadSnapshotRequest,
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
        "Raise SYNC_STORAGE_LIMIT in the server's .env.",
    ),
    { statusCode: 507 },
  );
};

/** The sync server's snapshot limits (its MAX_COMPRESSED_SIZE_SNAPSHOT and MAX_DECOMPRESSED_SIZE_SNAPSHOT), in MB. */
export const SNAPSHOT_LIMIT_GZIPPED_MB = 30;

export interface SnapshotAnswer {
  accepted: boolean;
  serverSeq?: number;
  error?: string;
  errorCode?: string;
}
export const SNAPSHOT_LIMIT_UNZIPPED_MB = 60;

/** The sync server's refusal of a full state as too large, as a 413 that names its limit; the server stored nothing. */
export const snapshotTooLargeError = (
  status: number,
  body: string,
  gzippedBytes: number,
  unzippedBytes: number,
): Error | null => {
  if (status !== 413 || quotaFullError(status, body)) return null;
  return Object.assign(
    new Error(
      `The sync server refused the board as too large: ${(gzippedBytes / MB).toFixed(1)} MB gzipped, ` +
        `${(unzippedBytes / MB).toFixed(1)} MB unzipped, over its limit of ${SNAPSHOT_LIMIT_GZIPPED_MB} MB gzipped ` +
        `or ${SNAPSHOT_LIMIT_UNZIPPED_MB} MB unzipped. Nothing was stored.`,
    ),
    { statusCode: 413 },
  );
};

/** A snapshot upload whose answer never arrived, so the server may or may not have stored it. */
export const isOutcomeUnknown = (err: unknown): boolean =>
  (err as { outcomeUnknown?: unknown } | null)?.outcomeUnknown === true;

const outcomeUnknown = (message: string): Error =>
  Object.assign(new Error(message), { outcomeUnknown: true });

const BASE64_CHUNK = 3 * 1024 * 1024;

/** `{"state":"<base64 of state>", ...fields}` as bytes, written in chunks so the base64 is never one string. */
const snapshotBodyBytes = (
  fields: Omit<SuperSyncUploadSnapshotRequest, 'state'>,
  state: Uint8Array,
): Buffer => {
  const head = Buffer.from('{"state":"');
  const rest = JSON.stringify(fields);
  const tail = Buffer.from(rest === '{}' ? '"}' : `",${rest.slice(1)}`);
  const base64Length = Math.ceil(state.length / 3) * 4;
  const out = Buffer.allocUnsafe(head.length + base64Length + tail.length);
  let at = head.copy(out, 0);
  for (let i = 0; i < state.length; i += BASE64_CHUNK) {
    const chunk = Buffer.from(
      state.buffer,
      state.byteOffset + i,
      Math.min(BASE64_CHUNK, state.length - i),
    );
    at += out.write(chunk.toString('base64'), at, 'latin1');
  }
  tail.copy(out, at);
  return out;
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

  /**
   * Uploads a full state through the snapshot endpoint, gzipped as browsers send it (anex/checkpoints). A refusal the
   * server explains (a stale REPAIR, for one) comes back as `accepted: false`, not as an error.
   */
  async uploadSnapshot(body: SuperSyncUploadSnapshotRequest): Promise<SnapshotAnswer> {
    let unzippedBytes = 0;
    // The JSON string is dropped once gzipped, so it isn't held through the upload.
    const gzipped = ((json: string) => {
      unzippedBytes = json.length;
      return gzipSync(json);
    })(JSON.stringify(body));
    return this._postSnapshot(gzipped, unzippedBytes);
  }

  /** uploadSnapshot() with the state as encrypted bytes, for a full state too large to hold as strings. */
  async uploadSnapshotBytes(
    fields: Omit<SuperSyncUploadSnapshotRequest, 'state'>,
    state: Uint8Array,
  ): Promise<SnapshotAnswer> {
    let unzippedBytes = 0;
    const gzipped = ((json: Buffer) => {
      unzippedBytes = json.length;
      return gzipSync(json);
    })(snapshotBodyBytes(fields, state));
    return this._postSnapshot(gzipped, unzippedBytes);
  }

  /** A 4xx is the server's refusal, so nothing was stored; no answer, an unreadable one or a 5xx leaves that unknown. */
  private async _postSnapshot(
    gzipped: Buffer,
    unzippedBytes: number,
  ): Promise<SnapshotAnswer> {
    let res: Response;
    let text: string;
    try {
      res = await fetch(`${this.cfg.syncServerUrl}/api/sync/snapshot`, {
        method: 'POST',
        headers: {
          ...this._authHeaders(),
          'Content-Type': 'application/json',
          'Content-Encoding': 'gzip',
        },
        body: gzipped,
      });
      text = await res.text();
    } catch (err) {
      throw outcomeUnknown(
        `sp-bridge: snapshot upload got no answer: ${(err as Error).message}`,
      );
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      parsed = null;
    }
    const result = SuperSyncSnapshotUploadResponseSchema.safeParse(parsed);
    if (result.success && res.status < 500) return result.data;
    if (res.status < 400 || res.status >= 500) {
      throw outcomeUnknown(
        `sp-bridge: snapshot upload got an unusable answer (${res.status}) ${text.slice(0, 300)}`,
      );
    }
    throw (
      quotaFullError(res.status, text) ??
      snapshotTooLargeError(res.status, text, gzipped.length, unzippedBytes) ??
      Object.assign(
        new Error(
          `sp-bridge: snapshot upload refused (${res.status}) ${text.slice(0, 300)}`,
        ),
        { upstreamStatus: res.status },
      )
    );
  }
}
