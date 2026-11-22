/**
 * App actions (anex/app-actions) end to end: built by the app's own code in the built worker, follow-ups included, uploaded to a fake sync
 * server and read back. Synthetic data only.
 *
 * Runs against dist/app-rules-worker.js, the file that ships; `npm test` builds it first (build:app-rules).
 */
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { decrypt, encrypt } from '@sp/sync-core';
import type { SuperSyncOperation, SuperSyncServerOperation } from '@sp/shared-schema';
import { buildTaskEntity, OpFactory, uuidv7 } from '../src/op-factory';
import { AppRulesWorker } from '../src/app-rules-worker';
import { BridgeCore } from '../src/core';
import type { BridgeConfig } from '../src/config';
import { StateStore } from '../src/state-store';
import type { SyncClient } from '../src/sync-client';

const WORKER = join(__dirname, '../dist/app-rules-worker.js');
const PASSWORD = 'app-actions-test-passphrase';
const IMPORT_CLIENT = 'B_import';
const BROWSER = 'B_browser';

type Row = Record<string, unknown>;

let worker: AppRulesWorker;
let initialAppData: Row;
let boardCounter = 0;
const dirs: string[] = [];
const stores: StateStore[] = [];

const tempDir = (): string => {
  const dir = mkdtempSync(join(tmpdir(), 'app-actions-test-'));
  dirs.push(dir);
  return dir;
};

beforeAll(async () => {
  if (!existsSync(WORKER)) {
    throw new Error(
      `${WORKER} is missing: run "npm run build:app-rules" (npm test does it first)`,
    );
  }
  worker = new AppRulesWorker(WORKER, 50);
  worker.start();
  await worker.request({
    kind: 'init',
    board: 'seed',
    init: { clientId: 'x', cachePath: join(tempDir(), 'c.json') },
  });
  const snap = await worker.request({ kind: 'snapshot', board: 'seed' });
  if (snap.kind !== 'snapshot') throw new Error('could not read the initial state');
  initialAppData = snap.snapshot.appData;
}, 60_000);

afterEach(() => {
  for (const s of stores.splice(0)) s.stop();
  vi.unstubAllGlobals();
});

afterAll(() => {
  worker.stop();
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

const json = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), { status });

/** A sync server's op log for one account. */
class FakeSync {
  rows: SuperSyncServerOperation[] = [];
  /** Every upload request's ops, in order. */
  uploads: SuperSyncOperation[][] = [];

  push(op: SuperSyncOperation): SuperSyncServerOperation {
    const row = {
      serverSeq: this.rows.length + 1,
      receivedAt: 0,
      op,
    } as SuperSyncServerOperation;
    this.rows.push(row);
    return row;
  }

  fetch = async (url: string, init?: RequestInit): Promise<Response> => {
    const u = new URL(url);
    if (u.pathname === '/api/sync/ops' && init?.method !== 'POST') {
      const since = Number(u.searchParams.get('sinceSeq'));
      const ops = this.rows.filter((r) => r.serverSeq > since);
      return json({ ops, hasMore: false, latestSeq: this.rows.length });
    }
    if (u.pathname === '/api/sync/ops' && init?.method === 'POST') {
      const { ops } = JSON.parse(init.body as string) as { ops: SuperSyncOperation[] };
      this.uploads.push(ops);
      const results = ops.map((op) => ({
        opId: op.id,
        accepted: true,
        serverSeq: this.push(op).serverSeq,
      }));
      return json({ results, latestSeq: this.rows.length });
    }
    throw new Error(`unexpected request ${init?.method ?? 'GET'} ${url}`);
  };
}

const browser = new OpFactory(BROWSER, PASSWORD);
let clockCounter = 0;
const nextClock = (): Record<string, number> => ({
  [IMPORT_CLIENT]: 1,
  [BROWSER]: ++clockCounter,
});

const importInitialState = async (sync: FakeSync): Promise<void> => {
  sync.push({
    id: uuidv7(),
    clientId: IMPORT_CLIENT,
    actionType: '[SP_ALL] Load(import) all data',
    opType: 'SYNC_IMPORT',
    entityType: 'ALL',
    payload: await encrypt(JSON.stringify({ appDataComplete: initialAppData }), PASSWORD),
    isPayloadEncrypted: true,
    vectorClock: { [IMPORT_CLIENT]: 1 },
    timestamp: Date.now(),
    schemaVersion: 4,
  } as SuperSyncOperation);
};

/** A parent with one subtask, and a second top-level task, written by a browser. */
const seedTasks = async (
  sync: FakeSync,
): Promise<{ parentId: string; subId: string; otherId: string }> => {
  await importInitialState(sync);
  const parent = buildTaskEntity({ title: 'parent' });
  sync.push(await browser.addTask(parent, nextClock()));
  const sub: Row = { ...buildTaskEntity({ title: 'sub' }), parentId: parent.id };
  sync.push(await browser.addSubTask(sub, parent.id as string, nextClock()));
  const other = buildTaskEntity({ title: 'other' });
  sync.push(await browser.addTask(other, nextClock()));
  return {
    parentId: parent.id as string,
    subId: sub.id as string,
    otherId: other.id as string,
  };
};

/** A browser's settings change, as the app's settings page saves it. */
const setTasksConfig = async (sync: FakeSync, sectionCfg: Row): Promise<void> => {
  sync.push({
    id: uuidv7(),
    clientId: BROWSER,
    actionType: '[Global Config] Update Global Config Section',
    opType: 'UPD',
    entityType: 'GLOBAL_CONFIG',
    entityId: 'tasks',
    payload: await encrypt(
      JSON.stringify({
        actionPayload: { sectionKey: 'tasks', sectionCfg },
        entityChanges: [],
      }),
      PASSWORD,
    ),
    isPayloadEncrypted: true,
    vectorClock: nextClock(),
    timestamp: Date.now(),
    schemaVersion: 4,
  } as SuperSyncOperation);
};

const startCore = async (
  sync: FakeSync,
): Promise<{ store: StateStore; core: BridgeCore }> => {
  vi.stubGlobal('fetch', sync.fetch);
  const key = `user-${++boardCounter}`;
  const clientId = `B_bridge-${key}`;
  const cfg = {
    syncServerUrl: 'http://sync.test',
    encryptionPassword: PASSWORD,
    clientId: 'B_bridge',
    dataDir: tempDir(),
    pollIntervalSec: 3600,
  } as BridgeConfig;
  const store = new StateStore(cfg, worker, {
    mintToken: async () => 'token',
    cacheKey: key,
    clientId,
  });
  stores.push(store);
  await store.appRules.open();
  await (store as unknown as { _client: SyncClient })._client.authenticate();
  await store.refresh();
  return { store, core: new BridgeCore(store, new OpFactory(clientId, PASSWORD)) };
};

/** An uploaded op as the server stores it, its payload decrypted. */
const plain = async (op: SuperSyncOperation): Promise<Row> => ({
  ...op,
  payload: JSON.parse(await decrypt(op.payload as string, PASSWORD)) as Row,
});

const tasksOf = (store: StateStore): Record<string, Row> =>
  (store.state.TASK ?? {}) as Record<string, Row>;

describe('app actions', () => {
  it('deletes tasks with their subtasks in one op, sending ids only', async () => {
    const sync = new FakeSync();
    const { parentId, subId, otherId } = await seedTasks(sync);
    const { store, core } = await startCore(sync);
    expect(Object.keys(tasksOf(store))).toEqual(
      expect.arrayContaining([parentId, subId, otherId]),
    );

    const res = await core.act('deleteTasks', { taskIds: [parentId, otherId] });

    expect(sync.uploads).toHaveLength(1);
    const [op] = await Promise.all(sync.uploads[0].map(plain));
    expect(sync.uploads[0]).toHaveLength(1);
    expect(res.opIds).toEqual([op.id]);
    expect(op).toMatchObject({
      actionType: '[Task Shared] deleteTasks',
      opType: 'DEL',
      clientId: expect.stringMatching(/^B_bridge-user-/),
      isPayloadEncrypted: true,
    });
    const actionPayload = (op.payload as Row).actionPayload as Row;
    expect(actionPayload.taskIds).toEqual([parentId, otherId]);
    expect(actionPayload).not.toHaveProperty('tasks');
    expect(op.entityIds).toEqual([parentId, otherId]);
    for (const id of [parentId, subId, otherId])
      expect(tasksOf(store)[id]).toBeUndefined();
  });

  it('uploads nothing when the build fails: an unknown task answers 404', async () => {
    const sync = new FakeSync();
    const { otherId } = await seedTasks(sync);
    const { core } = await startCore(sync);

    await expect(
      core.act('deleteTasks', { taskIds: [otherId, 'no-such-task'] }),
    ).rejects.toMatchObject({ statusCode: 404 });
    await expect(core.act('noSuchAction', {})).rejects.toMatchObject({ statusCode: 404 });
    await expect(
      core.act('deleteTasks', { taskIds: [otherId], extra: 1 }),
    ).rejects.toMatchObject({ statusCode: 400 });
    expect(sync.uploads).toEqual([]);
  });

  it("adds the app's follow-up: the last open subtask done completes its parent, in the same upload", async () => {
    const sync = new FakeSync();
    const { parentId, subId } = await seedTasks(sync);
    await setTasksConfig(sync, { isAutoMarkParentAsDone: true });
    const { store, core } = await startCore(sync);

    await core.act('updateTask', { taskId: subId, changes: { isDone: true } });

    expect(sync.uploads).toHaveLength(1);
    const ops = await Promise.all(sync.uploads[0].map(plain));
    expect(ops.map((op) => [op.actionType, op.entityId])).toEqual([
      ['[Task Shared] updateTask', subId],
      ['[Task Shared] updateTask', parentId],
    ]);
    expect(((ops[1].payload as Row).actionPayload as Row).task).toMatchObject({
      id: parentId,
      changes: { isDone: true },
    });
    expect(tasksOf(store)[parentId]).toMatchObject({ isDone: true });
    expect(tasksOf(store)[subId]).toMatchObject({ isDone: true });
  });

  it("leaves the parent open when the board's setting says so, as the app does", async () => {
    const sync = new FakeSync();
    const { parentId, subId } = await seedTasks(sync);
    const { store, core } = await startCore(sync);

    await core.act('updateTask', { taskId: subId, changes: { isDone: true } });

    expect(sync.uploads[0].map((op) => op.entityId)).toEqual([subId]);
    expect(tasksOf(store)[parentId]).toMatchObject({ isDone: false });
  });

  it("makes a task recurring with the app's follow-ups, on the caller's day", async () => {
    const sync = new FakeSync();
    const { otherId } = await seedTasks(sync);
    const { store, core } = await startCore(sync);
    const day = '2031-03-03';

    const res = await core.act(
      'addTaskRepeatCfgToTask',
      { taskId: otherId, repeatCycle: 'DAILY' },
      { today: day },
    );

    expect(sync.uploads).toHaveLength(1);
    const ops = await Promise.all(sync.uploads[0].map(plain));
    const cfgId = res.refs.taskRepeatCfgId;
    const payloads = ops.map((op) => (op.payload as Row).actionPayload as Row);
    // The add, then what updateTaskAfterMakingItRepeatable$ saves: the config's first-occurrence day, the task's due day, and the
    // config's fields copied onto the task, unchanged values included, as a browser uploads them.
    expect(ops.map((op) => [op.actionType, op.entityId])).toEqual([
      ['[TaskRepeatCfg][Task] Add TaskRepeatCfg to Task', cfgId],
      ['[TaskRepeatCfg] Update TaskRepeatCfg', cfgId],
      ['[Task Shared] updateTask', otherId],
      ['[Task Shared] updateTask', otherId],
      ['[Task Shared] updateTask', otherId],
      ['[Task Shared] updateTask', otherId],
    ]);
    expect(payloads[0]).toMatchObject({
      taskId: otherId,
      taskRepeatCfg: { id: cfgId, repeatCycle: 'DAILY', startDate: day, title: 'other' },
    });
    expect(payloads[1]).toMatchObject({
      taskRepeatCfg: {
        id: cfgId,
        changes: { lastTaskCreationDay: day, subTaskTemplates: [] },
      },
    });
    const changes = payloads.slice(2).map((p) => (p.task as Row).changes as Row);
    // The task moves to its first occurrence, created date included, so the repeat processor doesn't make a second one.
    expect(new Date(changes[0].created as number).toLocaleDateString('en-CA')).toBe(day);
    expect(changes).toEqual([
      { dueDay: day, created: changes[0].created },
      { tagIds: [] },
      { title: 'other' },
      { timeEstimate: 0 },
    ]);
    // Op times stay the container's, whatever day the caller gave.
    for (const op of ops)
      expect(Math.abs((op.timestamp as number) - Date.now())).toBeLessThan(60_000);
    expect(res.opIds).toEqual(ops.map((op) => op.id));
    expect(tasksOf(store)[otherId]).toMatchObject({ repeatCfgId: cfgId, dueDay: day });
    expect(store.state.TASK_REPEAT_CFG?.[cfgId]).toMatchObject({
      lastTaskCreationDay: day,
    });
  });

  it("refuses a change the app's validation finds breaks the board, naming why, and uploads nothing", async () => {
    const sync = new FakeSync();
    const { otherId } = await seedTasks(sync);
    const { core } = await startCore(sync);

    const err = await core
      .act('addTaskRepeatCfgToTask', { taskId: otherId, tagIds: ['no-such-tag'] })
      .catch((e: unknown) => e);

    expect(err).toMatchObject({
      statusCode: 409,
      errors: [expect.stringContaining('tagId from task not existing')],
    });
    expect(sync.uploads).toEqual([]);
  });

  it("deletes one task through the existing route as the app's delete button does, still refusing a parent", async () => {
    const sync = new FakeSync();
    const { parentId, otherId } = await seedTasks(sync);
    const { store, core } = await startCore(sync);

    await expect(core.deleteTask(parentId)).rejects.toMatchObject({ statusCode: 409 });
    expect(sync.uploads).toEqual([]);

    expect(await core.deleteTask(otherId)).toEqual({ deleted: otherId });
    const ops = await Promise.all(sync.uploads[0].map(plain));
    expect(ops.map((op) => [op.actionType, op.entityId])).toEqual([
      ['[Task Shared] deleteTask', otherId],
    ]);
    expect(((ops[0].payload as Row).actionPayload as Row).task).toMatchObject({
      id: otherId,
      subTasks: [],
    });
    expect(tasksOf(store)[otherId]).toBeUndefined();
  });

  it('makes a task recurring through the existing route and answers the saved config', async () => {
    const sync = new FakeSync();
    const { otherId } = await seedTasks(sync);
    const { core } = await startCore(sync);

    const cfg = await core.createTaskRepeatCfg(otherId, {
      repeatCycle: 'WEEKLY',
      friday: false,
    });

    expect(cfg).toMatchObject({ repeatCycle: 'WEEKLY', friday: false, title: 'other' });
    expect(sync.uploads[0][0].actionType).toBe(
      '[TaskRepeatCfg][Task] Add TaskRepeatCfg to Task',
    );
    await expect(core.createTaskRepeatCfg(otherId, {})).rejects.toMatchObject({
      statusCode: 409,
    });
    await expect(
      core.createTaskRepeatCfg(otherId, { color: 'red' }),
    ).rejects.toMatchObject({
      statusCode: 400,
    });
  });

  it('builds on the newest state the server has, and is refused while writes are closed', async () => {
    const sync = new FakeSync();
    await seedTasks(sync);
    const { store, core } = await startCore(sync);
    // Another device adds a task after the board's last sync.
    const late = buildTaskEntity({ title: 'late' });
    sync.push(await browser.addTask(late, nextClock()));

    await core.act('deleteTasks', { taskIds: [late.id as string] });
    expect(sync.uploads).toHaveLength(1);

    store.closeWritesUntil(Number.MAX_SAFE_INTEGER, 'Writes are closed for the test.');
    await expect(
      core.act('deleteTasks', { taskIds: [Object.keys(tasksOf(store))[0]] }),
    ).rejects.toMatchObject({
      statusCode: 409,
      message: 'Writes are closed for the test.',
    });
    expect(sync.uploads).toHaveLength(1);
  });
});
