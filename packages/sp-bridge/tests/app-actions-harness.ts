/**
 * The harness of the app-action specs (anex/app-actions): the built worker, a fake sync server, and browsers that seed the board.
 *
 * Runs against dist/app-rules-worker.js, the file that ships; `npm test` builds it first (build:app-rules).
 * Synthetic data only.
 */
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, beforeAll, vi } from 'vitest';
import { decrypt, encrypt } from '@sp/sync-core';
import type { SuperSyncOperation, SuperSyncServerOperation } from '@sp/shared-schema';
import { buildTaskEntity, OpFactory, uuidv7 } from '../src/op-factory';
import { AppRulesWorker } from '../src/app-rules-worker';
import { BridgeCore } from '../src/core';
import type { BridgeConfig } from '../src/config';
import { StateStore } from '../src/state-store';
import type { SyncClient } from '../src/sync-client';

const WORKER = join(__dirname, '../dist/app-rules-worker.js');
export const PASSWORD = 'app-actions-test-passphrase';
const IMPORT_CLIENT = 'B_import';
const BROWSER = 'B_browser';

export type Row = Record<string, unknown>;

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

/** Starts the built worker for the spec file that calls it, and stops it and its boards after. */
export const useActionWorker = (): void => {
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
};

const json = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), { status });

/** A sync server's op log for one account. */
export class FakeSync {
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

export const browser = new OpFactory(BROWSER, PASSWORD);
let clockCounter = 0;
export const nextClock = (): Record<string, number> => ({
  [IMPORT_CLIENT]: 1,
  [BROWSER]: ++clockCounter,
});

export const importInitialState = async (sync: FakeSync): Promise<void> => {
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
export const seedTasks = async (
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
export const setConfigSection = async (
  sync: FakeSync,
  sectionKey: string,
  sectionCfg: Row,
): Promise<void> => {
  sync.push({
    id: uuidv7(),
    clientId: BROWSER,
    actionType: '[Global Config] Update Global Config Section',
    opType: 'UPD',
    entityType: 'GLOBAL_CONFIG',
    entityId: sectionKey,
    payload: await encrypt(
      JSON.stringify({
        actionPayload: { sectionKey, sectionCfg },
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

export const setTasksConfig = (sync: FakeSync, sectionCfg: Row): Promise<void> =>
  setConfigSection(sync, 'tasks', sectionCfg);

export const startCore = async (
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
export const plain = async (op: SuperSyncOperation): Promise<Row> => ({
  ...op,
  payload: JSON.parse(await decrypt(op.payload as string, PASSWORD)) as Row,
});

/** The last upload's ops, decrypted. */
export const lastUpload = (sync: FakeSync): Promise<Row[]> =>
  Promise.all((sync.uploads.at(-1) ?? []).map(plain));

/** The app action an op carries. */
export const actionPayloadOf = (op: Row): Row => (op.payload as Row).actionPayload as Row;

export const tasksOf = (store: StateStore): Record<string, Row> =>
  (store.state.TASK ?? {}) as Record<string, Row>;
