/**
 * The one worker thread that runs the app's own rules for every resident board (anex/app-rules).
 *
 * One worker rather than one per board: the app code it loads (Angular, NgRx, the app's reducers) costs the same however
 * many boards use it, so each extra board only adds its own data. The worker has its own heap cap, so the app rules can
 * fail or run out of memory without taking the bridge down. When they fail, every board answers with an error until the
 * worker is back: there is no second copy to fall back to. The worker restarts by itself, waiting longer each time.
 */
import { Worker } from 'node:worker_threads';
import type { AppRulesRequest, AppRulesResponse } from './app-rules-protocol';

/** Heap cap for the worker, all boards together. The bridge must outlive it, so this stays well under the container cap. */
const HEAP_LIMIT_MB = 96;
/** A request the worker has not answered by then means it is stuck; it is restarted rather than allowed to hold memory. */
const REQUEST_TIMEOUT_MS = 120_000;
const FIRST_RESTART_DELAY_MS = 5_000;
const MAX_RESTART_DELAY_MS = 5 * 60_000;
/** A worker that ran this long before failing gets the short restart delay again. */
const STABLE_RUN_MS = 10 * 60_000;

/** A request before its id is assigned. Distributes over the union, which a plain Omit would collapse. */
export type AppRulesRequestBody = AppRulesRequest extends infer R
  ? R extends unknown
    ? Omit<R, 'id'>
    : never
  : never;

export type AppRulesReply = Exclude<AppRulesResponse, { ok: false }>;

export interface AppRulesWorkerListener {
  /** The worker stopped; every board's state is gone from it until the restart. */
  onFailure: (message: string) => void;
  /** A fresh worker is running; boards open again from their cache files. */
  onRestart: () => void;
}

export class AppRulesWorker {
  private _worker: Worker | null = null;
  private _nextId = 1;
  private _error: string | null = 'not started';
  private _stopping = false;
  private _startedAt = 0;
  private _restartDelayMs: number;
  private _restartTimer: NodeJS.Timeout | null = null;
  private readonly _pending = new Map<
    number,
    {
      resolve: (r: AppRulesReply) => void;
      reject: (e: Error) => void;
      timer: NodeJS.Timeout;
    }
  >();
  private readonly _listeners = new Set<AppRulesWorkerListener>();
  private _exclusive: Promise<void> = Promise.resolve();

  constructor(
    private readonly _workerPath: string,
    /** Tests shorten the first restart delay; the bridge keeps the default. */
    private readonly _firstRestartDelayMs = FIRST_RESTART_DELAY_MS,
  ) {
    this._restartDelayMs = _firstRestartDelayMs;
  }

  /** Null while running; the reason while stopped. */
  get error(): string | null {
    return this._error;
  }

  /** Starts the worker. Never throws: a worker that cannot start is retried like one that failed. */
  start(): void {
    this._spawn();
  }

  listen(listener: AppRulesWorkerListener): () => void {
    this._listeners.add(listener);
    return () => this._listeners.delete(listener);
  }

  /** `transfer` moves those buffers to the worker instead of copying them; they are unusable here afterwards. */
  request(
    req: AppRulesRequestBody,
    transfer: ArrayBuffer[] = [],
  ): Promise<AppRulesReply> {
    const worker = this._worker;
    if (!worker || this._error) {
      return Promise.reject(new Error(this._error ?? 'app rules are not running'));
    }
    const id = this._nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this._pending.delete(id);
        reject(
          new Error(
            `app rules did not answer ${req.kind} within ${REQUEST_TIMEOUT_MS / 1000}s`,
          ),
        );
        this._fail(
          worker,
          `app rules did not answer ${req.kind} for ${req.board} within ${REQUEST_TIMEOUT_MS / 1000}s`,
        );
      }, REQUEST_TIMEOUT_MS);
      this._pending.set(id, { resolve, reject, timer });
      worker.postMessage({ ...req, id } as AppRulesRequest, transfer);
    });
  }

  /**
   * Runs `task` after every other board's task has finished. Boards sync through here one at a time, so at most one
   * downloaded page is held for the app rules at any moment, however many boards are resident.
   */
  exclusive<T>(task: () => Promise<T>): Promise<T> {
    const run = this._exclusive.then(task);
    this._exclusive = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  stop(): void {
    this._stopping = true;
    if (this._restartTimer) clearTimeout(this._restartTimer);
    if (this._worker) this._fail(this._worker, 'bridge shutting down');
  }

  private _spawn(): void {
    let worker: Worker;
    try {
      worker = new Worker(this._workerPath, {
        resourceLimits: { maxOldGenerationSizeMb: HEAP_LIMIT_MB },
      });
    } catch (err) {
      this._error = err instanceof Error ? err.message : String(err);
      console.error(`sp-bridge app rules: cannot start: ${this._error}`);
      this._scheduleRestart();
      return;
    }
    this._worker = worker;
    this._error = null;
    this._startedAt = Date.now();
    worker.on('message', (res: AppRulesResponse) => {
      const entry = this._pending.get(res.id);
      if (!entry) return;
      clearTimeout(entry.timer);
      this._pending.delete(res.id);
      if (res.ok) entry.resolve(res);
      else entry.reject(new Error(res.error));
    });
    // Events from a worker already replaced must not touch its successor.
    worker.on('error', (err) => this._fail(worker, `worker error: ${err.message}`));
    worker.on('exit', (code) => this._fail(worker, `worker exited (code ${code})`));
  }

  private _fail(worker: Worker, message: string): void {
    if (this._worker !== worker) return;
    this._worker = null;
    this._error = message;
    if (!this._stopping) {
      console.error(
        `sp-bridge app rules: stopped: ${message}. Boards answer with an error until the restart.`,
      );
    }
    for (const [, entry] of this._pending) {
      clearTimeout(entry.timer);
      entry.reject(new Error(`app rules stopped: ${message}`));
    }
    this._pending.clear();
    void worker.terminate();
    for (const listener of this._listeners) listener.onFailure(message);
    if (Date.now() - this._startedAt > STABLE_RUN_MS)
      this._restartDelayMs = this._firstRestartDelayMs;
    this._scheduleRestart();
  }

  private _scheduleRestart(): void {
    if (this._stopping || this._restartTimer) return;
    const delay = this._restartDelayMs;
    this._restartDelayMs = Math.min(delay * 2, MAX_RESTART_DELAY_MS);
    console.log(`sp-bridge app rules: restarting in ${Math.round(delay / 1000)}s`);
    this._restartTimer = setTimeout(() => {
      this._restartTimer = null;
      this._spawn();
      if (!this._error) for (const listener of this._listeners) listener.onRestart();
    }, delay);
    this._restartTimer.unref?.();
  }
}
