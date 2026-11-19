/**
 * State check end to end (anex/state-check): the real StateCheck driving the built app-rules worker, fed ops from the
 * bridge's own OpFactory, encrypted like real ones. Synthetic data only.
 *
 * Runs against dist/app-rules-worker.js, the file that ships; `npm test` builds it first (build:app-rules).
 */
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Worker } from 'node:worker_threads';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { encrypt } from '@sp/sync-core';
import type { SuperSyncOperation, SuperSyncServerOperation } from '@sp/shared-schema';
import { Materializer } from '../src/materializer';
import { buildTaskEntity, OpFactory, uuidv7 } from '../src/op-factory';
import { StateCheck } from '../src/state-check';
import type { StateCheckResponse } from '../src/state-check-protocol';

const WORKER = join(__dirname, '../dist/app-rules-worker.js');
const PASSWORD = 'state-check-test-passphrase';
const IMPORT_CLIENT = 'B_import';
const BROWSER = 'B_browser';
const STALE_BROWSER = 'B_stale';

/** The app's own initial state, from the app rules themselves: a valid full import to start every history from. */
let initialAppData: Record<string, unknown>;

beforeAll(async () => {
  if (!existsSync(WORKER)) {
    throw new Error(
      `${WORKER} is missing: run "npm run build:app-rules" (npm test does it first)`,
    );
  }
  const worker = new Worker(WORKER, { resourceLimits: { maxOldGenerationSizeMb: 128 } });
  const ask = (msg: unknown): Promise<StateCheckResponse> =>
    new Promise((resolve) => {
      worker.once('message', resolve);
      worker.postMessage(msg);
    });
  const dir = mkdtempSync(join(tmpdir(), 'state-check-init-'));
  await ask({
    id: 1,
    kind: 'init',
    init: { clientId: 'x', cachePath: join(dir, 'c.json') },
  });
  const snap = await ask({ id: 2, kind: 'snapshot' });
  await worker.terminate();
  rmSync(dir, { recursive: true, force: true });
  if (!snap.ok || snap.kind !== 'snapshot')
    throw new Error('could not read the initial state');
  initialAppData = snap.snapshot.appData;
}, 60_000);

/** A sync server's op log, a bridge materializer reading it, and a state check beside it, wired as StateStore wires them. */
class Rig {
  readonly rows: SuperSyncServerOperation[] = [];
  readonly mat = new Materializer(PASSWORD);
  readonly dir = mkdtempSync(join(tmpdir(), 'state-check-test-'));
  check = this.newCheck();

  newCheck(workerPath = WORKER): StateCheck {
    return new StateCheck({
      dataDir: this.dir,
      clientId: 'sp-bridge',
      encryptionPassword: PASSWORD,
      workerPath,
      bridge: () => ({ state: this.mat.state, seq: this.mat.lastServerSeq }),
      download: async (since, onPage) =>
        onPage(this.rows.filter((r) => r.serverSeq > since)),
      compareDebounceMs: 60_000,
    });
  }

  /** One op through the server, the materializer and the state check, as one refresh page. */
  async push(op: SuperSyncOperation, opts: { checkSees?: boolean } = {}): Promise<void> {
    const row = {
      serverSeq: this.rows.length + 1,
      receivedAt: 0,
      op,
    } as SuperSyncServerOperation;
    this.rows.push(row);
    const since = this.mat.lastServerSeq;
    await this.mat.applyOps([row]);
    if (opts.checkSees !== false) await this.check.applyPage(since, [row]);
  }

  async importInitialState(): Promise<void> {
    await this.push({
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

  dispose(): void {
    this.check.stop();
    rmSync(this.dir, { recursive: true, force: true });
  }
}

/** A browser that has seen the import: its clock carries the import's counter. */
const browser = new OpFactory(BROWSER, PASSWORD);
let browserCounter = 0;
const afterImport = (): Record<string, number> => ({
  [IMPORT_CLIENT]: 1,
  [BROWSER]: ++browserCounter,
});

let rig: Rig;
afterEach(() => rig?.dispose());

describe('state check', () => {
  it('applies a completed task the way the app does, and files the bridge lagging behind under the known gaps', async () => {
    rig = new Rig();
    await rig.check.start();
    await rig.importInitialState();
    const task = buildTaskEntity({
      title: 'done card',
      projectId: 'INBOX_PROJECT',
      tagIds: ['KANBAN_IN_PROGRESS'],
    });
    await rig.push(await browser.addTask(task, afterImport()));
    await rig.push(
      await browser.updateTask(task.id as string, { isDone: true }, afterImport()),
    );
    await rig.check.compareNow();

    const status = rig.check.status;
    expect(status).toMatchObject({
      state: 'running',
      appRulesSeq: 3,
      lastCompareSeq: 3,
      reducerFailures: 0,
      error: null,
    });
    expect(status.differences['in-progress-on-done']).toBe(1);
    expect(status.differences.new).toBeUndefined();
  }, 60_000);

  it('drops an op made without knowledge of the import, as every browser does, while the bridge applies it', async () => {
    rig = new Rig();
    await rig.check.start();
    await rig.importInitialState();
    const task = buildTaskEntity({ title: 'kept', projectId: 'INBOX_PROJECT' });
    await rig.push(await browser.addTask(task, afterImport()));
    const stale = new OpFactory(STALE_BROWSER, PASSWORD);
    await rig.push(
      await stale.updateTask(
        task.id as string,
        { title: 'stale rename' },
        { [STALE_BROWSER]: 7 },
      ),
    );
    await rig.check.compareNow();

    const status = rig.check.status;
    expect(status.droppedOps).toBe(1);
    expect(status.differences).toEqual({ 'import-filter': 1 });
    expect((rig.mat.state.TASK[task.id as string] as { title: string }).title).toBe(
      'stale rename',
    );
  }, 60_000);

  it('stops at an op from a newer app version, as a browser does, and the bridge carries on', async () => {
    rig = new Rig();
    await rig.check.start();
    await rig.importInitialState();
    const future = await browser.addTask(
      buildTaskEntity({ title: 'future' }),
      afterImport(),
    );
    await rig.push({ ...future, schemaVersion: 999 } as SuperSyncOperation);

    expect(rig.check.status.state).toBe('stopped');
    expect(rig.check.status.error).toContain('VERSION_TOO_NEW');
    const later = buildTaskEntity({ title: 'later' });
    await expect(
      rig.push(await browser.addTask(later, afterImport())),
    ).resolves.toBeUndefined();
    expect(rig.mat.state.TASK[later.id as string]).toBeDefined();
  }, 60_000);

  it('never throws when the app rules cannot start; it stays stopped and the bridge is untouched', async () => {
    rig = new Rig();
    rig.check = rig.newCheck(join(rig.dir, 'missing-worker.js'));
    await expect(rig.check.start()).resolves.toBeUndefined();
    expect(rig.check.status.state).toBe('stopped');
    await rig.importInitialState();
    expect(rig.mat.lastServerSeq).toBe(1);
  }, 60_000);

  it('catches up from the server after a restart, from its own cache, without the bridge replaying anything', async () => {
    rig = new Rig();
    await rig.check.start();
    await rig.importInitialState();
    await rig.push(await browser.addTask(buildTaskEntity({ title: 'a' }), afterImport()));
    rig.check.stop();
    // Written while the state check was down: only the materializer saw them.
    await rig.push(
      await browser.addTask(buildTaskEntity({ title: 'b' }), afterImport()),
      { checkSees: false },
    );
    await rig.push(
      await browser.addTask(buildTaskEntity({ title: 'c' }), afterImport()),
      { checkSees: false },
    );

    rig.check = rig.newCheck();
    await rig.check.start();
    await rig.check.compareNow();
    expect(rig.check.status).toMatchObject({
      state: 'running',
      appRulesSeq: 4,
      lastCompareSeq: 4,
      error: null,
    });
    expect(rig.check.status.differences.new).toBeUndefined();
  }, 60_000);

  it('archives through the app own archive code: the task leaves the live state into the archive', async () => {
    rig = new Rig();
    await rig.check.start();
    await rig.importInitialState();
    const task = buildTaskEntity({ title: 'to archive', projectId: 'INBOX_PROJECT' });
    await rig.push(await browser.addTask(task, afterImport()));
    await rig.push(
      await browser.updateTask(task.id as string, { isDone: true }, afterImport()),
    );
    const done = { ...task, isDone: true, subTasks: [] };
    await rig.push({
      id: uuidv7(),
      clientId: BROWSER,
      actionType: '[Task Shared] moveToArchive',
      opType: 'UPD',
      entityType: 'TASK',
      entityId: task.id as string,
      entityIds: [task.id as string],
      payload: await encrypt(
        JSON.stringify({ actionPayload: { tasks: [done] }, entityChanges: [] }),
        PASSWORD,
      ),
      isPayloadEncrypted: true,
      vectorClock: afterImport(),
      timestamp: Date.now(),
      schemaVersion: 4,
    } as SuperSyncOperation);
    await rig.check.compareNow();

    const status = rig.check.status;
    expect(status.archiveFailures).toBe(0);
    // The bridge ignores archive actions, so the task is still live there: exactly the known archive gap, nothing new.
    expect(status.differences.archive).toBeGreaterThan(0);
    expect(status.differences.new).toBeUndefined();
  }, 60_000);
});
