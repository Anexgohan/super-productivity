import { describe, expect, it } from 'vitest';
import {
  isUnsentEditOnTopConflict,
  isUnsentEditOverRemoteDelete,
  joinUnsentEditOnTopConflicts,
  OpType,
  unsentEditOnTopChanges,
  unsentEditOnTopFields,
  wholeItemCopyFields,
} from '../src';
import type { EntityConflict, Operation, UnsentEditOnTopRules } from '../src';

const UPDATE_TASK = '[Task Shared] updateTask';
const TASK_COPY = '[TASK] LWW Update';

const copy = (id: string, fields: Record<string, unknown>, extra = {}): Operation =>
  op(id, {
    actionType: TASK_COPY,
    payload: {
      actionPayload: { id: 'task-1', ...fields },
      entityChanges: [],
      lwwUpdateMode: 'replace',
      ...extra,
    },
  });

const op = (id: string, overrides: Partial<Operation> = {}): Operation => ({
  id,
  actionType: UPDATE_TASK,
  opType: OpType.Update,
  entityType: 'TASK',
  entityId: 'task-1',
  payload: {},
  clientId: 'client-a',
  vectorClock: { a: 1 },
  timestamp: 1_000,
  schemaVersion: 1,
  ...overrides,
});

const conflict = (
  localOps: Operation[],
  remoteOps: Operation[],
  entityId = 'task-1',
): EntityConflict => ({
  entityType: 'TASK',
  entityId,
  localOps,
  remoteOps,
  suggestedResolution: 'manual',
});

const rules = (
  unsent: string[],
  overrides: Partial<UnsentEditOnTopRules<Operation>> = {},
): UnsentEditOnTopRules<Operation> => ({
  setValueActionTypes: new Set([UPDATE_TASK]),
  downloadedCopyActionTypes: new Set([TASK_COPY]),
  unsentOpIds: new Set(unsent),
  isMultiEntity: () => false,
  ...overrides,
});

describe('isUnsentEditOnTopConflict', () => {
  it('takes unsent set-value edits against downloaded set-value edits', () => {
    expect(
      isUnsentEditOnTopConflict(
        conflict([op('local')], [op('remote')]),
        rules(['local']),
      ),
    ).toBe(true);
  });

  it('refuses a local side the server already has, so two devices cannot each keep their own', () => {
    expect(
      isUnsentEditOnTopConflict(conflict([op('local')], [op('remote')]), rules([])),
    ).toBe(false);
  });

  it('refuses when only part of the local side is unsent', () => {
    expect(
      isUnsentEditOnTopConflict(
        conflict([op('sent'), op('unsent')], [op('remote')]),
        rules(['unsent']),
      ),
    ).toBe(false);
  });

  it('refuses edits that add, such as tracked time, on either side', () => {
    const syncTime = { actionType: '[TimeTracking] Sync time spent' };
    expect(
      isUnsentEditOnTopConflict(
        conflict([op('local', syncTime)], [op('remote')]),
        rules(['local']),
      ),
    ).toBe(false);
    expect(
      isUnsentEditOnTopConflict(
        conflict([op('local')], [op('remote', syncTime)]),
        rules(['local']),
      ),
    ).toBe(false);
  });

  it('refuses a downloaded delete and edits that change several items', () => {
    expect(
      isUnsentEditOnTopConflict(
        conflict([op('local')], [op('remote', { opType: OpType.Delete })]),
        rules(['local']),
      ),
    ).toBe(false);
    expect(
      isUnsentEditOnTopConflict(
        conflict([op('local')], [op('remote')]),
        rules(['local'], { isMultiEntity: (o) => o.id === 'remote' }),
      ),
    ).toBe(false);
  });

  it('refuses an empty side', () => {
    expect(isUnsentEditOnTopConflict(conflict([], [op('remote')]), rules([]))).toBe(
      false,
    );
    expect(isUnsentEditOnTopConflict(conflict([op('local')], []), rules(['local']))).toBe(
      false,
    );
  });
});

describe('isUnsentEditOnTopConflict with whole-item copies', () => {
  it('takes a whole-item copy another browser made, on the downloaded side', () => {
    expect(
      isUnsentEditOnTopConflict(
        conflict([op('local')], [copy('remote', { title: 'b' })]),
        rules(['local']),
      ),
    ).toBe(true);
  });

  it('refuses an unsent copy, whose snapshot would override the downloaded fields', () => {
    expect(
      isUnsentEditOnTopConflict(
        conflict([copy('local', { title: 'a' })], [op('remote')]),
        rules(['local']),
      ),
    ).toBe(false);
  });

  it('refuses copies that bring an item back or move it to another project', () => {
    for (const extra of [
      { recreatesEntityAfterDelete: true },
      { projectMoveFootprint: ['task-1'] },
    ]) {
      expect(
        isUnsentEditOnTopConflict(
          conflict([op('local')], [copy('remote', { title: 'b' }, extra)]),
          rules(['local']),
        ),
      ).toBe(false);
    }
  });

  it('refuses a copy type the host did not list, or one without the copy payload', () => {
    expect(
      isUnsentEditOnTopConflict(
        conflict([op('local')], [copy('remote', { title: 'b' })]),
        rules(['local'], { downloadedCopyActionTypes: new Set() }),
      ),
    ).toBe(false);
    expect(
      isUnsentEditOnTopConflict(
        conflict([op('local')], [op('remote', { actionType: TASK_COPY })]),
        rules(['local']),
      ),
    ).toBe(false);
  });
});

describe('wholeItemCopyFields and unsentEditOnTopFields', () => {
  it('reads every field a copy sets, without its id', () => {
    expect(
      wholeItemCopyFields(copy('remote', { title: 'b', isDone: true }), 'task-1'),
    ).toEqual({
      title: 'b',
      isDone: true,
    });
  });

  it('leaves other edits and copies of another item to the host reader', () => {
    expect(
      wholeItemCopyFields(
        op('remote', { payload: { task: { id: 'task-1' } } }),
        'task-1',
      ),
    ).toBe(undefined);
    expect(wholeItemCopyFields(copy('remote', { title: 'b' }), 'task-2')).toBe(undefined);
  });

  it('joins copies and plain edits in order, and marks a side with an unreadable op opaque', () => {
    const readEdit = (o: Operation): Record<string, unknown> =>
      o.id === 'plain' ? { title: 'plain title' } : {};
    expect(
      unsentEditOnTopFields(
        [copy('copy', { title: 'copy title', isDone: true }), op('plain')],
        'task-1',
        readEdit,
      ),
    ).toEqual({ fields: { title: 'plain title', isDone: true }, isOpaque: false });
    expect(
      unsentEditOnTopFields([op('plain'), op('other')], 'task-1', readEdit).isOpaque,
    ).toBe(true);
  });
});

describe('isUnsentEditOverRemoteDelete', () => {
  it('takes an unsent set-value edit against a downloaded delete', () => {
    expect(
      isUnsentEditOverRemoteDelete(
        conflict([op('local')], [op('remote', { opType: OpType.Delete })]),
        rules(['local']),
      ),
    ).toBe(true);
  });

  it('refuses when the edit was already sent, when it is not a set-value edit, or with no delete', () => {
    const remoteDelete = op('remote', { opType: OpType.Delete });
    expect(
      isUnsentEditOverRemoteDelete(conflict([op('local')], [remoteDelete]), rules([])),
    ).toBe(false);
    expect(
      isUnsentEditOverRemoteDelete(
        conflict([op('local', { actionType: '[Task] Move' })], [remoteDelete]),
        rules(['local']),
      ),
    ).toBe(false);
    expect(
      isUnsentEditOverRemoteDelete(
        conflict([op('local')], [op('remote')]),
        rules(['local']),
      ),
    ).toBe(false);
  });
});

describe('unsentEditOnTopChanges', () => {
  it('keeps the downloaded fields and puts the unsent edit over the shared ones', () => {
    expect(
      unsentEditOnTopChanges(
        { title: 'local title', notes: 'local notes' },
        { title: 'remote title', isDone: true },
      ),
    ).toEqual({ title: 'local title', notes: 'local notes', isDone: true });
  });
});

describe('joinUnsentEditOnTopConflicts', () => {
  const qualifies = (c: EntityConflict): boolean => c.entityId !== 'other';

  it('joins the qualifying conflicts of one item, downloaded edits in order', () => {
    const local = op('local');
    const joined = joinUnsentEditOnTopConflicts(
      [conflict([local], [op('remote-1')]), conflict([local], [op('remote-2')])],
      qualifies,
    );

    expect(joined.length).toBe(1);
    expect(joined[0].localOps.map((o) => o.id)).toEqual(['local']);
    expect(joined[0].remoteOps.map((o) => o.id)).toEqual(['remote-1', 'remote-2']);
  });

  it('leaves other conflicts unchanged and in their place', () => {
    const first = conflict([op('l1')], [op('r1')], 'task-1');
    const other1 = conflict([op('l2')], [op('r2')], 'other');
    const other2 = conflict([op('l2')], [op('r3')], 'other');
    const second = conflict([op('l1')], [op('r4')], 'task-1');
    const third = conflict([op('l5')], [op('r5')], 'task-2');

    const joined = joinUnsentEditOnTopConflicts(
      [first, other1, other2, second, third],
      qualifies,
    );

    expect(joined.map((c) => c.entityId)).toEqual(['task-1', 'other', 'other', 'task-2']);
    expect(joined[0].remoteOps.map((o) => o.id)).toEqual(['r1', 'r4']);
    expect(joined[1]).toBe(other1);
    expect(joined[2]).toBe(other2);
    expect(joined[3]).toBe(third);
  });
});
