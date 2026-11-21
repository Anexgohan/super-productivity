import { describe, expect, it } from 'vitest';
import {
  editsNotInCheckpoint,
  findEditsAfterRemoteDelete,
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

describe('findEditsAfterRemoteDelete', () => {
  const task = (id: string, opType: OpType, entityId: string): Operation => ({
    ...op(id),
    opType,
    entityId,
  });

  it('finds unsent edits and accepted edits numbered after another browser deleted the task', () => {
    const edits = findEditsAfterRemoteDelete({
      downloaded: [{ op: task('d', OpType.Delete, 't1'), serverSeq: 10 }],
      own: [
        { op: task('before', OpType.Update, 't1'), serverSeq: 9 },
        { op: task('after', OpType.Update, 't1'), serverSeq: 11 },
        { op: task('unsent', OpType.Update, 't1') },
        { op: task('other', OpType.Update, 't2') },
      ],
      entityType: 'TASK',
    });
    expect([...edits.keys()]).toEqual(['t1']);
    expect(ids(edits.get('t1') ?? [])).toEqual(['after', 'unsent']);
  });

  it('counts tasks deleted together with another one', () => {
    const bulkDelete = {
      ...task('d', OpType.Delete, 'parent'),
      entityIds: ['parent', 'sub'],
    };
    const edits = findEditsAfterRemoteDelete({
      downloaded: [{ op: bulkDelete, serverSeq: 10 }],
      own: [{ op: task('u', OpType.Update, 'sub') }],
      entityType: 'TASK',
    });
    expect([...edits.keys()]).toEqual(['sub']);
  });

  it('ignores other item types and changes that are not edits', () => {
    const edits = findEditsAfterRemoteDelete({
      downloaded: [
        { op: { ...task('d', OpType.Delete, 'n1'), entityType: 'NOTE' }, serverSeq: 10 },
      ],
      own: [
        { op: { ...task('u', OpType.Update, 'n1'), entityType: 'NOTE' } },
        { op: task('c', OpType.Create, 'n1') },
      ],
      entityType: 'TASK',
    });
    expect(edits.size).toBe(0);
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
