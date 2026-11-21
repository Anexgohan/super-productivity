/**
 * When a board holds back its checkpoints (anex/checkpoints): after an archive failure, until the next full import or checkpoint.
 * A fake worker answers the applies; synthetic rows only.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { SuperSyncServerOperation } from '@sp/shared-schema';
import type { AppRulesApplyResult, AppRulesRequest } from '../src/app-rules-protocol';
import type { AppRulesWorker } from '../src/app-rules-worker';
import { AppRulesBoard } from '../src/app-rules-board';
import type { BridgeConfig } from '../src/config';
import { StateStore } from '../src/state-store';
import type { SyncClient } from '../src/sync-client';

let seq = 0;
const row = (op: Record<string, unknown>): SuperSyncServerOperation =>
  ({ serverSeq: ++seq, receivedAt: 0, op }) as unknown as SuperSyncServerOperation;
const change = (): SuperSyncServerOperation =>
  row({ id: `op-${seq + 1}`, opType: 'UPD' });
const checkpoint = (): SuperSyncServerOperation =>
  row({ id: `op-${seq + 1}`, opType: 'REPAIR', repairBaseServerSeq: seq });

const result = (extra: Partial<AppRulesApplyResult> = {}): AppRulesApplyResult => ({
  seq,
  applied: 1,
  filteredOpIds: [],
  filteredEntityIds: [],
  reducerFailures: [],
  sawArchiveOp: false,
  mergedClock: {},
  ...extra,
});

/** A board whose worker answers each apply with the next result given. */
const boardAnswering = (results: AppRulesApplyResult[]): AppRulesBoard => {
  const worker = {
    listen: () => () => undefined,
    request: async () => ({ kind: 'apply', result: results.shift() }),
  } as unknown as AppRulesWorker;
  return new AppRulesBoard(worker, {
    board: 'test',
    clientId: 'B_bridge',
    cachePath: '/nonexistent',
    encryptionPassword: 'unused',
  });
};

const archiveFailure = {
  opId: 'op-x',
  actionType: '[Task] Move to archive',
  error: 'boom',
};

describe('checkpoints: when a board holds them back', () => {
  it('does not hold them back for a reducer failure, which a browser skips the same way', async () => {
    const board = boardAnswering([
      result({ reducerFailures: [{ opId: 'op-x', actionType: '[Task] Update' }] }),
    ]);
    await board.apply([change()]);
    expect(board.status.reducerFailures).toBe(1);
    expect(board.status.checkpointHeldBack).toBeNull();
  });

  it('holds them back after an archive failure until a full import or checkpoint replaces the archive', async () => {
    const board = boardAnswering([
      result({ archiveFailure }),
      result(),
      result({ archiveFailure }),
      result(),
    ]);

    await board.apply([change()]);
    expect(board.status.checkpointHeldBack).toBe(
      'archive handling failed on op op-x ([Task] Move to archive)',
    );
    await board.apply([change()]);
    expect(board.status.checkpointHeldBack).not.toBeNull();

    // A page with both keeps the hold, on the safe side: the failure may come after the checkpoint.
    await board.apply([checkpoint(), change()]);
    expect(board.status.checkpointHeldBack).not.toBeNull();

    await board.apply([change(), checkpoint()]);
    expect(board.status.checkpointHeldBack).toBeNull();
    expect(board.status.archiveFailures).toBe(2);
  });
});

const dirs: string[] = [];
afterEach(() => {
  vi.unstubAllGlobals();
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

/** A whole op as the server sends it, so the bridge's own download parsing accepts it. */
const serverRow = (
  serverSeq: number,
  extra: Record<string, unknown> = {},
): SuperSyncServerOperation =>
  ({
    serverSeq,
    receivedAt: 0,
    op: {
      id: `op-${serverSeq}`,
      clientId: 'browser',
      actionType: '[Task] Update',
      opType: 'UPD',
      entityType: 'TASK',
      payload: {},
      vectorClock: { browser: serverSeq },
      timestamp: 0,
      schemaVersion: 4,
      ...extra,
    },
  }) as unknown as SuperSyncServerOperation;

/** Serves `rows` as the sync server's op log. */
const serveOps = (rows: SuperSyncServerOperation[]): void => {
  vi.stubGlobal('fetch', async (url: string) => {
    const since = Number(new URL(url).searchParams.get('sinceSeq'));
    const ops = rows.filter((r) => r.serverSeq > since);
    const body = { ops, hasMore: false, latestSeq: rows.length };
    return new Response(JSON.stringify(body), { status: 200 });
  });
};

/** A worker that starts at `startSeq`, fails archive handling on the ops named, and records each request kind. */
const fakeWorker = (
  startSeq: number,
  failArchiveOn: string[] = [],
): { worker: AppRulesWorker; kinds: string[] } => {
  const kinds: string[] = [];
  let at = startSeq;
  const worker = {
    listen: () => () => undefined,
    exclusive: <T>(task: () => Promise<T>) => task(),
    request: async (req: AppRulesRequest) => {
      kinds.push(req.kind);
      if (req.kind === 'init')
        return { kind: 'init', seq: at, sawArchiveOp: false, mergedClock: {} };
      if (req.kind === 'snapshot')
        return { kind: 'snapshot', snapshot: { seq: at, appData: {}, heapUsedMb: 0 } };
      if (req.kind === 'apply') {
        at = req.rows[req.rows.length - 1].serverSeq;
        const failed = req.rows.find((r) => failArchiveOn.includes(r.op.id as string));
        return {
          kind: 'apply',
          result: result({
            seq: at,
            ...(failed
              ? { archiveFailure: { ...archiveFailure, opId: failed.op.id as string } }
              : {}),
          }),
        };
      }
      throw new Error(`unexpected ${req.kind}`);
    },
  } as unknown as AppRulesWorker;
  return { worker, kinds };
};

/** One bridge start on `dataDir`: the store opens its board and syncs once. */
const startStore = async (
  dataDir: string,
  worker: AppRulesWorker,
): Promise<StateStore> => {
  const cfg = {
    syncServerUrl: 'http://sync.test',
    encryptionPassword: 'unused',
    clientId: 'B_bridge',
    dataDir,
  } as BridgeConfig;
  const store = new StateStore(cfg, worker, { mintToken: async () => 'token' });
  await (store as unknown as { _board: AppRulesBoard })._board.open();
  await (store as unknown as { _client: SyncClient })._client.authenticate();
  await store.refresh();
  return store;
};

describe('checkpoints: the hold across a restart', () => {
  it('keeps the hold through a restart until a checkpoint replaces the archive', async () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'checkpoint-hold-'));
    dirs.push(dataDir);
    const rows = [serverRow(1)];
    serveOps(rows);
    const first = await startStore(dataDir, fakeWorker(0, ['op-1']).worker);
    expect(first.appRulesStatus.checkpointHeldBack).toBe(
      'archive handling failed on op op-1 ([Task] Move to archive)',
    );
    first.stop();

    // The restarted bridge has nothing new to apply and is due for its first checkpoint, but still may not write one.
    const restarted = fakeWorker(1);
    const second = await startStore(dataDir, restarted.worker);
    expect(second.appRulesStatus).toMatchObject({
      state: 'ready',
      checkpointHeldBack: 'archive handling failed on op op-1 ([Task] Move to archive)',
    });
    expect(restarted.kinds).not.toContain('checkpoint');
    second.stop();

    rows.push(
      serverRow(2, { opType: 'REPAIR', entityType: 'ALL', repairBaseServerSeq: 1 }),
    );
    const third = await startStore(dataDir, fakeWorker(1).worker);
    expect(third.appRulesStatus.checkpointHeldBack).toBeNull();
    third.stop();
    const fourth = new StateStore(
      { dataDir, encryptionPassword: 'unused', clientId: 'B_bridge' } as BridgeConfig,
      fakeWorker(2).worker,
    );
    expect(fourth.appRulesStatus.checkpointHeldBack).toBeNull();
    expect(fourth.checkpointStatus.heldBack).toBeNull();
  });
});
