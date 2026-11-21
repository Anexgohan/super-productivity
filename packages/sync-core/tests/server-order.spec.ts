import { describe, expect, it } from 'vitest';
import {
  deleteTimesWithParents,
  editBeatsDelete,
  editsNotInCheckpoint,
  findEditsThatBeatDeletes,
  findRecreationsBeatenByDeletes,
  findUnaccountedServerSeq,
  OpType,
  planServerOrderApply,
} from '../src';
import type { Operation, ServerOrderedOp } from '../src';

const op = (id: string): Operation => ({
  id,
  actionType: '[Task Shared] updateTask',
  opType: OpType.Update,
  entityType: 'TASK',
  entityId: 'task-1',
  payload: {},
  clientId: 'client',
  vectorClock: {},
  timestamp: 1,
  schemaVersion: 1,
});

const at = (id: string, serverSeq: number): ServerOrderedOp => ({
  op: op(id),
  serverSeq,
});
const ids = (ops: Operation[]): string[] => ops.map((o) => o.id);

describe('planServerOrderApply', () => {
  it('applies as today when nothing of this browser waits', () => {
    expect(
      planServerOrderApply({
        downloaded: [at('b1', 11), at('b2', 12)],
        accepted: [],
        unsent: [],
        hasConfirmedState: true,
      }),
    ).toEqual({ kind: 'in-order', confirmedSeq: 12 });
  });

  it('applies as today when every accepted change came before the download, even without a confirmed state', () => {
    expect(
      planServerOrderApply({
        downloaded: [at('b1', 11)],
        accepted: [at('a1', 9), at('a2', 10)],
        unsent: [],
        hasConfirmedState: false,
      }),
    ).toEqual({ kind: 'in-order', confirmedSeq: 11 });
  });

  it('replays when an accepted change was stored after a downloaded one', () => {
    const plan = planServerOrderApply({
      downloaded: [at('b1', 10), at('b2', 12)],
      accepted: [at('a1', 11)],
      unsent: [],
      hasConfirmedState: true,
    });
    expect(plan.kind).toBe('replay');
    if (plan.kind !== 'replay') return;
    expect(ids(plan.ordered)).toEqual(['b1', 'a1', 'b2']);
    expect(plan.onTop).toEqual([]);
    expect(plan.confirmedSeq).toBe(12);
    expect(plan.placedOpIds).toEqual(['a1']);
  });

  it('puts unsent changes on top of the replay', () => {
    const plan = planServerOrderApply({
      downloaded: [at('b1', 10)],
      accepted: [],
      unsent: [op('u1'), op('u2')],
      hasConfirmedState: true,
    });
    expect(plan.kind).toBe('replay');
    if (plan.kind !== 'replay') return;
    expect(ids(plan.ordered)).toEqual(['b1']);
    expect(ids(plan.onTop)).toEqual(['u1', 'u2']);
    expect(plan.placedOpIds).toEqual([]);
  });

  it('keeps accepted changes numbered after the download on top, before the unsent ones', () => {
    const plan = planServerOrderApply({
      downloaded: [at('b1', 10)],
      accepted: [at('a2', 13), at('a1', 9), at('a3', 11)],
      unsent: [op('u1')],
      hasConfirmedState: true,
    });
    expect(plan.kind).toBe('replay');
    if (plan.kind !== 'replay') return;
    expect(ids(plan.ordered)).toEqual(['a1', 'b1']);
    expect(ids(plan.onTop)).toEqual(['a3', 'a2', 'u1']);
    expect(plan.confirmedSeq).toBe(10);
    expect(plan.placedOpIds).toEqual(['a1']);
  });

  it('sorts a download that arrived out of order', () => {
    const plan = planServerOrderApply({
      downloaded: [at('b2', 14), at('b1', 12)],
      accepted: [at('a1', 13)],
      unsent: [],
      hasConfirmedState: true,
    });
    expect(plan.kind === 'replay' && ids(plan.ordered)).toEqual(['b1', 'a1', 'b2']);
  });

  it('asks for a rebuild when the order matters and the confirmed state is unknown', () => {
    expect(
      planServerOrderApply({
        downloaded: [at('b1', 10)],
        accepted: [],
        unsent: [op('u1')],
        hasConfirmedState: false,
      }),
    ).toEqual({ kind: 'rebuild' });
    expect(
      planServerOrderApply({
        downloaded: [at('b1', 10)],
        accepted: [at('a1', 11)],
        unsent: [],
        hasConfirmedState: false,
      }),
    ).toEqual({ kind: 'rebuild' });
  });

  it('does not apply as today when the server holds a save of this browser numbered after the download, as after a reload', () => {
    const afterReload = {
      downloaded: [at('b1', 10), at('b2', 12)],
      accepted: [],
      unsent: [],
      hasConfirmedState: false,
    };
    expect(planServerOrderApply({ ...afterReload, ownLatestSeq: 11 })).toEqual({
      kind: 'rebuild',
    });
    expect(planServerOrderApply({ ...afterReload, ownLatestSeq: 9 })).toEqual({
      kind: 'in-order',
      confirmedSeq: 12,
    });
  });

  it('asks for a rebuild when two changes share a number or a number is not valid', () => {
    const base = { unsent: [], hasConfirmedState: true };
    expect(
      planServerOrderApply({
        ...base,
        downloaded: [at('b1', 10)],
        accepted: [at('a1', 10)],
      }),
    ).toEqual({ kind: 'rebuild' });
    expect(
      planServerOrderApply({ ...base, downloaded: [at('b1', 0)], accepted: [] }),
    ).toEqual({ kind: 'rebuild' });
    expect(
      planServerOrderApply({ ...base, downloaded: [at('b1', 1.5)], accepted: [] }),
    ).toEqual({ kind: 'rebuild' });
  });

  it('refuses an empty download', () => {
    expect(() =>
      planServerOrderApply({
        downloaded: [],
        accepted: [],
        unsent: [],
        hasConfirmedState: true,
      }),
    ).toThrow();
  });
});

describe('findUnaccountedServerSeq', () => {
  it('finds nothing missing when every number is downloaded or known', () => {
    expect(
      findUnaccountedServerSeq({
        confirmedSeq: 9,
        downloadedSeqs: [10, 12],
        knownSeqs: [11],
      }),
    ).toBeUndefined();
  });

  it('names the first number nobody accounts for', () => {
    expect(
      findUnaccountedServerSeq({
        confirmedSeq: 9,
        downloadedSeqs: [10, 13],
        knownSeqs: [11],
      }),
    ).toBe(12);
  });

  it('refuses a download at or before the confirmed state', () => {
    expect(
      findUnaccountedServerSeq({
        confirmedSeq: 10,
        downloadedSeqs: [10, 11],
        knownSeqs: [],
      }),
    ).toBe(10);
  });
});

describe('editBeatsDelete', () => {
  it('lets only a later edit win; a tie keeps the delete', () => {
    expect(editBeatsDelete(11, 10)).toBe(true);
    expect(editBeatsDelete(10, 10)).toBe(false);
    expect(editBeatsDelete(9, 10)).toBe(false);
  });
});

describe('findEditsThatBeatDeletes', () => {
  const change = (
    id: string,
    opType: OpType,
    entityId: string,
    timestamp: number,
    extra: Partial<Operation> = {},
  ): Operation => ({ ...op(id), opType, entityId, timestamp, ...extra });
  const deleted = (
    entityId: string,
    deletedAt: number,
    entityType = 'TASK',
  ): { entityType: string; entityId: string; deletedAt: number } => ({
    entityType,
    entityId,
    deletedAt,
  });

  it('picks an item whose latest own edit is later than its delete, by device time', () => {
    expect(
      findEditsThatBeatDeletes({
        deletes: [deleted('t1', 100), deleted('t2', 100), deleted('t3', 100)],
        own: [
          change('a', OpType.Update, 't1', 90),
          change('b', OpType.Update, 't1', 120),
          change('c', OpType.Update, 't2', 90),
          change('d', OpType.Update, 't3', 100),
        ],
      }),
    ).toEqual([{ entityType: 'TASK', entityId: 't1', editAt: 120 }]);
  });

  it('compares against the latest delete of an item', () => {
    expect(
      findEditsThatBeatDeletes({
        deletes: [deleted('t1', 100), deleted('t1', 150)],
        own: [change('a', OpType.Update, 't1', 120)],
      }),
    ).toEqual([]);
  });

  it("keeps an item deleted when this browser's own last change to it is a delete", () => {
    expect(
      findEditsThatBeatDeletes({
        deletes: [deleted('t1', 100)],
        own: [
          change('a', OpType.Update, 't1', 120),
          change('b', OpType.Delete, 't1', 130),
        ],
      }),
    ).toEqual([]);
  });

  it('counts notes, and only updates', () => {
    expect(
      findEditsThatBeatDeletes({
        deletes: [deleted('n1', 100, 'NOTE'), deleted('t1', 100), deleted('t2', 100)],
        own: [
          change('a', OpType.Update, 'n1', 120, { entityType: 'NOTE' }),
          change('b', OpType.Create, 't1', 120),
          change('c', OpType.Move, 't2', 120),
        ],
      }),
    ).toEqual([{ entityType: 'NOTE', entityId: 'n1', editAt: 120 }]);
  });

  it('counts an update for every item it names, as a project move with subtasks or a bulk edit names them', () => {
    expect(
      findEditsThatBeatDeletes({
        deletes: [deleted('parent', 100), deleted('sub', 100), deleted('b1', 100)],
        own: [
          change('move', OpType.Update, 'parent', 120, { entityIds: ['parent', 'sub'] }),
          { ...op('bulk'), entityId: undefined, timestamp: 130, entityIds: ['b1', 'b2'] },
        ],
      }),
    ).toEqual([
      { entityType: 'TASK', entityId: 'parent', editAt: 120 },
      { entityType: 'TASK', entityId: 'sub', editAt: 120 },
      { entityType: 'TASK', entityId: 'b1', editAt: 130 },
    ]);
  });
});

describe('findRecreationsBeatenByDeletes', () => {
  it('withdraws an unsent recreation that is not later than the delete', () => {
    const recreation = (id: string, timestamp: number): Operation => ({
      ...op(id),
      entityId: 't1',
      timestamp,
      actionType: '[TASK] LWW Update',
    });
    const beaten = findRecreationsBeatenByDeletes({
      deletes: [{ entityType: 'TASK', entityId: 't1', deletedAt: 100 }],
      unsent: [recreation('early', 90), recreation('late', 110), op('plain')],
      recreatesItem: (o) => o.actionType === '[TASK] LWW Update',
    });
    expect(ids(beaten)).toEqual(['early']);
  });
});

describe('deleteTimesWithParents', () => {
  it("uses a subtask's own record, else its parent's", () => {
    expect(
      deleteTimesWithParents(
        [
          { entityType: 'TASK', entityId: 'sub', parentId: 'parent' },
          { entityType: 'TASK', entityId: 'own', parentId: 'parent' },
          { entityType: 'TASK', entityId: 'none' },
          { entityType: 'NOTE', entityId: 'n1' },
        ],
        [
          { entityType: 'TASK', entityId: 'parent', deletedAt: 100 },
          { entityType: 'TASK', entityId: 'own', deletedAt: 200 },
          { entityType: 'NOTE', entityId: 'n1', deletedAt: 300 },
        ],
      ),
    ).toEqual([
      { entityType: 'TASK', entityId: 'sub', deletedAt: 100 },
      { entityType: 'TASK', entityId: 'own', deletedAt: 200 },
      { entityType: 'NOTE', entityId: 'n1', deletedAt: 300 },
    ]);
  });

  it("takes a parent's delete when it is later than the subtask's own record", () => {
    expect(
      deleteTimesWithParents(
        [{ entityType: 'TASK', entityId: 'sub', parentId: 'parent' }],
        [
          { entityType: 'TASK', entityId: 'sub', deletedAt: 10 },
          { entityType: 'TASK', entityId: 'parent', deletedAt: 30 },
        ],
      ),
    ).toEqual([{ entityType: 'TASK', entityId: 'sub', deletedAt: 30 }]);
  });
});

describe('editsNotInCheckpoint', () => {
  const seqs = new Map([
    ['in-checkpoint', 40],
    ['at-base', 50],
    ['after-base', 51],
  ]);
  const keep = (checkpointBaseSeq: number): string[] =>
    ids(
      editsNotInCheckpoint({
        unsent: [op('in-checkpoint'), op('at-base'), op('after-base'), op('not-placed')],
        checkpointBaseSeq,
        ownServerSeq: (id) => seqs.get(id),
      }),
    );

  it('leaves out the saves the checkpoint holds already, so they are not applied twice', () => {
    expect(keep(50)).toEqual(['after-base', 'not-placed']);
  });

  it('keeps every save numbered after the checkpoint and every save without a number', () => {
    expect(keep(39)).toEqual(['in-checkpoint', 'at-base', 'after-base', 'not-placed']);
  });
});
