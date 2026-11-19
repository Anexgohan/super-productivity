/**
 * State check (anex/state-check): the app's own rules run beside the materializer and every difference is logged.
 *
 * The API keeps reading the materializer; nothing here changes a response or a write. The app rules run in a worker thread with
 * a heap cap, so it can fail, run out of memory or fall behind without touching the bridge: it is then marked stopped and the
 * bridge carries on exactly as before.
 *
 * Ordering: pages, catch-up pages and snapshot requests all go through one chain, and the worker answers in order, so a
 * snapshot reflects exactly the pages sent before it. A comparison only runs when both stand at the same seq.
 * Memory: a page is decrypted, sent and applied before the next is taken, so at most one page is ever held for the app rules.
 */
import { appendFileSync, existsSync, renameSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { Worker } from 'node:worker_threads';
import { decrypt } from '@sp/sync-core';
import type { SuperSyncServerOperation } from '@sp/shared-schema';
import { normalizeFullState, type EntityMap } from './materializer';
import {
  compareStates,
  countByClass,
  describe,
  DifferenceTracker,
  type ClassCounts,
  type Difference,
} from './state-check-compare';
import type {
  StateCheckApplyResult,
  StateCheckRequest,
  StateCheckResponse,
  StateCheckRow,
  StateCheckSnapshot,
} from './state-check-protocol';

/** Heap cap for the app rules' worker. The bridge container defaults to 256 MB; the app rules must fail alone, long before that. */
const APP_RULES_HEAP_LIMIT_MB = 128;
/** A page the app rules have not answered by then means they are stuck; they are stopped rather than allowed to hold memory. */
const REQUEST_TIMEOUT_MS = 120_000;
/** Comparisons wait for activity to settle, so a burst of edits costs one comparison, not one per edit. */
const COMPARE_DEBOUNCE_MS = 5_000;
const LOG_FILE = 'state-check-differences.jsonl';
const LOG_FILE_MAX_BYTES = 5 * 1024 * 1024;
/** Difference lines per comparison in the container log; the JSONL file always gets all of them. */
const MAX_LOG_LINES = 30;

export type StateCheckState = 'starting' | 'catching-up' | 'running' | 'stopped';

export interface StateCheckStatus {
  state: StateCheckState;
  appRulesSeq: number;
  lastCompareSeq: number | null;
  lastCompareAt: number | null;
  /** Standing differences by class. `new` is the one to watch. */
  differences: ClassCounts;
  droppedOps: number;
  reducerFailures: number;
  archiveFailures: number;
  heapUsedMb: number | null;
  error: string | null;
}

export interface StateCheckHost {
  dataDir: string;
  clientId: string;
  encryptionPassword: string;
  /** Path of the built app-rules worker (dist/app-rules-worker.js). */
  workerPath: string;
  /** The materializer as it stands right now. */
  bridge: () => { state: EntityMap; seq: number };
  /** Pages of server ops after `sinceSeq`, handed over one at a time, as the bridge's own download does. */
  download: (
    sinceSeq: number,
    onPage: (rows: SuperSyncServerOperation[]) => Promise<void>,
  ) => Promise<unknown>;
  /** Overrides the comparison debounce; tests use 0. */
  compareDebounceMs?: number;
}

/** A request before its id is assigned. Distributes over the union, which a plain Omit would collapse. */
type RequestBody = StateCheckRequest extends infer R
  ? R extends unknown
    ? Omit<R, 'id'>
    : never
  : never;

const decryptRows = async (
  rows: SuperSyncServerOperation[],
  password: string,
): Promise<StateCheckRow[]> => {
  const out: StateCheckRow[] = [];
  for (const row of rows) {
    const op = row.op as unknown as Record<string, unknown>;
    if (op.isPayloadEncrypted && typeof op.payload === 'string') {
      // The materializer derived this key already, so this is AES only: sync-core caches derived keys per session.
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

export class StateCheck {
  private _worker: Worker | null = null;
  private _nextId = 1;
  private readonly _pending = new Map<
    number,
    {
      resolve: (r: StateCheckResponse) => void;
      reject: (e: Error) => void;
      timer: NodeJS.Timeout;
    }
  >();
  private _chain: Promise<void> = Promise.resolve();
  private _compareTimer: NodeJS.Timeout | null = null;
  private _catchingUp = false;
  private readonly _tracker = new DifferenceTracker();
  private readonly _status: StateCheckStatus = {
    state: 'starting',
    appRulesSeq: 0,
    lastCompareSeq: null,
    lastCompareAt: null,
    differences: {},
    droppedOps: 0,
    reducerFailures: 0,
    archiveFailures: 0,
    heapUsedMb: null,
    error: null,
  };

  constructor(private readonly _host: StateCheckHost) {}

  get status(): StateCheckStatus {
    return { ...this._status, differences: { ...this._status.differences } };
  }

  private get _stopped(): boolean {
    return this._status.state === 'stopped';
  }

  /** Starts the worker and catches the app rules up. Never throws: a state check that cannot start just stays stopped. */
  async start(): Promise<void> {
    try {
      const worker = new Worker(this._host.workerPath, {
        resourceLimits: { maxOldGenerationSizeMb: APP_RULES_HEAP_LIMIT_MB },
      });
      this._worker = worker;
      worker.on('message', (res: StateCheckResponse) => {
        const entry = this._pending.get(res.id);
        if (!entry) return;
        clearTimeout(entry.timer);
        this._pending.delete(res.id);
        entry.resolve(res);
      });
      worker.on('error', (err) => this._fail(`worker error: ${err.message}`));
      worker.on('exit', (code) => {
        if (!this._stopped) this._fail(`worker exited (code ${code})`);
      });

      const res = await this._request({
        kind: 'init',
        init: {
          clientId: this._host.clientId,
          cachePath: join(this._host.dataDir, 'app-rules-cache.json'),
        },
      });
      if (res.kind !== 'init') throw new Error('unexpected init reply');
      this._status.appRulesSeq = res.seq;
      console.log(`sp-bridge state check: app rules started at seq ${res.seq}`);
      this.afterRefresh();
    } catch (err) {
      this._fail(err instanceof Error ? err.message : String(err));
    }
  }

  stop(): void {
    if (this._compareTimer) clearTimeout(this._compareTimer);
    this._status.state = 'stopped';
    void this._worker?.terminate();
    this._worker = null;
  }

  /**
   * Hands one page the materializer just applied to the app rules, and waits for it, so pages never pile up in memory.
   * `sinceSeq` is the cursor the page was downloaded from: a page that starts beyond the app rules' seq is skipped, and the
   * catch-up after the refresh fetches what the app rules are missing.
   */
  async applyPage(sinceSeq: number, rows: SuperSyncServerOperation[]): Promise<void> {
    // While catching up, the catch-up's own download covers these ops; waiting behind it would stall the bridge's refresh.
    if (
      this._stopped ||
      this._catchingUp ||
      this._status.state === 'starting' ||
      rows.length === 0
    )
      return;
    await this._enqueue(async () => {
      if (sinceSeq > this._status.appRulesSeq) return;
      await this._send(rows);
    });
  }

  /** Called after every refresh: catches the app rules up when they are behind, and schedules a comparison. */
  afterRefresh(): void {
    if (this._stopped || !this._worker) return;
    if (this._status.appRulesSeq < this._host.bridge().seq) {
      void this._catchUp();
      return;
    }
    this._status.state = 'running';
    this._scheduleCompare();
  }

  private async _catchUp(): Promise<void> {
    if (this._catchingUp) return;
    this._catchingUp = true;
    this._status.state = 'catching-up';
    const from = this._status.appRulesSeq;
    console.log(`sp-bridge state check: catching up from seq ${from}`);
    try {
      await this._enqueue(() =>
        this._host
          .download(this._status.appRulesSeq, async (rows) => {
            if (!this._stopped) await this._send(rows);
          })
          .then(() => undefined),
      );
      if (this._stopped) return;
      console.log(
        `sp-bridge state check: caught up from seq ${from} to ${this._status.appRulesSeq}`,
      );
    } catch (err) {
      this._fail(`catch-up failed: ${err instanceof Error ? err.message : String(err)}`);
      return;
    } finally {
      this._catchingUp = false;
    }
    this.afterRefresh();
  }

  private async _send(rows: SuperSyncServerOperation[]): Promise<void> {
    const decrypted = await decryptRows(rows, this._host.encryptionPassword);
    const res = await this._request({ kind: 'apply', rows: decrypted });
    if (res.kind !== 'apply') throw new Error('unexpected apply reply');
    this._record(res.result);
  }

  private _record(r: StateCheckApplyResult): void {
    this._status.appRulesSeq = r.seq;
    this._status.droppedOps += r.filteredOpIds.length;
    this._status.reducerFailures += r.reducerFailures.length;
    if (r.filteredOpIds.length) {
      console.log(
        `sp-bridge state check: dropped ${r.filteredOpIds.length} op(s) a browser drops as superseded by a full import: ${r.filteredOpIds.join(', ')}`,
      );
      this._log({
        event: 'dropped',
        opIds: r.filteredOpIds,
        entityIds: r.filteredEntityIds,
      });
    }
    for (const f of r.reducerFailures) {
      console.warn(
        `sp-bridge state check: reducer failed on op ${f.opId} (${f.actionType})`,
      );
      this._log({ event: 'reducer-failure', ...f });
    }
    if (r.archiveFailure) {
      this._status.archiveFailures++;
      console.warn(
        `sp-bridge state check: archive handling failed on op ${r.archiveFailure.opId} (${r.archiveFailure.actionType}): ${r.archiveFailure.error}`,
      );
      this._log({ event: 'archive-failure', ...r.archiveFailure });
    }
    if (r.blocked) {
      // A browser stops at an op it cannot read and waits for an update; the app rules cannot get past it either.
      this._log({ event: 'blocked', ...r.blocked });
      this._fail(
        `blocked at op ${r.blocked.opId} (${r.blocked.reason}); a newer bridge build is needed`,
      );
    }
  }

  /** Compares now, after everything already queued (pages, catch-up). Resolves once done; never throws. */
  compareNow(): Promise<void> {
    return this._enqueue(() => this._compare());
  }

  private _scheduleCompare(): void {
    if (this._compareTimer) return;
    this._compareTimer = setTimeout(() => {
      this._compareTimer = null;
      void this.compareNow();
    }, this._host.compareDebounceMs ?? COMPARE_DEBOUNCE_MS);
    this._compareTimer.unref?.();
  }

  private async _compare(): Promise<void> {
    if (this._stopped) return;
    const bridge = this._host.bridge();
    // Equal seqs or nothing: comparing two different points in history would only report noise.
    if (bridge.seq !== this._status.appRulesSeq) return;
    // Taken synchronously, so the materializer cannot move on while the app rules answer.
    const bridgeState = structuredClone(bridge.state);
    const res = await this._request({ kind: 'snapshot' });
    if (res.kind !== 'snapshot') throw new Error('unexpected snapshot reply');
    const snap: StateCheckSnapshot = res.snapshot;
    if (snap.seq !== bridge.seq) return;

    const found = compareStates(bridgeState, normalizeFullState(snap.appData), {
      filteredEntityIds: new Set(snap.filteredEntityIds),
      sawArchiveOp: snap.sawArchiveOp,
    });
    const { appeared, resolved } = this._tracker.update(found);
    const counts = countByClass(found);
    const first = this._status.lastCompareSeq === null;
    Object.assign(this._status, {
      differences: counts,
      lastCompareSeq: snap.seq,
      lastCompareAt: Date.now(),
      heapUsedMb: snap.heapUsedMb,
    });

    if (first || appeared.length || resolved.length) {
      console.log(
        `sp-bridge state check: seq ${snap.seq}: ${found.length} difference(s) ${JSON.stringify(counts)}; ` +
          `+${appeared.length} -${resolved.length}; app rules heap ${snap.heapUsedMb} MB`,
      );
      const lines = [
        ...appeared.map((d) => `  + ${describe(d)}`),
        ...resolved.map((d) => `  - ${describe(d)}`),
      ];
      for (const line of lines.slice(0, MAX_LOG_LINES)) console.log(line);
      if (lines.length > MAX_LOG_LINES) {
        console.log(`  … and ${lines.length - MAX_LOG_LINES} more in ${LOG_FILE}`);
      }
      const at = new Date().toISOString();
      for (const d of appeared)
        this._log({ event: 'appeared', at, seq: snap.seq, ...this._entry(d) });
      for (const d of resolved)
        this._log({ event: 'resolved', at, seq: snap.seq, ...this._entry(d) });
    }
  }

  private _entry(d: Difference): Record<string, unknown> {
    return { cls: d.cls, section: d.section, id: d.id, field: d.field, kind: d.kind };
  }

  /** Ids, field names and counts only, never values. Capped: the oldest half is rotated out at 5 MB. */
  private _log(record: Record<string, unknown>): void {
    try {
      const path = join(this._host.dataDir, LOG_FILE);
      if (existsSync(path) && statSync(path).size > LOG_FILE_MAX_BYTES) {
        renameSync(path, `${path}.1`);
      }
      appendFileSync(
        path,
        `${JSON.stringify({ at: new Date().toISOString(), ...record })}\n`,
      );
    } catch {
      // A full disk must not take the state check, let alone the bridge, down with it.
    }
  }

  private _enqueue(task: () => Promise<void>): Promise<void> {
    const run = this._chain.then(task);
    this._chain = run.catch((err) => {
      this._fail(err instanceof Error ? err.message : String(err));
    });
    return run.catch(() => undefined);
  }

  private _request(
    req: RequestBody,
  ): Promise<Exclude<StateCheckResponse, { ok: false }>> {
    const worker = this._worker;
    if (!worker) return Promise.reject(new Error('state check is not running'));
    const id = this._nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this._pending.delete(id);
        reject(
          new Error(
            `app rules did not answer ${req.kind} within ${REQUEST_TIMEOUT_MS / 1000}s`,
          ),
        );
      }, REQUEST_TIMEOUT_MS);
      this._pending.set(id, {
        resolve: (res) => (res.ok ? resolve(res) : reject(new Error(res.error))),
        reject,
        timer,
      });
      worker.postMessage({ ...req, id } as StateCheckRequest);
    });
  }

  private _fail(message: string): void {
    if (this._stopped) return;
    this._status.error = message;
    console.error(
      `sp-bridge state check: stopped: ${message}. The bridge is unaffected.`,
    );
    this._log({ event: 'stopped', error: message });
    for (const [, entry] of this._pending) {
      clearTimeout(entry.timer);
      entry.reject(new Error('state check stopped'));
    }
    this._pending.clear();
    this.stop();
  }
}
