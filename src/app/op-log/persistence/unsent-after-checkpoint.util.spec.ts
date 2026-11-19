import {
  ActionType,
  Operation,
  OperationLogEntry,
  OpType,
} from '../core/operation.types';
import { withUnsentEditsAfterCheckpoint } from './unsent-after-checkpoint.util';

describe('withUnsentEditsAfterCheckpoint (anex/checkpoints, Stage 6)', () => {
  const op = (id: string, overrides: Partial<Operation> = {}): Operation => ({
    id,
    actionType: 'test' as ActionType,
    opType: OpType.Update,
    entityType: 'TASK',
    entityId: 'task-1',
    payload: {},
    clientId: 'client-A',
    vectorClock: { clientA: 1 },
    timestamp: 1,
    schemaVersion: 1,
    ...overrides,
  });
  const entry = (
    seq: number,
    o: Operation,
    overrides: Partial<OperationLogEntry> = {},
  ): OperationLogEntry => ({ seq, op: o, appliedAt: seq, source: 'local', ...overrides });
  const checkpoint = (seq: number, base: number | undefined = 100): OperationLogEntry =>
    entry(
      seq,
      op(`cp-${seq}`, {
        opType: OpType.Repair,
        actionType: ActionType.LOAD_ALL_DATA,
        entityType: 'ALL',
        clientId: 'sp-bridge',
        repairBaseServerSeq: base,
      }),
      { source: 'remote', syncedAt: seq },
    );
  const ids = (entries: OperationLogEntry[]): string[] => entries.map((e) => e.op.id);

  it('replays unsent edits logged before the checkpoint after it', () => {
    const unsent = entry(1, op('unsent'));
    const synced = entry(2, op('synced'), { syncedAt: 2 });
    const after = entry(4, op('remote-after'), { source: 'remote', syncedAt: 4 });
    const entries = [unsent, synced, checkpoint(3), after];
    expect(ids(withUnsentEditsAfterCheckpoint(entries, [unsent]))).toEqual([
      'synced',
      'cp-3',
      'remote-after',
      'unsent',
    ]);
  });

  it('brings back unsent edits held by the snapshot the rebuild starts from', () => {
    // seq 1 is before the snapshot, so not in the replayed entries; the checkpoint in the tail would wipe it.
    const beforeSnapshot = entry(1, op('in-snapshot'));
    const entries = [checkpoint(5)];
    expect(ids(withUnsentEditsAfterCheckpoint(entries, [beforeSnapshot]))).toEqual([
      'cp-5',
      'in-snapshot',
    ]);
  });

  it('keeps log order for a full import or a REPAIR without its base', () => {
    const unsent = entry(1, op('unsent'));
    const legacy = checkpoint(2, undefined);
    expect(ids(withUnsentEditsAfterCheckpoint([unsent, legacy], [unsent]))).toEqual([
      'unsent',
      'cp-2',
    ]);
    const fullImport = entry(3, op('import', { opType: OpType.SyncImport }), {
      source: 'remote',
      syncedAt: 3,
    });
    expect(
      ids(withUnsentEditsAfterCheckpoint([unsent, checkpoint(2), fullImport], [unsent])),
    ).toEqual(['unsent', 'cp-2', 'import']);
  });

  it('leaves rejected and later edits where they are', () => {
    const rejected = entry(1, op('rejected'), { rejectedAt: 1 });
    const later = entry(3, op('later'));
    const entries = [rejected, checkpoint(2), later];
    expect(ids(withUnsentEditsAfterCheckpoint(entries, [later]))).toEqual([
      'rejected',
      'cp-2',
      'later',
    ]);
  });
});
