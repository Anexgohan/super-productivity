/**
 * The bridge's app rules count today the way a browser does: from the clock and the synced start-of-next-day setting, set before each batch.
 * Runs the app's own rules from source, on synthetic data.
 */
import '@angular/compiler';
import '../app-rules/globals';
import { describe, expect, it } from 'vitest';
import type { Action } from '@ngrx/store';
import { buildRootReducer } from '../app-rules/root-reducer';
import { logicalDayChange } from '../app-rules/logical-day';
import { buildTaskEntity } from '../src/op-factory';
import { bulkApplyOperations } from '../../../src/app/op-log/apply/bulk-hydration.action';
import type { Operation } from '../../../src/app/op-log/core/operation.types';

type State = Record<string, unknown>;
const root = buildRootReducer() as (state: State | undefined, action: Action) => State;
const CLIENT = 'B_browser';
let seq = 0;

const op = (
  actionType: string,
  opType: string,
  entityType: string,
  entityId: string,
  actionPayload: Record<string, unknown>,
): Operation => {
  seq++;
  return {
    id: `op-${seq}`,
    clientId: CLIENT,
    actionType,
    opType,
    entityType,
    entityId,
    payload: { actionPayload, entityChanges: [] },
    vectorClock: { [CLIENT]: seq },
    timestamp: 1_900_000_000_000 + seq,
    schemaVersion: 4,
  } as unknown as Operation;
};

const startOfNextDayAt = (time: string): Operation =>
  op('[Global Config] Update Global Config Section', 'UPD', 'GLOBAL_CONFIG', 'misc', {
    sectionKey: 'misc',
    sectionCfg: { startOfNextDayTime: time },
  });

const addTaskDueOn = (id: string, dueDay: string): Operation =>
  op('[Task Shared] addTask', 'CRT', 'TASK', id, {
    task: { ...buildTaskEntity({ title: id, dueDay }), id },
    workContextId: 'INBOX_PROJECT',
    workContextType: 'PROJECT',
    isAddToBacklog: false,
    isAddToBottom: false,
  });

/** One batch as the bridge applies it: the logical day first, then the changes. */
const applyBatch = (state: State, ops: Operation[], now: Date): State => {
  const dayChange = logicalDayChange(state, now.getTime());
  const withDay = dayChange ? root(state, dayChange) : state;
  return root(
    withDay,
    bulkApplyOperations({ operations: ops, localClientId: 'sp-bridge' }),
  );
};

const appState = (state: State): { todayStr: string; startOfNextDayDiffMs: number } =>
  state.appState as { todayStr: string; startOfNextDayDiffMs: number };

const todayTaskIds = (state: State): string[] =>
  (state.tag as { entities: Record<string, { taskIds: string[] }> }).entities.TODAY
    .taskIds;

describe('app rules: the logical day', () => {
  it('moves on with the clock and the synced start of the next day, so a task due that day lands in Today', () => {
    let state = root(undefined, { type: '@ngrx/store/init' });

    state = applyBatch(state, [startOfNextDayAt('04:00')], new Date(2030, 2, 10, 12, 0));
    expect(appState(state).todayStr).toBe('2030-03-10');

    // 03:00 is still the previous day with the next day starting at 04:00.
    state = applyBatch(
      state,
      [addTaskDueOn('t-day-11', '2030-03-11')],
      new Date(2030, 2, 12, 3, 0),
    );
    expect(appState(state)).toEqual({
      todayStr: '2030-03-11',
      startOfNextDayDiffMs: 4 * 60 * 60 * 1000,
    });
    expect(todayTaskIds(state)).toContain('t-day-11');
  });
});
