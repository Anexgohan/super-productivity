/**
 * Messages between the bridge and its app-rules worker (anex/state-check).
 *
 * Types only, no runtime code: the worker bundle imports this file, and nothing here may pull bridge or app modules across the thread boundary.
 */
/**
 * A downloaded op, decrypted on the bridge's main thread before it crosses to the worker.
 * The main thread already holds the derived key; a worker deriving its own would keep another 64 MB Argon2id buffer alive for good.
 * `wasEncrypted` tells the worker to run the integrity checks a browser runs on every op it decrypts.
 */
export interface StateCheckRow {
  serverSeq: number;
  op: Record<string, unknown>;
  wasEncrypted: boolean;
}

export interface StateCheckInit {
  /** The bridge's own sync identity, so its round-tripped writes count as its own ops, as a browser's do. */
  clientId: string;
  cachePath: string;
}

/** Bridge → worker. Every request carries an id; the worker answers each one, in order. */
export type StateCheckRequest =
  | { id: number; kind: 'init'; init: StateCheckInit }
  | { id: number; kind: 'apply'; rows: StateCheckRow[] }
  | { id: number; kind: 'snapshot' };

/** What one applied page did. Ids and action types only: never titles, notes or other content. */
export interface StateCheckApplyResult {
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
}

export interface StateCheckSnapshot {
  seq: number;
  /** AppDataComplete-shaped, the same shape a browser uploads in a full import, archives included. */
  appData: Record<string, unknown>;
  /** The worker's own V8 heap in use, in MB: what the app rules cost, apart from the bridge. */
  heapUsedMb: number;
  /** Every entity id touched by an op the app rules dropped as superseded, kept across restarts in their cache. */
  filteredEntityIds: string[];
  sawArchiveOp: boolean;
}

export type StateCheckResponse =
  | { id: number; ok: true; kind: 'init'; seq: number; sawArchiveOp: boolean }
  | { id: number; ok: true; kind: 'apply'; result: StateCheckApplyResult }
  | { id: number; ok: true; kind: 'snapshot'; snapshot: StateCheckSnapshot }
  | { id: number; ok: false; error: string };
