/**
 * The API's one source of truth (anex/app-rules): boards computed by the app's own rules in the built worker, fed ops
 * from the bridge's own OpFactory, encrypted like real ones. Synthetic data only.
 *
 * Runs against dist/app-rules-worker.js, the file that ships; `npm test` builds it first (build:app-rules).
 */
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { encrypt } from '@sp/sync-core';
import type { SuperSyncOperation, SuperSyncServerOperation } from '@sp/shared-schema';
import { buildTaskEntity, OpFactory, uuidv7 } from '../src/op-factory';
import { AppRulesWorker } from '../src/app-rules-worker';
import { AppRulesBoard, AppRulesUnavailableError } from '../src/app-rules-board';

const WORKER = join(__dirname, '../dist/app-rules-worker.js');
const PASSWORD = 'app-rules-test-passphrase';
const IMPORT_CLIENT = 'B_import';
const BROWSER = 'B_browser';
const STALE_BROWSER = 'B_stale';

const dirs: string[] = [];
const workers: AppRulesWorker[] = [];
const tempDir = (): string => {
  const dir = mkdtempSync(join(tmpdir(), 'app-rules-test-'));
  dirs.push(dir);
  return dir;
};
const newWorker = (path = WORKER): AppRulesWorker => {
  const worker = new AppRulesWorker(path, 50);
  workers.push(worker);
  worker.start();
  return worker;
};

afterEach(() => {
  for (const w of workers.splice(0)) w.stop();
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

/** The app's own initial state, from the app rules themselves: a valid full import to start every history from. */
let initialAppData: Record<string, unknown>;

beforeAll(async () => {
  if (!existsSync(WORKER)) {
    throw new Error(
      `${WORKER} is missing: run "npm run build:app-rules" (npm test does it first)`,
    );
  }
  const worker = newWorker();
  const dir = tempDir();
  await worker.request({
    kind: 'init',
    board: 'seed',
    init: { clientId: 'x', cachePath: join(dir, 'c.json') },
  });
  const snap = await worker.request({ kind: 'snapshot', board: 'seed' });
  if (snap.kind !== 'snapshot') throw new Error('could not read the initial state');
  initialAppData = snap.snapshot.appData;
  worker.stop();
}, 60_000);

/** A server op log feeding boards, as StateStore feeds them. */
class Log {
  readonly rows: SuperSyncServerOperation[] = [];
  push(op: SuperSyncOperation): SuperSyncServerOperation {
    const row = {
      serverSeq: this.rows.length + 1,
      receivedAt: 0,
      op,
    } as SuperSyncServerOperation;
    this.rows.push(row);
    return row;
  }
  async importInitialState(): Promise<SuperSyncServerOperation> {
    return this.push({
      id: uuidv7(),
      clientId: IMPORT_CLIENT,
      actionType: '[SP_ALL] Load(import) all data',
      opType: 'SYNC_IMPORT',
      entityType: 'ALL',
      payload: await encrypt(
        JSON.stringify({ appDataComplete: initialAppData }),
        PASSWORD,
      ),
      isPayloadEncrypted: true,
      vectorClock: { [IMPORT_CLIENT]: 1 },
      timestamp: Date.now(),
      schemaVersion: 4,
    } as SuperSyncOperation);
  }
}

const board = (
  worker: AppRulesWorker,
  name: string,
  dir: string,
  onReopened?: () => void,
): AppRulesBoard =>
  new AppRulesBoard(worker, {
    board: name,
    clientId: 'sp-bridge',
    cachePath: join(dir, `${name}.json`),
    encryptionPassword: PASSWORD,
    onReopened,
  });

/** Applies the log's rows after the board's seq and rebuilds its view, as one StateStore refresh does. */
const sync = async (b: AppRulesBoard, log: Log): Promise<void> => {
  await b.apply(log.rows.filter((r) => r.serverSeq > b.seq));
  await b.updateView();
};

const browser = new OpFactory(BROWSER, PASSWORD);
let counter = 0;
const afterImport = (): Record<string, number> => ({
  [IMPORT_CLIENT]: 1,
  [BROWSER]: ++counter,
});

const taskOf = (b: AppRulesBoard, id: string): Record<string, unknown> | undefined =>
  b.view.TASK?.[id] as Record<string, unknown> | undefined;

describe('app rules board', () => {
  it('answers what the app computes: a completed card leaves In Progress and gets its done date', async () => {
    const worker = newWorker();
    const log = new Log();
    const b = board(worker, 'container', tempDir());
    await b.open();
    await log.importInitialState();
    const task = buildTaskEntity({ title: 'done card', tagIds: ['KANBAN_IN_PROGRESS'] });
    log.push(await browser.addTask(task, afterImport()));
    log.push(
      await browser.updateTask(task.id as string, { isDone: true }, afterImport()),
    );
    await sync(b, log);

    const t = taskOf(b, task.id as string)!;
    expect(b.status).toMatchObject({ state: 'ready', seq: 3, error: null });
    expect(t.isDone).toBe(true);
    expect(t.tagIds).not.toContain('KANBAN_IN_PROGRESS');
    expect(typeof t.doneOn).toBe('number');
  }, 60_000);

  it('archives through the app own archive code: the card leaves the live board for the archive', async () => {
    const worker = newWorker();
    const log = new Log();
    const b = board(worker, 'container', tempDir());
    await b.open();
    await log.importInitialState();
    const task = buildTaskEntity({ title: 'to archive' });
    log.push(await browser.addTask(task, afterImport()));
    log.push({
      id: uuidv7(),
      clientId: BROWSER,
      actionType: '[Task Shared] moveToArchive',
      opType: 'UPD',
      entityType: 'TASK',
      entityId: task.id as string,
      entityIds: [task.id as string],
      payload: await encrypt(
        JSON.stringify({
          actionPayload: { tasks: [{ ...task, isDone: true, subTasks: [] }] },
          entityChanges: [],
        }),
        PASSWORD,
      ),
      isPayloadEncrypted: true,
      vectorClock: afterImport(),
      timestamp: Date.now(),
      schemaVersion: 4,
    } as SuperSyncOperation);
    await sync(b, log);

    expect(taskOf(b, task.id as string)).toBeUndefined();
    const archived = (
      b.view.ARCHIVE_YOUNG as { task: { entities: Record<string, unknown> } }
    ).task.entities;
    expect(archived[task.id as string]).toBeDefined();
    expect(b.status.archiveFailures).toBe(0);
  }, 60_000);

  it('drops a change made without knowledge of the import, as every browser does', async () => {
    const worker = newWorker();
    const log = new Log();
    const b = board(worker, 'container', tempDir());
    await b.open();
    await log.importInitialState();
    const task = buildTaskEntity({ title: 'kept' });
    log.push(await browser.addTask(task, afterImport()));
    const stale = new OpFactory(STALE_BROWSER, PASSWORD);
    log.push(
      await stale.updateTask(
        task.id as string,
        { title: 'stale rename' },
        { [STALE_BROWSER]: 7 },
      ),
    );
    await sync(b, log);

    expect(taskOf(b, task.id as string)?.title).toBe('kept');
    expect(b.status.droppedOps).toBe(1);
  }, 60_000);

  it('keeps two boards in one worker apart', async () => {
    const worker = newWorker();
    const dir = tempDir();
    const a = board(worker, 'container', dir);
    const u = board(worker, 'user-2', dir);
    await a.open();
    await u.open();
    const logA = new Log();
    const logU = new Log();
    await logA.importInitialState();
    await logU.importInitialState();
    const onlyA = buildTaskEntity({ title: 'only on A' });
    logA.push(await browser.addTask(onlyA, afterImport()));
    await sync(a, logA);
    await sync(u, logU);

    expect(taskOf(a, onlyA.id as string)).toBeDefined();
    expect(taskOf(u, onlyA.id as string)).toBeUndefined();
  }, 60_000);

  it('reopens from its cache: same seq, same cards and the write clock, without replaying anything', async () => {
    const dir = tempDir();
    const log = new Log();
    await log.importInitialState();
    const task = buildTaskEntity({ title: 'cached' });
    log.push(await browser.addTask(task, afterImport()));
    const first = board(newWorker(), 'container', dir);
    await first.open();
    await sync(first, log);
    const clock = first.mergedClock;
    await first.close();

    const again = board(newWorker(), 'container', dir);
    await again.open();
    await again.updateView();
    expect(again.seq).toBe(2);
    expect(again.mergedClock).toEqual(clock);
    expect(clock[BROWSER]).toBeGreaterThan(0);
    expect(taskOf(again, task.id as string)?.title).toBe('cached');
  }, 60_000);

  it('answers 503 while the app rules are down, never from another copy, and reopens itself when they are back', async () => {
    const worker = newWorker();
    const log = new Log();
    let reopened = 0;
    const b = board(worker, 'container', tempDir(), () => reopened++);
    await b.open();
    await log.importInitialState();
    await sync(b, log);
    expect(b.status.state).toBe('ready');

    await (
      worker as unknown as { _worker: { terminate: () => Promise<number> } }
    )._worker.terminate();
    await new Promise((r) => setTimeout(r, 20));
    expect(b.status.state).toBe('unavailable');
    expect(() => b.view).toThrow(AppRulesUnavailableError);
    try {
      void b.view;
    } catch (err) {
      expect((err as AppRulesUnavailableError).statusCode).toBe(503);
    }

    // The worker restarts after the (shortened) delay and the board reopens from its cache file.
    for (let i = 0; i < 100 && reopened === 0; i++)
      await new Promise((r) => setTimeout(r, 50));
    expect(reopened).toBe(1);
    await sync(b, log);
    expect(b.status).toMatchObject({ state: 'ready', seq: 1, error: null });
  }, 60_000);

  it('stops at a change from a newer app version, as a browser does, and says so', async () => {
    const worker = newWorker();
    const log = new Log();
    const b = board(worker, 'container', tempDir());
    await b.open();
    await log.importInitialState();
    const future = await browser.addTask(
      buildTaskEntity({ title: 'future' }),
      afterImport(),
    );
    log.push({ ...future, schemaVersion: 999 } as SuperSyncOperation);
    await sync(b, log);

    expect(b.blocked).toBe(true);
    expect(b.status.state).toBe('unavailable');
    expect(b.status.error).toContain('VERSION_TOO_NEW');
    expect(() => b.view).toThrow(AppRulesUnavailableError);
  }, 60_000);

  it('builds a checkpoint as a browser would put it in a REPAIR, and the app validates it', async () => {
    const worker = newWorker();
    const log = new Log();
    const b = board(worker, 'container', tempDir());
    await b.open();
    await log.importInitialState();
    const task = buildTaskEntity({ title: 'in the checkpoint' });
    log.push(await browser.addTask(task, afterImport()));
    await sync(b, log);

    const cp = await b.checkpoint();
    expect(cp.seq).toBe(2);
    expect(cp.validation).toEqual({ isValid: true, errors: [] });
    const tasks = cp.appData.task as { ids: string[] };
    expect(tasks.ids).toContain(task.id);
    expect(cp.appData.archiveYoung).toBeDefined();
    expect(cp.appData.archiveOld).toBeDefined();
  }, 60_000);

  it('takes its own checkpoint back as a REPAIR: the same board, and a later change made without it still applies', async () => {
    const worker = newWorker();
    const log = new Log();
    const b = board(worker, 'container', tempDir());
    await b.open();
    await log.importInitialState();
    const task = buildTaskEntity({ title: 'before the checkpoint' });
    log.push(await browser.addTask(task, afterImport()));
    await sync(b, log);

    // As the server stores an upload through the snapshot endpoint: the state itself, encrypted, as a REPAIR.
    const cp = await b.checkpoint();
    log.push({
      id: uuidv7(),
      clientId: 'sp-bridge',
      actionType: '[SP_ALL] Load(import) all data',
      opType: 'REPAIR',
      entityType: 'ALL',
      payload: await encrypt(JSON.stringify(cp.appData), PASSWORD),
      isPayloadEncrypted: true,
      vectorClock: {
        ...b.mergedClock,
        'sp-bridge': (b.mergedClock['sp-bridge'] ?? 0) + 1,
      },
      timestamp: Date.now(),
      schemaVersion: 4,
      syncImportReason: 'REPAIR',
      repairBaseServerSeq: cp.seq,
    } as SuperSyncOperation);
    // A browser that had not seen the checkpoint yet: its change comes after it and is kept, as REPAIR promises.
    log.push(
      await browser.updateTask(
        task.id as string,
        { title: 'after the checkpoint' },
        afterImport(),
      ),
    );
    await sync(b, log);

    expect(b.status).toMatchObject({ state: 'ready', seq: 4, droppedOps: 0 });
    expect(taskOf(b, task.id as string)?.title).toBe('after the checkpoint');
    // The checkpoint travelled without device-only sync settings; the board keeps its own, so the next one is valid too.
    expect((await b.checkpoint()).validation).toEqual({ isValid: true, errors: [] });
  }, 60_000);

  it('answers 503 when the worker cannot start at all', async () => {
    const dir = tempDir();
    const worker = newWorker(join(dir, 'missing-worker.js'));
    const b = board(worker, 'container', dir);
    await expect(b.open()).rejects.toThrow();
    expect(() => b.view).toThrow(AppRulesUnavailableError);
  }, 60_000);
});
