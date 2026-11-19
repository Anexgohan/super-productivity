/**
 * One board's state, computed by the app's own rules (anex/app-rules).
 *
 * The API answers from here and from nowhere else: the server is the one source of truth. When the app rules cannot
 * answer (their worker failed, or they stopped at a change from a newer app version), reads and writes get a 503 that says
 * why. There is no second copy to fall back to.
 *
 * Ops reach the app rules decrypted: the bridge's main thread already holds the derived key, and a worker deriving its own
 * would keep another 64 MB Argon2id buffer alive for good. The app rules still run the integrity checks a browser runs on
 * every op it decrypts.
 */
import { decrypt } from '@sp/sync-core';
import type { SuperSyncServerOperation } from '@sp/shared-schema';
import type {
  AppRulesApplyResult,
  AppRulesCheckpoint,
  AppRulesRow,
} from './app-rules-protocol';
import type { AppRulesWorker } from './app-rules-worker';
import { normalizeFullState, type EntityMap } from './state-view';

export class AppRulesUnavailableError extends Error {
  readonly statusCode = 503;
}

export type AppRulesBoardState = 'starting' | 'loading' | 'ready' | 'unavailable';

export interface AppRulesBoardStatus {
  state: AppRulesBoardState;
  /** Last server change the app rules have applied. */
  seq: number;
  droppedOps: number;
  reducerFailures: number;
  archiveFailures: number;
  /** The worker's heap, all boards together, as of the last update of this board. */
  heapUsedMb: number | null;
  error: string | null;
}

export interface AppRulesBoardOptions {
  /** Unique per board: `container` or `user-<id>`. Also names its cache file. */
  board: string;
  clientId: string;
  cachePath: string;
  encryptionPassword: string;
  /** Called when the worker came back after a failure and this board is open again; the store syncs it then. */
  onReopened?: () => void;
}

const decryptRows = async (
  rows: SuperSyncServerOperation[],
  password: string,
): Promise<AppRulesRow[]> => {
  const out: AppRulesRow[] = [];
  for (const row of rows) {
    const op = row.op as unknown as Record<string, unknown>;
    if (op.isPayloadEncrypted && typeof op.payload === 'string') {
      // sync-core caches the derived key per session, so after the first op this is AES only.
      const payload = JSON.parse(await decrypt(op.payload, password));
      out.push({
        serverSeq: row.serverSeq,
        op: { ...op, payload, isPayloadEncrypted: false },
        wasEncrypted: true,
      });
    } else {
      out.push({ serverSeq: row.serverSeq, op, wasEncrypted: false });
    }
  }
  return out;
};

export class AppRulesBoard {
  private _view: EntityMap | null = null;
  private _viewSeq = -1;
  private _mergedClock: Record<string, number> = {};
  private _blocked: string | null = null;
  private _workerDown: string | null = null;
  private readonly _unlisten: () => void;
  private readonly _status: AppRulesBoardStatus = {
    state: 'starting',
    seq: 0,
    droppedOps: 0,
    reducerFailures: 0,
    archiveFailures: 0,
    heapUsedMb: null,
    error: null,
  };

  constructor(
    private readonly _worker: AppRulesWorker,
    private readonly _opts: AppRulesBoardOptions,
  ) {
    this._unlisten = _worker.listen({
      onFailure: (message) => {
        this._workerDown = message;
        this._refreshState();
      },
      onRestart: () => {
        void this.open()
          .then(() => this._opts.onReopened?.())
          .catch(() => undefined);
      },
    });
  }

  get seq(): number {
    return this._status.seq;
  }

  /** Component-wise max of every vector clock the app rules handled: the basis for this board's write clocks. */
  get mergedClock(): Record<string, number> {
    return { ...this._mergedClock };
  }

  get status(): AppRulesBoardStatus {
    return { ...this._status };
  }

  /** True when syncing would only stop at the same unreadable change again. */
  get blocked(): boolean {
    return this._blocked !== null;
  }

  /** The board as the app rules computed it. Throws a 503 when they cannot answer. */
  get view(): EntityMap {
    if (this._status.state !== 'ready' || !this._view) {
      throw new AppRulesUnavailableError(
        this._status.error
          ? `The board is unavailable: ${this._status.error}`
          : 'The board is still loading; try again shortly.',
      );
    }
    return this._view;
  }

  /** Opens the board in the worker from its cache file. Throws when the worker cannot take it. */
  async open(): Promise<void> {
    const res = await this._worker.request({
      kind: 'init',
      board: this._opts.board,
      init: { clientId: this._opts.clientId, cachePath: this._opts.cachePath },
    });
    if (res.kind !== 'init') throw new Error('unexpected init reply');
    this._workerDown = null;
    this._status.seq = res.seq;
    this._mergedClock = res.mergedClock;
    // The view is rebuilt from the reopened worker before the board answers again.
    this._viewSeq = -1;
    this._refreshState();
  }

  /** Applies one downloaded page. Throws on a worker failure; the caller's sync reports it. */
  async apply(rows: SuperSyncServerOperation[]): Promise<void> {
    if (rows.length === 0 || this._blocked) return;
    const decrypted = await decryptRows(rows, this._opts.encryptionPassword);
    const res = await this._worker.request({
      kind: 'apply',
      board: this._opts.board,
      rows: decrypted,
    });
    if (res.kind !== 'apply') throw new Error('unexpected apply reply');
    this._record(res.result);
  }

  /** Rebuilds the view when the app rules moved on since it was last built. After it, reads see every applied change. */
  async updateView(): Promise<void> {
    if (this._workerDown || this._viewSeq === this._status.seq) {
      this._refreshState();
      return;
    }
    const res = await this._worker.request({ kind: 'snapshot', board: this._opts.board });
    if (res.kind !== 'snapshot') throw new Error('unexpected snapshot reply');
    this._view = normalizeFullState(res.snapshot.appData);
    this._viewSeq = res.snapshot.seq;
    this._status.heapUsedMb = res.snapshot.heapUsedMb;
    this._refreshState();
  }

  /**
   * The full state as of the applied seq, as the app's own snapshot service builds it, with the app's own validation of
   * it: what a browser puts in a REPAIR (anex/checkpoints). Throws a 503 when the app rules cannot answer.
   */
  async checkpoint(): Promise<AppRulesCheckpoint> {
    void this.view;
    const res = await this._worker.request({
      kind: 'checkpoint',
      board: this._opts.board,
    });
    if (res.kind !== 'checkpoint') throw new Error('unexpected checkpoint reply');
    return res.checkpoint;
  }

  /** Drops the board from the worker's memory; its cache file stays for the next start. */
  async close(): Promise<void> {
    this._unlisten();
    await this._worker
      .request({ kind: 'close', board: this._opts.board })
      .catch(() => undefined);
  }

  private _record(r: AppRulesApplyResult): void {
    this._status.seq = r.seq;
    this._mergedClock = r.mergedClock;
    this._status.droppedOps += r.filteredOpIds.length;
    this._status.reducerFailures += r.reducerFailures.length;
    const tag = `sp-bridge app rules: ${this._opts.board}:`;
    if (r.filteredOpIds.length) {
      console.log(
        `${tag} dropped ${r.filteredOpIds.length} op(s) a browser drops as superseded by a full import: ${r.filteredOpIds.join(', ')}`,
      );
    }
    for (const f of r.reducerFailures) {
      console.warn(
        `${tag} reducer failed on op ${f.opId} (${f.actionType}); skipped, as a browser skips it`,
      );
    }
    if (r.archiveFailure) {
      this._status.archiveFailures++;
      console.warn(
        `${tag} archive handling failed on op ${r.archiveFailure.opId} (${r.archiveFailure.actionType}): ${r.archiveFailure.error}`,
      );
    }
    if (r.blocked) {
      // A browser stops at a change it cannot read and waits for an update; so does the server.
      this._blocked = `stopped at op ${r.blocked.opId} (${r.blocked.reason}): a newer bridge build is needed`;
      console.error(`${tag} ${this._blocked}`);
    }
    this._refreshState();
  }

  private _refreshState(): void {
    const error =
      this._blocked ??
      (this._workerDown
        ? `the app rules stopped (${this._workerDown}) and are restarting`
        : null);
    this._status.error = error;
    // Mid-sync the view can trail the applied seq by a page; the sync's own updateView closes that before it returns.
    if (error) this._status.state = 'unavailable';
    else this._status.state = this._view ? 'ready' : 'loading';
  }
}
