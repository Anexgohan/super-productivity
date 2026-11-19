/**
 * When the bridge writes a checkpoint for a board (anex/checkpoints).
 *
 * A checkpoint is the board's full state as the app's own rules computed it, uploaded as a REPAIR whose base is the
 * newest change: "this is the full, correct state as of change N". Browsers fast-forward to it, and history before it
 * becomes deletable (Stage 7). Agreed policy: after 1,000 changes or 20 MB of new history since the newest full-state
 * point, whichever comes first, at most once an hour. The counters survive restarts in a small file per board; until
 * they cover the history back to a full-state point, the board is due at its next change.
 */
import { existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import type { SuperSyncServerOperation } from '@sp/shared-schema';

export const CHECKPOINT_EVERY_CHANGES = 1000;
export const CHECKPOINT_EVERY_BYTES = 20 * 1024 * 1024;
export const CHECKPOINT_MIN_INTERVAL_MS = 60 * 60_000;
/** After a refused or failed upload, wait this long before trying again (the server allows 10 uploads in 15 minutes). */
export const CHECKPOINT_RETRY_MS = 15 * 60_000;

export interface CheckpointState {
  /** The newest full-state point seen in this board's history (a full import, or a REPAIR with a base). */
  lastFullStateSeq: number;
  changesSince: number;
  bytesSince: number;
  /** When this bridge last had a checkpoint accepted, ms since epoch; 0 if never. */
  lastWrittenAt: number;
  lastAttemptAt: number;
  lastError: string | null;
  /**
   * False while the counters may miss history: no full-state point seen and no checkpoint written by this bridge yet,
   * so the board may never have been checkpointed and the first chance is taken.
   */
  countsComplete: boolean;
}

const FRESH: CheckpointState = {
  lastFullStateSeq: 0,
  changesSince: 0,
  bytesSince: 0,
  lastWrittenAt: 0,
  lastAttemptAt: 0,
  lastError: null,
  countsComplete: false,
};

/** Full-state ops the server and browsers treat as a boundary; a REPAIR only with its base seq. */
export const isFullStatePoint = (op: Record<string, unknown>): boolean =>
  op.opType === 'SYNC_IMPORT' ||
  op.opType === 'BACKUP_IMPORT' ||
  (op.opType === 'REPAIR' && typeof op.repairBaseServerSeq === 'number');

const payloadBytes = (op: Record<string, unknown>): number =>
  typeof op.payload === 'string'
    ? op.payload.length
    : JSON.stringify(op.payload ?? null).length;

export class CheckpointTracker {
  private _state: CheckpointState;

  constructor(private readonly _path: string) {
    this._state = CheckpointTracker._read(_path) ?? { ...FRESH };
  }

  get state(): CheckpointState {
    return { ...this._state };
  }

  /** Counts one downloaded page. A full-state point restarts the counters. */
  observe(rows: SuperSyncServerOperation[]): void {
    if (rows.length === 0) return;
    for (const row of rows) {
      const op = row.op as unknown as Record<string, unknown>;
      if (isFullStatePoint(op)) {
        this._state.lastFullStateSeq = row.serverSeq;
        this._state.countsComplete = true;
        this._state.changesSince = 0;
        this._state.bytesSince = 0;
      } else {
        this._state.changesSince++;
        this._state.bytesSince += payloadBytes(op);
      }
    }
    this._save();
  }

  isDue(now: number): boolean {
    const s = this._state;
    if (now - s.lastWrittenAt < CHECKPOINT_MIN_INTERVAL_MS) return false;
    if (now - s.lastAttemptAt < CHECKPOINT_RETRY_MS) return false;
    if (!s.countsComplete && s.changesSince > 0) return true;
    return (
      s.changesSince >= CHECKPOINT_EVERY_CHANGES || s.bytesSince >= CHECKPOINT_EVERY_BYTES
    );
  }

  markAttempt(now: number, error: string | null): void {
    this._state.lastAttemptAt = now;
    this._state.lastError = error;
    if (error === null) {
      this._state.lastWrittenAt = now;
      this._state.countsComplete = true;
    }
    this._save();
  }

  private _save(): void {
    const tmp = `${this._path}.tmp`;
    writeFileSync(tmp, JSON.stringify(this._state));
    renameSync(tmp, this._path);
  }

  private static _read(path: string): CheckpointState | null {
    if (!existsSync(path)) return null;
    try {
      const parsed = JSON.parse(readFileSync(path, 'utf8')) as Partial<CheckpointState>;
      return { ...FRESH, ...parsed };
    } catch {
      return null;
    }
  }
}
