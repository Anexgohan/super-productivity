/**
 * When a board holds back its checkpoints (anex/checkpoints): after an archive failure, until the next full import or checkpoint.
 * A fake worker answers the applies; synthetic rows only.
 */
import { describe, expect, it } from 'vitest';
import type { SuperSyncServerOperation } from '@sp/shared-schema';
import type { AppRulesApplyResult } from '../src/app-rules-protocol';
import type { AppRulesWorker } from '../src/app-rules-worker';
import { AppRulesBoard } from '../src/app-rules-board';

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
