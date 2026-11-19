/**
 * Messages between the bridge and its app-rules worker (anex/app-rules).
 *
 * One worker holds the app rules of every resident board; each request names its board.
 * Types only, no runtime code: the worker bundle imports this file, and nothing here may pull bridge or app modules across the thread boundary.
 */

/**
 * A downloaded op, decrypted on the bridge's main thread before it crosses to the worker.
 * The main thread already holds the derived key; a worker deriving its own would keep another 64 MB Argon2id buffer alive for good.
 * `wasEncrypted` tells the worker to run the integrity checks a browser runs on every op it decrypts.
 */
export interface AppRulesRow {
  serverSeq: number;
  op: Record<string, unknown>;
  wasEncrypted: boolean;
}

export interface AppRulesInit {
  /** The board's own sync identity, so its round-tripped writes count as its own ops, as a browser's do. */
  clientId: string;
  cachePath: string;
}

/** Bridge → worker. Every request carries an id and a board; the worker answers each one, in arrival order. */
export type AppRulesRequest =
  | { id: number; board: string; kind: 'init'; init: AppRulesInit }
  | { id: number; board: string; kind: 'apply'; rows: AppRulesRow[] }
  | { id: number; board: string; kind: 'snapshot' }
  /** The full state for a checkpoint, checked by the app's own validation as a browser checks what it receives. */
  | { id: number; board: string; kind: 'checkpoint' }
  /** Drops the board from memory; its cache file stays for the next start. */
  | { id: number; board: string; kind: 'close' };

/** What one applied page did. Ids and action types only: never titles, notes or other content. */
export interface AppRulesApplyResult {
  seq: number;
  applied: number;
  /** Ops a browser would have dropped because a full import superseded them. */
  filteredOpIds: string[];
  /** Entity ids those dropped ops touched, so a difference on them can be attributed. */
  filteredEntityIds: string[];
  reducerFailures: { opId: string; actionType: string }[];
  archiveFailure?: { opId: string; actionType: string; error: string };
  /** An op this app version cannot read (newer schema): a browser stops here, and so do the app rules. */
  blocked?: { opId: string; reason: string };
  sawArchiveOp: boolean;
  /** Component-wise max of every vector clock handled so far: the basis for this board's own write clocks. */
  mergedClock: Record<string, number>;
}

export interface AppRulesSnapshot {
  seq: number;
  /** AppDataComplete-shaped, the same shape a browser uploads in a full import, archives included. */
  appData: Record<string, unknown>;
  /** The worker's own V8 heap in use, in MB, for all its boards together. */
  heapUsedMb: number;
  /** Every entity id touched by an op the app rules dropped as superseded, kept across restarts in their cache. */
  filteredEntityIds: string[];
  sawArchiveOp: boolean;
}

/** A checkpoint's state (anex/checkpoints): what a browser puts in a REPAIR, and whether the app would accept it as is. */
export interface AppRulesCheckpoint {
  seq: number;
  appData: Record<string, unknown>;
  /** The app's validateFull. Errors are paths and expected types only, never the values. */
  validation: { isValid: boolean; errors: string[] };
}

export type AppRulesResponse =
  | {
      id: number;
      ok: true;
      kind: 'init';
      seq: number;
      sawArchiveOp: boolean;
      mergedClock: Record<string, number>;
    }
  | { id: number; ok: true; kind: 'apply'; result: AppRulesApplyResult }
  | { id: number; ok: true; kind: 'snapshot'; snapshot: AppRulesSnapshot }
  | { id: number; ok: true; kind: 'checkpoint'; checkpoint: AppRulesCheckpoint }
  | { id: number; ok: true; kind: 'close' }
  | { id: number; ok: false; error: string };
