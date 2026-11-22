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
import { encrypt, encryptBytes } from '@sp/sync-core';
import type { AppRulesWorker } from './app-rules-worker';
import { AppRulesBoard, type AppRulesBoardStatus } from './app-rules-board';
import type { ActionWhen, ActStep } from './action-inputs';
import type { AppRulesActResult } from './app-rules-protocol';
import type { EntityMap } from './state-view';
import { CheckpointTracker, type CheckpointState } from './checkpoints';
import { CURRENT_SCHEMA_VERSION, uuidv7 } from './op-factory';

/**
 * Poll interval once the websocket is carrying live pushes. The poll becomes a
 * safety net for missed/dropped sockets rather than the primary mechanism, so a
 * long interval keeps it cheap without risking staleness.
 */
const WS_FALLBACK_POLL_MS = 5 * 60_000;

/** The cache of the bridge's former rewritten copy of the app's rules; nothing reads it any more. */
const FORMER_CACHE_FILE = 'bridge-state-cache';

/** The op id and clock of one backup import, kept so a retry is the same op to the server. */
export interface ImportIdentity {
  opId: string;
  vectorClock: Record<string, number>;
}

export class StateStore {
  private readonly _client: SyncClient;
  private readonly _board: AppRulesBoard;
  private readonly _checkpoints: CheckpointTracker;
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
    this._checkpoints = new CheckpointTracker(
      join(cfg.dataDir, key ? `checkpoint-state.${key}.json` : 'checkpoint-state.json'),
    );
    this._board = new AppRulesBoard(_worker, {
      board: key ?? 'container',
      clientId: this._clientId,
      cachePath: join(
        cfg.dataDir,
        key ? `app-rules-cache.${key}.json` : 'app-rules-cache.json',
      ),
      encryptionPassword: cfg.encryptionPassword,
      checkpointHeldBack: this._checkpoints.state.heldBack,
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

  /** Counters and the last outcome of this board's checkpoints (anex/checkpoints): seqs, counts, times, no content. */
  get checkpointStatus(): CheckpointState {
    return this._checkpoints.state;
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
    let latestSeq = 0;
    try {
      const since = this._board.seq;
      // One board at a time through the worker, so at most one downloaded page is held, however many boards are resident.
      await this._worker.exclusive(async () => {
        // Applied and saved page by page: the cursor advances with each page, so an interrupted rebuild resumes where it stopped.
        ({ latestSeq } = await this._client.downloadOpsSince(since, async (page) => {
          await this._board.apply(page);
          this._checkpoints.observe(page);
          this._checkpoints.setHeldBack(this._board.status.checkpointHeldBack);
        }));
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
      if (this._writesClosed && this._board.seq >= this._writesClosed.untilSeq) {
        this._writesClosed = null;
      }
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
    await this._maybeWriteCheckpoint(latestSeq);
  }

  /**
   * Writes a checkpoint when one is due (anex/checkpoints): the board's full state as the app's rules computed it,
   * encrypted like every op and uploaded as a REPAIR based on the newest change. Only when the board has caught up and
   * the app's rules are healthy, and only a state the app's own validation accepts. Never fails the refresh.
   */
  private async _maybeWriteCheckpoint(latestSeq: number): Promise<void> {
    const now = Date.now();
    if (!this._checkpoints.isDue(now)) return;
    const status = this._board.status;
    if (
      status.state !== 'ready' ||
      this._board.blocked ||
      this._board.seq !== latestSeq
    ) {
      return;
    }
    const tag = `sp-bridge: ${this._boardName}: checkpoint`;
    if (status.checkpointHeldBack) {
      const reason = `held back until a full import or checkpoint: ${status.checkpointHeldBack}`;
      if (this._checkpoints.holdBack(reason)) console.warn(`${tag} ${reason}`);
      return;
    }
    try {
      await this._worker.exclusive(async () => {
        const cp = await this._board.checkpoint();
        if (cp.seq !== latestSeq) return;
        if (!cp.validation.isValid) {
          const reason = `the app's validation refused it: ${cp.validation.errors.join('; ')}`;
          this._checkpoints.markAttempt(now, reason);
          console.error(`${tag} not written: ${reason}`);
          return;
        }
        const state = await encrypt(
          JSON.stringify(cp.appData),
          this.cfg.encryptionPassword,
        );
        const res = await this._client.uploadSnapshot({
          state,
          clientId: this._clientId,
          reason: 'recovery',
          vectorClock: this.nextWriteClock(),
          schemaVersion: CURRENT_SCHEMA_VERSION,
          isPayloadEncrypted: true,
          syncImportReason: 'REPAIR',
          opId: uuidv7(),
          snapshotOpType: 'REPAIR',
          repairBaseServerSeq: cp.seq,
        });
        if (res.accepted) {
          this._checkpoints.markAttempt(now, null);
          console.log(
            `${tag} written as of change ${cp.seq} (server seq ${res.serverSeq ?? '?'}, ` +
              `${(state.length / 1048576).toFixed(1)} MB encrypted)`,
          );
          // Pull it back, as every browser will, once this refresh has finished.
          setTimeout(() => void this.refresh().catch(() => undefined), 0);
        } else {
          const reason = `${res.errorCode ?? 'refused'}: ${res.error ?? ''}`.trim();
          this._checkpoints.markAttempt(now, reason);
          console.warn(`${tag} refused by the server (${reason}); tried again later`);
        }
      });
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      this._checkpoints.markAttempt(now, reason);
      console.error(`${tag} failed: ${reason}; tried again later`);
    }
  }

  private _ownClockFloor = 0;
  private _importing = false;
  private _writesClosed: { reason: string; untilSeq: number } | null = null;

  get boardName(): string {
    return this._boardName;
  }

  get dataDir(): string {
    return this.cfg.dataDir;
  }

  /** The app rules' board, for a whole-board export or import (board-transfer.ts). */
  get appRules(): AppRulesBoard {
    return this._board;
  }

  /** Runs `task` with the worker to this board alone, as a sync does. */
  exclusive<T>(task: () => Promise<T>): Promise<T> {
    return this._worker.exclusive(task);
  }

  /** True while an import replaces this board; API writes to it are refused meanwhile. */
  get importing(): boolean {
    return this._importing;
  }

  /** Marks an import as running; false when one already is. */
  beginImport(): boolean {
    if (this._importing) return false;
    this._importing = true;
    return true;
  }

  endImport(): void {
    this._importing = false;
  }

  /** Why API writes to this board are refused after an import, or null. */
  get writesClosed(): string | null {
    return this._writesClosed?.reason ?? null;
  }

  /** Refuses API writes until a refresh has applied server change `untilSeq`; 0 reopens them on any successful refresh. */
  closeWritesUntil(untilSeq: number, reason: string): void {
    this._writesClosed = { reason, untilSeq };
  }

  /** A fresh id and clock for a backup import; a retry of the same import reuses them, so the server stores it once. */
  newImportIdentity(): ImportIdentity {
    return { opId: uuidv7(), vectorClock: this.nextWriteClock() };
  }

  /** A checked import's data, encrypted with the board's password as every full state travels. */
  sealBackupImport(json: Uint8Array): Promise<Uint8Array> {
    return encryptBytes(json, this.cfg.encryptionPassword);
  }

  /** Uploads a sealed import as this board's full state the way the app's restore does: by snapshot, with a clean slate. */
  async uploadBackupImport(
    state: Uint8Array,
    schemaVersion: number,
    identity: ImportIdentity,
  ): ReturnType<SyncClient['uploadSnapshotBytes']> {
    return this._client.uploadSnapshotBytes(
      {
        clientId: this._clientId,
        reason: 'recovery',
        vectorClock: identity.vectorClock,
        schemaVersion,
        isPayloadEncrypted: true,
        syncImportReason: 'BACKUP_RESTORE',
        opId: identity.opId,
        snapshotOpType: 'BACKUP_IMPORT',
        isCleanSlate: true,
      },
      state,
    );
  }

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
    this._assertWritable();
    void this._board.view;
    await this._client.uploadOps(ops, this._board.seq);
    await this.refresh();
  }

  /**
   * The ops app actions would upload, built by the app rules on the board as the server has it now (anex/app-actions).
   * Nothing is uploaded here: the caller stamps and submits them.
   */
  async buildActions(steps: ActStep[], when: ActionWhen): Promise<AppRulesActResult> {
    this._assertWritable();
    await this.refresh();
    return this._worker.exclusive(() => this._board.act(steps, when));
  }

  private _assertWritable(): void {
    if (this._importing || this._writesClosed) {
      throw Object.assign(
        new Error(
          this._writesClosed?.reason ??
            'An import is replacing this board. Try again once it has finished.',
        ),
        { statusCode: 409 },
      );
    }
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
