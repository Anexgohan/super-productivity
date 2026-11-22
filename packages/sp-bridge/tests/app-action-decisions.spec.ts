/**
 * Every action the app saves has a decision for the API (anex/app-actions): offered as an app action, written by a legacy route, planned
 * for a later stage, or not offered, with the reason. An action the app adds fails here until someone decides.
 */
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { ActionType } from '../../../src/app/op-log/core/action-types.enum';
import type { ActionName } from '../src/action-inputs';

/** The app action each API action builds first. */
const OFFERED: Record<ActionName, ActionType> = {
  deleteTasks: ActionType.TASK_SHARED_DELETE_MULTIPLE,
  deleteTask: ActionType.TASK_SHARED_DELETE,
  updateTask: ActionType.TASK_SHARED_UPDATE,
  addTaskRepeatCfgToTask: ActionType.REPEAT_CFG_ADD,
};

/** Per-action routes for the card's later stages. */
const LATER: Record<string, (keyof typeof ActionType)[]> = {
  'archive and restore': [
    'TASK_SHARED_MOVE_TO_ARCHIVE',
    'TASK_SHARED_RESTORE',
    'TASK_SHARED_RESTORE_DELETED',
    'ARCHIVE_COMPRESS',
    'ARCHIVE_FLUSH_YOUNG_TO_OLD',
  ],
  settings: ['GLOBAL_CONFIG_UPDATE_SECTION'],
  'time tracking': [
    'TIME_TRACKING_SYNC_TIME_SPENT',
    'TIME_TRACKING_SYNC_SESSIONS',
    'TIME_TRACKING_UPDATE_CONTEXT_DATA',
    'TASK_REMOVE_TIME_SPENT',
    'TASK_ROUND_TIME_SPENT',
  ],
  scheduling: [
    'TASK_SHARED_SCHEDULE_WITH_TIME',
    'TASK_SHARED_RESCHEDULE_WITH_TIME',
    'TASK_SHARED_UNSCHEDULE',
    'TASK_SHARED_DISMISS_REMINDER',
    'TASK_SHARED_SET_DEADLINE',
    'TASK_SHARED_REMOVE_DEADLINE',
    'TASK_SHARED_PLAN_DEADLINE_FOR_TODAY',
    'TASK_SHARED_CLEAR_DEADLINE_REMINDER',
    'PLANNER_UPSERT_DAY',
    'PLANNER_TRANSFER_TASK',
    'PLANNER_MOVE_IN_LIST',
    'PLANNER_MOVE_BEFORE_TASK',
    'PLANNER_PLAN_TASK_FOR_DAY',
  ],
  'projects, ordering, sidebar and sections': [
    'PROJECT_UPDATE_ORDER',
    'PROJECT_UPDATE_ADVANCED_CFG',
    'PROJECT_ARCHIVE',
    'PROJECT_UNARCHIVE',
    'PROJECT_COMPLETE',
    'PROJECT_REOPEN',
    'PROJECT_TOGGLE_HIDE',
    'PROJECT_MOVE_TASK_IN_BACKLOG',
    'PROJECT_MOVE_TASK_UP_BACKLOG',
    'PROJECT_MOVE_TASK_DOWN_BACKLOG',
    'PROJECT_MOVE_TASK_TOP_BACKLOG',
    'PROJECT_MOVE_TASK_BOTTOM_BACKLOG',
    'PROJECT_MOVE_TO_BACKLOG',
    'PROJECT_MOVE_FROM_BACKLOG',
    'PROJECT_AUTO_MOVE_TO_BACKLOG',
    'PROJECT_AUTO_MOVE_FROM_BACKLOG',
    'PROJECT_MOVE_ALL_BACKLOG',
    'WORK_CONTEXT_MOVE_UP',
    'WORK_CONTEXT_MOVE_DOWN',
    'WORK_CONTEXT_MOVE_TOP',
    'WORK_CONTEXT_MOVE_BOTTOM',
    'WORK_CONTEXT_MOVE',
    'TASK_SHARED_MOVE_IN_TODAY',
    'TASK_MOVE_SUB',
    'TASK_MOVE_UP',
    'TASK_MOVE_DOWN',
    'TASK_MOVE_TOP',
    'TASK_MOVE_BOTTOM',
    'MENU_TREE_UPDATE_PROJECT',
    'MENU_TREE_UPDATE_TAG',
    'MENU_TREE_UPDATE_FOLDER',
    'MENU_TREE_DELETE_FOLDER',
    'SECTION_ADD',
    'SECTION_DELETE',
    'SECTION_UPDATE',
    'SECTION_UPDATE_ORDER',
    'SECTION_ADD_TASK',
    'SECTION_REMOVE_TASK',
  ],
  'counters and metrics': [
    'COUNTER_ADD',
    'COUNTER_UPDATE',
    'COUNTER_DELETE',
    'COUNTER_DELETE_MULTIPLE',
    'COUNTER_UPDATE_ALL',
    'COUNTER_SET_TODAY',
    'COUNTER_SYNC_TIME',
    'COUNTER_UPDATE_ORDER',
    'COUNTER_SET_FOR_DATE',
    'METRIC_ADD',
    'METRIC_DELETE',
    'METRIC_UPDATE',
    'METRIC_UPSERT',
    'METRIC_LOG_FOCUS_SESSION',
  ],
  'smaller gaps': [
    'TASK_SHARED_UPDATE_MULTIPLE',
    'TASK_SHARED_ADD_TAG',
    'TASK_SHARED_REMOVE_TAGS_ALL',
    'TASK_SHARED_BATCH_UPDATE_PROJECT',
    'TASK_SHARED_DELETE_ISSUE_PROVIDER',
    'TASK_SHARED_DELETE_ISSUE_PROVIDERS',
    'TASK_SHARED_DELETE_REPEAT_CFG',
    'TASK_SHARED_APPLY_SHORT_SYNTAX',
    'TASK_UPDATE_UI',
    'TASK_UPDATE_MULTIPLE_SIMPLE',
    'ATTACHMENT_UPDATE',
    'ATTACHMENT_DELETE',
    'ISSUE_PROVIDER_ADD',
    'ISSUE_PROVIDER_UPDATE',
    'ISSUE_PROVIDER_SORT_FIRST',
    'REPEAT_CFG_UPDATE_MULTIPLE',
    'REPEAT_CFG_DELETE_MULTIPLE',
    'REPEAT_CFG_DELETE_INSTANCE',
    'NOTE_UPDATE_ORDER',
    'NOTE_MOVE_TO_PROJECT',
    'TAG_DELETE_MULTIPLE',
    'TAG_UPDATE_ORDER',
    'TAG_UPDATE_ADVANCED_CONFIG',
    'PLUGIN_UPSERT_USER_DATA',
    'PLUGIN_DELETE_USER_DATA',
    'PLUGIN_UPSERT_METADATA',
    'PLUGIN_DELETE_METADATA',
  ],
};

/** Actions the API never offers, by reason. */
const NOT_OFFERED: Record<string, (keyof typeof ActionType)[]> = {
  'never saved, so never synced: device-local, or an effect saves it through other actions':
    [
      'COUNTER_UPSERT',
      'COUNTER_INCREASE_TODAY',
      'COUNTER_DECREASE_TODAY',
      'COUNTER_TOGGLE',
      'COUNTER_TURN_OFF_ALL',
      'COUNTER_SET_OFF',
      'COUNTER_SET_ON',
      'REPEAT_CFG_UPSERT',
      'TASK_ADD_TAGS_SHORT_SYNTAX',
    ],
  'an internal notice, not a change': ['ARCHIVE_REMOTE_DATA_APPLIED'],
  'never dispatched by the app': ['BOARDS_UPDATE_PANEL_CFG', 'LOAD_BACKUP_DATA'],
  "a browser's own storage migration or recovery": [
    'MIGRATION_GENESIS_IMPORT',
    'RECOVERY_DATA_IMPORT',
  ],
  'whole-board: the import route and checkpoints write these': [
    'LOAD_ALL_DATA',
    'REPAIR_AUTO',
  ],
};

/** Every action type the legacy routes write by hand, read from their source. */
const legacyWrites = (): Set<string> => {
  const dir = join(__dirname, '../src');
  const found = new Set<string>();
  for (const file of readdirSync(dir).filter((f) => f.endsWith('.ts'))) {
    for (const m of readFileSync(join(dir, file), 'utf-8').matchAll(
      /actionType: '([^']+)'/g,
    )) {
      found.add(m[1]);
    }
  }
  return found;
};

describe('app action decisions', () => {
  it('gives every action the app saves exactly one decision', () => {
    const legacy = legacyWrites();
    const offered = new Set<string>(Object.values(OFFERED));
    const listed = [...Object.values(LATER), ...Object.values(NOT_OFFERED)]
      .flat()
      .map((key) => ActionType[key]);

    // A listed action that is offered or written now has its decision already: it must leave its list.
    expect(listed.filter((t) => offered.has(t) || legacy.has(t))).toEqual([]);
    expect(listed.length).toBe(new Set(listed).size);

    const decided = new Set([...offered, ...legacy, ...listed]);
    expect(Object.values(ActionType).filter((t) => !decided.has(t))).toEqual([]);
    // The bridge writes nothing the app doesn't know.
    expect(
      [...legacy].filter((t) => !Object.values(ActionType).includes(t as ActionType)),
    ).toEqual([]);
  });
});
