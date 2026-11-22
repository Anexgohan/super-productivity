/**
 * Whole-board export and import on the built worker, against a fake sync server that wipes its op log on a clean slate. Synthetic data only.
 *
 * Runs against dist/app-rules-worker.js, the file that ships; `npm test` builds it first (build:app-rules).
 */
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { gunzipSync } from 'node:zlib';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { decrypt, encrypt } from '@sp/sync-core';
import type { SuperSyncOperation, SuperSyncServerOperation } from '@sp/shared-schema';
import {
  buildNoteEntity,
  buildProjectEntity,
  buildTaskEntity,
  OpFactory,
  uuidv7,
} from '../src/op-factory';
import { AppRulesWorker } from '../src/app-rules-worker';
import { runImportCheck } from '../src/import-check';
import { BridgeCore } from '../src/core';
import type { AppRulesImportCheck } from '../src/app-rules-protocol';
import type { BridgeConfig } from '../src/config';
import { StateStore } from '../src/state-store';
import type { SyncClient } from '../src/sync-client';
import {
  exportBoard,
  importBoard,
  ImportError,
  PRE_IMPORT_DIR,
  readSavedFile,
  savedFileName,
} from '../src/board-transfer';

const WORKER = join(__dirname, '../dist/app-rules-worker.js');
const LEGACY_FIXTURE = join(
  __dirname,
  '../../../src/app/op-log/backup/test-fixtures/legacy-v10-backup.json',
);
const PASSWORD = 'board-transfer-test-passphrase';
const IMPORT_CLIENT = 'B_import';
const BROWSER = 'B_browser';

type AppData = Record<string, unknown>;

let worker: AppRulesWorker;
let initialAppData: AppData;
let boardCounter = 0;
const dirs: string[] = [];
const stores: StateStore[] = [];

const tempDir = (): string => {
  const dir = mkdtempSync(join(tmpdir(), 'board-transfer-test-'));
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

/** A sync server's op log for one account, with the snapshot endpoint's clean slate. */
class FakeSync {
  rows: SuperSyncServerOperation[] = [];
  lastSeq = 0;
  /** Every BACKUP_IMPORT snapshot body received. */
  imports: Record<string, unknown>[] = [];
  /** Answers a BACKUP_IMPORT instead of storing it, when set. */
  respond: ((body: Record<string, unknown>) => Promise<Response | null>) | null = null;
  /** How many stored imports lose their answer on the way back. */
  loseAnswers = 0;

  push(op: SuperSyncOperation): SuperSyncServerOperation {
    const row = {
      serverSeq: ++this.lastSeq,
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
      return json({ ops, hasMore: false, latestSeq: this.lastSeq });
    }
    if (u.pathname === '/api/sync/ops' && init?.method === 'POST') {
      const { ops } = JSON.parse(init.body as string) as { ops: SuperSyncOperation[] };
      const results = ops.map((op) => ({
        opId: op.id,
        accepted: true,
        serverSeq: this.push(op).serverSeq,
      }));
      return json({ results, latestSeq: this.lastSeq });
    }
    if (u.pathname === '/api/sync/snapshot') {
      const body = JSON.parse(gunzipSync(init?.body as Buffer).toString('utf8'));
      if (body.snapshotOpType !== 'BACKUP_IMPORT') {
        return json({ accepted: false, errorCode: 'REPAIR_STALE', error: 'not here' });
      }
      this.imports.push(body);
      // The real server refuses on auth and size before it looks the op id up.
      const answer = await this.respond?.(body);
      if (answer) return answer;
      // The real server answers a repeated op id with the row it already stored.
      const stored = this.rows.find((r) => r.op.id === body.opId);
      if (stored) return this.answer({ accepted: true, serverSeq: stored.serverSeq });
      if (body.isCleanSlate) this.rows = [];
      const row = this.push({
        id: body.opId,
        clientId: body.clientId,
        actionType: '[SP_ALL] Load(import) all data',
        opType: body.snapshotOpType,
        entityType: 'ALL',
        payload: body.state,
        isPayloadEncrypted: body.isPayloadEncrypted,
        vectorClock: body.vectorClock,
        timestamp: Date.now(),
        schemaVersion: body.schemaVersion,
        syncImportReason: body.syncImportReason,
      } as SuperSyncOperation);
      return this.answer({ accepted: true, serverSeq: row.serverSeq });
    }
    throw new Error(`unexpected request ${init?.method ?? 'GET'} ${url}`);
  };

  private answer(body: unknown): Response {
    if (this.loseAnswers > 0) {
      this.loseAnswers--;
      throw new Error('connection reset');
    }
    return json(body);
  }
}

const browser = new OpFactory(BROWSER, PASSWORD);
let clockCounter = 0;
const nextClock = (): Record<string, number> => ({
  [IMPORT_CLIENT]: 1,
  [BROWSER]: ++clockCounter,
});

/** A history with a project, a task in it, a note and an archived task, starting from the app's initial state. */
const seed = async (sync: FakeSync): Promise<{ taskId: string; archivedId: string }> => {
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
  const project = buildProjectEntity({ title: 'seeded project' });
  sync.push(await browser.addProject(project, nextClock()));
  const task = buildTaskEntity({ title: 'seeded task', projectId: project.id as string });
  sync.push(await browser.addTask(task, nextClock()));
  sync.push(
    await browser.addNote(buildNoteEntity({ content: 'seeded note' }), nextClock()),
  );
  const archived = buildTaskEntity({ title: 'archived task' });
  sync.push(await browser.addTask(archived, nextClock()));
  sync.push({
    id: uuidv7(),
    clientId: BROWSER,
    actionType: '[Task Shared] moveToArchive',
    opType: 'UPD',
    entityType: 'TASK',
    entityId: archived.id as string,
    entityIds: [archived.id as string],
    payload: await encrypt(
      JSON.stringify({
        actionPayload: { tasks: [{ ...archived, isDone: true, subTasks: [] }] },
        entityChanges: [],
      }),
      PASSWORD,
    ),
    isPayloadEncrypted: true,
    vectorClock: nextClock(),
    timestamp: Date.now(),
    schemaVersion: 4,
  } as SuperSyncOperation);
  return { taskId: task.id as string, archivedId: archived.id as string };
};

/** One board on the real worker, synced against `sync`. */
const startStore = async (
  sync: FakeSync,
  dataDir = tempDir(),
  key = `user-${++boardCounter}`,
): Promise<StateStore> => {
  vi.stubGlobal('fetch', sync.fetch);
  const cfg = {
    syncServerUrl: 'http://sync.test',
    encryptionPassword: PASSWORD,
    clientId: 'B_bridge',
    dataDir,
    pollIntervalSec: 3600,
  } as BridgeConfig;
  const store = new StateStore(cfg, worker, {
    mintToken: async () => 'token',
    cacheKey: key,
    clientId: `B_bridge-${key}`,
  });
  stores.push(store);
  await store.appRules.open();
  await (store as unknown as { _client: SyncClient })._client.authenticate();
  await store.refresh();
  return store;
};

const snapshotOf = async (store: StateStore): Promise<AppData> => {
  const res = await worker.request({ kind: 'snapshot', board: store.boardName });
  if (res.kind !== 'snapshot') throw new Error('unexpected reply');
  return res.snapshot.appData;
};

/** The device-only sync settings removed, as every full state travels. */
const withoutDeviceSync = (data: AppData): AppData => {
  const gc = data.globalConfig as Record<string, Record<string, unknown>>;
  const { syncInterval, isManualSyncOnly, ...sync } = gc.sync;
  void syncInterval;
  void isManualSyncOnly;
  return { ...data, globalConfig: { ...gc, sync: { ...sync, syncProvider: null } } };
};

const bytesOf = (value: unknown): Buffer => Buffer.from(JSON.stringify(value));

const check = (value: unknown): Promise<AppRulesImportCheck> =>
  runImportCheck(
    { body: typeof value === 'string' ? Buffer.from(value) : bytesOf(value) },
    worker.importCheck,
  );

const checkedData = (c: AppRulesImportCheck): AppData => {
  if (!c.accepted) throw new Error(`refused: ${c.reason} ${c.errors.join('; ')}`);
  return JSON.parse(Buffer.from(c.bytes).toString('utf8'));
};

const tasksOf = (data: AppData): Record<string, { title?: string; projectId?: string }> =>
  (data.task as { entities: Record<string, { title?: string; projectId?: string }> })
    .entities;

const savedDir = (store: StateStore): string => join(store.dataDir, PRE_IMPORT_DIR);

const exportOf = async (store: StateStore): Promise<{ data: AppData } & AppData> =>
  JSON.parse((await exportBoard(store)).toString('utf8'));

describe('import check: the app own backup steps', () => {
  it('upgrades a legacy backup file and accepts it', async () => {
    // The fixture lacks fields today's app requires, which no migration or repair adds; they are filled in here so the upgrade alone decides.
    const legacy = JSON.parse(readFileSync(LEGACY_FIXTURE, 'utf8'));
    const inbox = (initialAppData.project as { entities: Record<string, AppData> })
      .entities.INBOX_PROJECT;
    const today = (initialAppData.tag as { entities: Record<string, AppData> }).entities
      .TODAY;
    for (const p of Object.values(legacy.project.entities) as AppData[]) {
      p.advancedCfg = inbox.advancedCfg;
      p.theme = inbox.theme;
    }
    for (const t of Object.values(legacy.tag.entities) as AppData[]) {
      t.advancedCfg = today.advancedCfg;
      t.theme = today.theme;
    }
    for (const n of Object.values(legacy.note.entities) as AppData[]) n.modified = 1;
    for (const r of Object.values(legacy.taskRepeatCfg.entities) as AppData[]) {
      Object.assign(r, { order: 0, repeatCycle: 'DAILY', repeatEvery: 1 });
    }
    const c = await check(legacy);
    expect(c).toMatchObject({ accepted: true, migratedLegacy: true });
    expect(Object.keys(tasksOf(checkedData(c))).length).toBeGreaterThan(0);
  }, 60_000);

  it('repairs a repairable backup and accepts the repaired data', async () => {
    const sync = new FakeSync();
    const { taskId } = await seed(sync);
    const file = await exportOf(await startStore(sync));
    tasksOf(file.data)[taskId].projectId = 'NO_SUCH_PROJECT';
    const c = await check(file);
    expect(c).toMatchObject({ accepted: true, repaired: true });
    expect(tasksOf(checkedData(c))[taskId].projectId).not.toBe('NO_SUCH_PROJECT');
  }, 60_000);

  it('refuses what is not JSON, not an object, or not repairable, with paths but no values', async () => {
    expect(await check('not json {')).toMatchObject({
      accepted: false,
      reason: 'not-json',
    });
    expect(await check([1, 2])).toMatchObject({ accepted: false, reason: 'invalid' });
    const unrepairable = await check({ globalConfig: { secret: 'do-not-echo' } });
    expect(unrepairable).toMatchObject({ accepted: false, reason: 'invalid' });
    expect(JSON.stringify(unrepairable)).not.toContain('do-not-echo');
  }, 60_000);

  it('refuses a backup the repair leaves invalid', async () => {
    const sync = new FakeSync();
    const { taskId } = await seed(sync);
    const file = await exportOf(await startStore(sync));
    tasksOf(file.data)[taskId].projectId = 'NO_SUCH_PROJECT';
    // A missing project theme, which the repair does not restore, beside a defect it does fix.
    for (const p of Object.values(
      (file.data.project as { entities: Record<string, AppData> }).entities,
    ))
      delete p.theme;
    const c = await check(file);
    expect(c).toMatchObject({ accepted: false, reason: 'still-invalid' });
  }, 60_000);

  it('strips the device-only sync settings, as a browser does before it uploads a full state', async () => {
    const data = structuredClone(initialAppData);
    const gc = data.globalConfig as Record<string, Record<string, unknown>>;
    gc.sync = {
      ...gc.sync,
      syncProvider: 'SuperSync',
      syncInterval: 5,
      isManualSyncOnly: true,
    };
    const sync = (checkedData(await check(data)).globalConfig as Record<string, AppData>)
      .sync;
    expect(sync.syncProvider).toBeNull();
    expect('syncInterval' in sync).toBe(false);
    expect('isManualSyncOnly' in sync).toBe(false);
  }, 60_000);

  it('gives back the checked data whole, characters beyond U+FFFF included wherever the output is cut', async () => {
    // One such character is two halves; one more character in front puts a half on each side of every cut.
    for (const lead of ['', 'a']) {
      const data = structuredClone(initialAppData);
      const title = `${lead}${'😀'.repeat(700_000)}`;
      (
        data.project as { entities: Record<string, AppData> }
      ).entities.INBOX_PROJECT.title = title;
      const checked = checkedData(await check(data));
      expect(
        (checked.project as { entities: Record<string, AppData> }).entities.INBOX_PROJECT
          .title === title,
      ).toBe(true);
    }
  }, 60_000);

  it('accepts the wrapped backup file and the bare data alike', async () => {
    const wrapped = await check({
      timestamp: 1,
      lastUpdate: 1,
      crossModelVersion: 4.5,
      data: initialAppData,
    });
    const bare = await check(initialAppData);
    expect(wrapped.accepted && bare.accepted).toBe(true);
    expect(checkedData(wrapped)).toEqual(checkedData(bare));
  }, 60_000);
});

describe('export', () => {
  it('round-trips: the export, checked for import, is the board, archives included', async () => {
    const sync = new FakeSync();
    const { taskId, archivedId } = await seed(sync);
    const store = await startStore(sync);
    const file = await exportOf(store);
    expect(file).toMatchObject({ crossModelVersion: expect.any(Number) });
    expect((file.data.archiveYoung as { task: { ids: string[] } }).task.ids).toContain(
      archivedId,
    );
    const c = await check(file);
    expect(checkedData(c)).toEqual(withoutDeviceSync(await snapshotOf(store)));
    expect(c.accepted && c.counts).toMatchObject({
      tasks: 1,
      projects: 2,
      notes: 1,
      archivedTasks: 1,
    });
    expect(tasksOf(checkedData(c))[taskId].title).toBe('seeded task');
  }, 60_000);
});

describe('import', () => {
  /** A backup file of another board: one task, nothing else. */
  const otherBoardFile = async (): Promise<{ file: Buffer; taskId: string }> => {
    const sync = new FakeSync();
    sync.push({
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
    const task = buildTaskEntity({ title: 'imported task' });
    sync.push(await browser.addTask(task, nextClock()));
    const store = await startStore(sync);
    const file = await exportBoard(store);
    store.stop();
    return { file, taskId: task.id as string };
  };

  it("uploads the app's own backup import: clean slate, encrypted, a clock above everything seen", async () => {
    const { file, taskId } = await otherBoardFile();
    const sync = new FakeSync();
    await seed(sync);
    const store = await startStore(sync);
    const seen = store.appRules.mergedClock;
    const expected = checkedData(await check(JSON.parse(file.toString('utf8'))));

    const result = await importBoard(store, { body: Buffer.from(file) });

    expect(sync.imports).toHaveLength(1);
    const body = sync.imports[0];
    expect(body).toMatchObject({
      snapshotOpType: 'BACKUP_IMPORT',
      reason: 'recovery',
      syncImportReason: 'BACKUP_RESTORE',
      isCleanSlate: true,
      isPayloadEncrypted: true,
      schemaVersion: 4,
      clientId: `B_bridge-${store.boardName}`,
    });
    const clock = body.vectorClock as Record<string, number>;
    for (const [k, v] of Object.entries(seen)) expect(clock[k]).toBeGreaterThanOrEqual(v);
    expect(clock[`B_bridge-${store.boardName}`]).toBeGreaterThan(
      seen[`B_bridge-${store.boardName}`] ?? 0,
    );
    expect(JSON.parse(await decrypt(body.state as string, PASSWORD))).toEqual(expected);
    expect(result).toMatchObject({
      imported: true,
      serverSeq: 7,
      migratedLegacy: false,
      repaired: false,
      counts: { tasks: 1 },
      droppedServerChanges: 0,
      readBack: true,
    });
    expect(tasksOf(expected)[taskId]).toBeDefined();
  }, 60_000);

  it('counts the changes that reached the server after the board was saved', async () => {
    const { file } = await otherBoardFile();
    const sync = new FakeSync();
    await seed(sync);
    const store = await startStore(sync);
    sync.respond = async () => {
      sync.push(await browser.addTask(buildTaskEntity({ title: 'late' }), nextClock()));
      return null;
    };
    expect(await importBoard(store, { body: file })).toMatchObject({
      droppedServerChanges: 1,
    });
  }, 60_000);

  it('the board reads its own import back: it becomes the imported board', async () => {
    const { file, taskId } = await otherBoardFile();
    const sync = new FakeSync();
    const seeded = await seed(sync);
    const store = await startStore(sync);
    const expected = checkedData(await check(JSON.parse(file.toString('utf8'))));

    await importBoard(store, { body: file });

    const after = await snapshotOf(store);
    expect(withoutDeviceSync(after)).toEqual(expected);
    expect(store.state.TASK?.[taskId]).toBeDefined();
    expect(store.state.TASK?.[seeded.taskId]).toBeUndefined();
    expect(store.lastServerSeq).toBe(sync.lastSeq);
    expect(store.writesClosed).toBeNull();
  }, 60_000);

  it('saves the board before anything is uploaded, and uploads nothing when it cannot save', async () => {
    const { file } = await otherBoardFile();
    const sync = new FakeSync();
    const { taskId } = await seed(sync);
    const store = await startStore(sync);
    let savedAtUpload: AppData | null = null;
    sync.respond = async () => {
      const [name] = readdirSync(savedDir(store));
      savedAtUpload = JSON.parse(readFileSync(join(savedDir(store), name), 'utf8'));
      return null;
    };
    const result = await importBoard(store, { body: Buffer.from(file) });
    expect(
      tasksOf((savedAtUpload as unknown as { data: AppData }).data)[taskId].title,
    ).toBe('seeded task');
    expect(result.savedBefore).toMatch(/^pre-import\.user-\d+\..+\.json$/);

    // A file where the folder should be: the save fails, so nothing is uploaded.
    const blockedDir = tempDir();
    writeFileSync(join(blockedDir, PRE_IMPORT_DIR), 'not a folder');
    const sync2 = new FakeSync();
    await seed(sync2);
    const store2 = await startStore(sync2, blockedDir);
    const err = await importBoard(store2, { body: Buffer.from(file) }).catch((e) => e);
    expect(err).toBeInstanceOf(ImportError);
    expect(err.statusCode).toBe(500);
    expect(sync2.imports).toHaveLength(0);
  }, 60_000);

  it("leaves everything in place when the server refuses the board as too large, and names the server's limit", async () => {
    const { file } = await otherBoardFile();
    const sync = new FakeSync();
    const { taskId } = await seed(sync);
    const store = await startStore(sync);
    const rowsBefore = sync.rows.length;
    sync.respond = async () => json({ error: 'Compressed payload too large' }, 413);

    const err = await importBoard(store, { body: file }).catch((e) => e);

    expect(err).toBeInstanceOf(ImportError);
    expect(err.statusCode).toBe(413);
    expect(err.message).toContain('30 MB gzipped');
    expect(err.details.savedBefore).toMatch(/^pre-import\./);
    expect(existsSync(join(savedDir(store), err.details.savedBefore))).toBe(true);
    expect(sync.rows).toHaveLength(rowsBefore);
    expect(store.state.TASK?.[taskId]).toBeDefined();
    expect(store.importing).toBe(false);
  }, 60_000);

  it("keeps the newest 3 saved files of the board and leaves another board's alone", async () => {
    const { file } = await otherBoardFile();
    const dataDir = tempDir();
    const sync = new FakeSync();
    await seed(sync);
    const store = await startStore(sync, dataDir, 'user-1');
    const other = savedFileName('user-10', new Date(0));
    const dir = join(dataDir, PRE_IMPORT_DIR);
    const names: string[] = [];
    for (let i = 0; i < 4; i++) {
      names.push((await importBoard(store, { body: Buffer.from(file) })).savedBefore);
      if (i === 0) writeFileSync(join(dir, other), '{}');
    }
    expect(readdirSync(dir).sort()).toEqual([...names.slice(1), other].sort());
  }, 60_000);

  it('imports a saved file back by name, and reads no other path', async () => {
    const { file } = await otherBoardFile();
    const sync = new FakeSync();
    const { taskId } = await seed(sync);
    const store = await startStore(sync);
    const { savedBefore } = await importBoard(store, { body: file });
    expect(store.state.TASK?.[taskId]).toBeUndefined();

    await importBoard(store, {
      body: readSavedFile(store.dataDir, store.boardName, savedBefore),
    });
    expect(store.state.TASK?.[taskId]).toBeDefined();

    const refusal = (name: string): number => {
      try {
        readSavedFile(store.dataDir, store.boardName, name);
        return 200;
      } catch (e) {
        return (e as ImportError).statusCode;
      }
    };
    expect(refusal('../app-rules-cache.json')).toBe(400);
    expect(refusal(`/${join(savedDir(store), savedBefore)}`)).toBe(400);
    expect(refusal(`pre-import.${store.boardName}/../../x.json`)).toBe(400);
    expect(refusal(savedFileName(store.boardName, new Date(0)))).toBe(404);
    expect(refusal(savedFileName('user-999', new Date(0)))).toBe(404);
  }, 60_000);

  it('refuses API writes and a second import while an import runs on the board', async () => {
    const sync = new FakeSync();
    await seed(sync);
    const store = await startStore(sync);
    expect(store.beginImport()).toBe(true);
    const write = await store.submitOps([]).catch((e) => e);
    expect(write.statusCode).toBe(409);
    const second = await importBoard(store, { body: Buffer.from('{}') }).catch((e) => e);
    expect(second.statusCode).toBe(409);
    store.endImport();
  }, 60_000);
});

describe('import failures', () => {
  const importsOnServer = (sync: FakeSync): number =>
    sync.rows.filter((r) => r.op.opType === 'BACKUP_IMPORT').length;

  it('keeps only the newest 3 saved files when the server refuses every upload, and says the board is unchanged', async () => {
    const sync = new FakeSync();
    await seed(sync);
    const store = await startStore(sync);
    const file = await exportBoard(store);
    sync.respond = async () => json({ error: 'Compressed payload too large' }, 413);
    for (let i = 0; i < 4; i++) {
      const err = await importBoard(store, { body: Buffer.from(file) }).catch((e) => e);
      expect(err.statusCode).toBe(413);
      expect(err.message).toContain('The board is unchanged.');
    }
    expect(readdirSync(savedDir(store))).toHaveLength(3);
  }, 60_000);

  it('sends an upload whose answer was lost once more as the same op, so the server holds one import', async () => {
    const sync = new FakeSync();
    const { taskId } = await seed(sync);
    const store = await startStore(sync);
    sync.loseAnswers = 1;

    const result = await importBoard(store, { body: bytesOf(initialAppData) });

    expect(result).toMatchObject({ imported: true, readBack: true });
    expect(sync.imports.map((b) => b.opId)).toEqual([
      sync.imports[0].opId,
      sync.imports[0].opId,
    ]);
    expect(importsOnServer(sync)).toBe(1);
    expect(store.state.TASK?.[taskId]).toBeUndefined();
  }, 60_000);

  it('when no answer comes, says the outcome is unknown, takes no writes until a sync, and a retry of the same file is the same import', async () => {
    const sync = new FakeSync();
    await seed(sync);
    const store = await startStore(sync);
    const file = bytesOf(initialAppData);
    sync.loseAnswers = 2;

    const err = await importBoard(store, { body: Buffer.from(file) }).catch((e) => e);

    expect(err.statusCode).toBe(502);
    expect(err.message).not.toContain('unchanged');
    expect(err.details).toMatchObject({ outcome: 'unknown' });
    expect(importsOnServer(sync)).toBe(1);
    expect((await store.submitOps([]).catch((e) => e)).statusCode).toBe(409);

    // A sync of the board in between ends the wait for writes; the unsettled import is still remembered.
    await store.refresh();
    expect(store.writesClosed).toBeNull();
    const again = await importBoard(store, { body: Buffer.from(file) });
    expect(again).toMatchObject({ savedBefore: err.details.savedBefore, readBack: true });
    expect(new Set(sync.imports.map((b) => b.opId)).size).toBe(1);
    expect(importsOnServer(sync)).toBe(1);
    expect(readdirSync(savedDir(store))).toEqual([err.details.savedBefore]);
  }, 60_000);

  for (const [refusal, answer] of [
    ['a refused token', () => json({ error: 'Token expired' }, 401)],
    [
      'an answer that it was not accepted',
      () => json({ accepted: false, errorCode: 'CONFLICT', error: 'try later' }),
    ],
  ] as const) {
    it(`keeps an import unknown when its answer was lost and the retry gets ${refusal}`, async () => {
      const sync = new FakeSync();
      await seed(sync);
      const store = await startStore(sync);
      const file = bytesOf(initialAppData);
      sync.loseAnswers = 1;
      sync.respond = async () => (sync.imports.length >= 2 ? answer() : null);

      const err = await importBoard(store, { body: Buffer.from(file) }).catch((e) => e);

      expect(err.statusCode).toBe(502);
      expect(err.message).not.toContain('unchanged');
      expect(err.details).toMatchObject({ outcome: 'unknown' });
      expect(importsOnServer(sync)).toBe(1);
      expect((await store.submitOps([]).catch((e) => e)).statusCode).toBe(409);

      // The first attempt did land, so a retry once the server answers must not restore it a second time.
      sync.respond = null;
      await store.refresh();
      const core = new BridgeCore(
        store,
        new OpFactory(`B_bridge-${store.boardName}`, PASSWORD),
      );
      const { id } = (await core.createTask({ title: 'after the import' })) as {
        id: string;
      };
      const again = await importBoard(store, { body: Buffer.from(file) });
      expect(again).toMatchObject({ savedBefore: err.details.savedBefore });
      expect(new Set(sync.imports.map((b) => b.opId)).size).toBe(1);
      expect(importsOnServer(sync)).toBe(1);
      await store.refresh();
      expect(store.state.TASK?.[id]).toBeDefined();
    }, 60_000);
  }

  it('keeps an unsettled import unknown when a later request to retry it is refused', async () => {
    const sync = new FakeSync();
    await seed(sync);
    const store = await startStore(sync);
    const file = bytesOf(initialAppData);
    sync.loseAnswers = 2;
    const err = await importBoard(store, { body: Buffer.from(file) }).catch((e) => e);
    expect(err.details).toMatchObject({ outcome: 'unknown' });
    await store.refresh();

    sync.respond = async () => json({ error: 'Token expired' }, 401);
    const refused = await importBoard(store, { body: Buffer.from(file) }).catch((e) => e);

    expect(refused.statusCode).toBe(502);
    expect(refused.details).toMatchObject({
      outcome: 'unknown',
      savedBefore: err.details.savedBefore,
    });
    expect((await store.submitOps([]).catch((e) => e)).statusCode).toBe(409);
    sync.respond = null;
    await store.refresh();
    await importBoard(store, { body: Buffer.from(file) });
    expect(new Set(sync.imports.map((b) => b.opId)).size).toBe(1);
  }, 60_000);

  it('a different file after an unsettled import is a new import', async () => {
    const sync = new FakeSync();
    await seed(sync);
    const store = await startStore(sync);
    sync.loseAnswers = 2;
    const err = await importBoard(store, { body: bytesOf(initialAppData) }).catch(
      (e) => e,
    );
    expect(err.statusCode).toBe(502);

    const other = await importBoard(store, {
      body: Buffer.from(JSON.stringify(initialAppData, null, 1)),
    });
    expect(other.savedBefore).not.toBe(err.details.savedBefore);
    expect(new Set(sync.imports.map((b) => b.opId)).size).toBe(2);
  }, 60_000);

  it('never prunes the saved file of an import whose outcome is unknown', async () => {
    const sync = new FakeSync();
    await seed(sync);
    const store = await startStore(sync);
    sync.loseAnswers = 2;
    const err = await importBoard(store, { body: bytesOf(initialAppData) }).catch(
      (e) => e,
    );
    expect(err.statusCode).toBe(502);

    sync.respond = async () => json({ error: 'Compressed payload too large' }, 413);
    for (let i = 0; i < 3; i++) {
      await importBoard(store, {
        body: Buffer.from(JSON.stringify(initialAppData, null, i + 1)),
      }).catch(() => undefined);
    }
    const saved = readdirSync(savedDir(store)).filter((n) => n.startsWith('pre-import.'));
    expect(saved).toHaveLength(4);
    expect(saved).toContain(err.details.savedBefore);
  }, 60_000);

  it('keeps the board closed to API writes until it has read the import back', async () => {
    const sync = new FakeSync();
    const { taskId } = await seed(sync);
    const store = await startStore(sync);
    let failDownloads = false;
    sync.respond = async () => {
      failDownloads = true;
      return null;
    };
    vi.stubGlobal('fetch', async (url: string, init?: RequestInit) => {
      if (failDownloads && url.includes('/api/sync/ops') && init?.method !== 'POST') {
        return json({ error: 'temporary read outage' }, 503);
      }
      return sync.fetch(url, init);
    });

    const result = await importBoard(store, { body: bytesOf(initialAppData) });

    expect(result).toMatchObject({ imported: true, readBack: false });
    expect(store.state.TASK?.[taskId]).toBeDefined();
    const core = new BridgeCore(
      store,
      new OpFactory(`B_bridge-${store.boardName}`, PASSWORD),
    );
    const blocked = await core.updateTask(taskId, { title: 'too early' }).catch((e) => e);
    expect(blocked.statusCode).toBe(409);
    expect(blocked.message).toContain('not read it back');
    expect(sync.rows.map((r) => r.op.opType)).toEqual(['BACKUP_IMPORT']);

    failDownloads = false;
    await store.refresh();
    expect(store.writesClosed).toBeNull();
    expect(store.state.TASK?.[taskId]).toBeUndefined();
    await core.createTask({ title: 'after the import' });
    expect(sync.rows.map((r) => r.op.opType)).toEqual(['BACKUP_IMPORT', 'CRT']);
  }, 60_000);

  it("refuses a file whose check runs out of the check's memory, nothing saved or uploaded, and the worker keeps answering", async () => {
    const sync = new FakeSync();
    await seed(sync);
    const store = await startStore(sync);
    const heapMb = worker.importCheck.heapMb;
    // A small cap stands in for a file too big for the real one; a million tiny values need far more than their few MB of text.
    worker.importCheck.heapMb = 48;
    try {
      const entries = Array.from({ length: 1_000_000 }, (_, i) => `"k${i}":0`);
      const err = await importBoard(store, {
        body: Buffer.from(`{${entries.join(',')}}`),
      }).catch((e) => e);

      expect({ status: err.statusCode, errors: err.details.errors }).toEqual({
        status: 413,
        errors: ['needs more than the 48 MB the import check may use'],
      });
    } finally {
      worker.importCheck.heapMb = heapMb;
    }
    expect(sync.imports).toHaveLength(0);
    expect(existsSync(savedDir(store)) ? readdirSync(savedDir(store)) : []).toEqual([]);
    expect(store.appRules.blocked).toBe(false);
    expect(await importBoard(store, { body: bytesOf(initialAppData) })).toMatchObject({
      imported: true,
    });
  }, 120_000);

  it('refuses the many-tiny-values file at the real cap and stays up', async () => {
    const sync = new FakeSync();
    await seed(sync);
    const store = await startStore(sync);
    const entries = Array.from({ length: 900_000 }, (_, i) => `"k${i}":0`);

    const err = await importBoard(store, {
      body: Buffer.from(`{${entries.join(',')}}`),
    }).catch((e) => e);

    expect([413, 422]).toContain(err.statusCode);
    expect(sync.imports).toHaveLength(0);
    expect(store.appRules.blocked).toBe(false);
    expect((await worker.request({ kind: 'snapshot', board: 'seed' })).kind).toBe(
      'snapshot',
    );
  }, 120_000);

  it('lets go of the file once the check has it', async () => {
    const sync = new FakeSync();
    await seed(sync);
    const store = await startStore(sync);
    const file = { body: bytesOf(initialAppData) as Buffer | null };
    const heldAt: Record<string, boolean> = {};
    const seal = store.sealBackupImport.bind(store);
    vi.spyOn(store, 'sealBackupImport').mockImplementation((data) => {
      heldAt.seal = file.body !== null;
      return seal(data);
    });
    const exportToFile = store.appRules.exportToFile.bind(store.appRules);
    vi.spyOn(store.appRules, 'exportToFile').mockImplementation((path) => {
      heldAt.save = file.body !== null;
      return exportToFile(path);
    });

    expect(await importBoard(store, file)).toMatchObject({ imported: true });
    expect(heldAt).toEqual({ seal: false, save: false });
  }, 60_000);
});
