/**
 * Every action the app saves has a decision for the API (anex/app-actions): offered, written by a legacy route, or not offered, with the reason.
 * An action the app adds fails here until someone decides.
 */
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { ActionType } from '../../../src/app/op-log/core/action-types.enum';
import { REMIND_OPTIONS, type ActionName } from '../src/action-inputs';
import { TaskReminderOptionId } from '../../../src/app/features/tasks/task.model';

/** The app actions each API action builds that are saved, the one it builds first leading. */
const OFFERED: Record<ActionName, ActionType | ActionType[]> = {
  deleteTasks: ActionType.TASK_SHARED_DELETE_MULTIPLE,
  deleteTask: ActionType.TASK_SHARED_DELETE,
  updateTask: ActionType.TASK_SHARED_UPDATE,
  addTaskRepeatCfgToTask: ActionType.REPEAT_CFG_ADD,
  updateGlobalConfigSection: ActionType.GLOBAL_CONFIG_UPDATE_SECTION,
  moveToArchive: ActionType.TASK_SHARED_MOVE_TO_ARCHIVE,
  restoreTask: ActionType.TASK_SHARED_RESTORE,
  scheduleTaskWithTime: ActionType.TASK_SHARED_SCHEDULE_WITH_TIME,
  unscheduleTask: ActionType.TASK_SHARED_UNSCHEDULE,
  setDeadline: ActionType.TASK_SHARED_SET_DEADLINE,
  removeDeadline: ActionType.TASK_SHARED_REMOVE_DEADLINE,
  planTaskForDay: ActionType.PLANNER_PLAN_TASK_FOR_DAY,
  planTasksForToday: ActionType.TASK_SHARED_PLAN_FOR_TODAY,
  removeTasksFromTodayTag: ActionType.TASK_SHARED_REMOVE_FROM_TODAY,
  logTime: ActionType.TIME_TRACKING_SYNC_TIME_SPENT,
  removeTimeSpent: ActionType.TASK_REMOVE_TIME_SPENT,
  updateManyTasks: ActionType.TASK_SHARED_UPDATE,
  addSection: ActionType.SECTION_ADD,
  updateSection: ActionType.SECTION_UPDATE,
  deleteSection: ActionType.SECTION_DELETE,
  addTaskToSection: ActionType.SECTION_ADD_TASK,
  removeTaskFromSection: ActionType.SECTION_REMOVE_TASK,
  archiveProject: ActionType.PROJECT_ARCHIVE,
  unarchiveProject: ActionType.PROJECT_UNARCHIVE,
  moveTask: [
    ActionType.WORK_CONTEXT_MOVE,
    ActionType.PROJECT_MOVE_TASK_IN_BACKLOG,
    ActionType.PROJECT_MOVE_TO_BACKLOG,
    ActionType.PROJECT_MOVE_FROM_BACKLOG,
    ActionType.TASK_MOVE_SUB,
  ],
  moveAllBacklogToRegular: ActionType.PROJECT_MOVE_ALL_BACKLOG,
  completeProject: ActionType.PROJECT_COMPLETE,
  reopenProject: ActionType.PROJECT_REOPEN,
  setProjectHidden: ActionType.PROJECT_TOGGLE_HIDE,
  setProjectBacklog: ActionType.PROJECT_UPDATE,
  updateSectionOrder: ActionType.SECTION_UPDATE_ORDER,
  updateAttachment: ActionType.ATTACHMENT_UPDATE,
  deleteAttachment: ActionType.ATTACHMENT_DELETE,
  skipRepeatInstance: ActionType.REPEAT_CFG_DELETE_INSTANCE,
  updateNoteOrder: ActionType.NOTE_UPDATE_ORDER,
  moveNote: ActionType.NOTE_MOVE_TO_PROJECT,
  updateProjectTree: ActionType.MENU_TREE_UPDATE_PROJECT,
  updateTagTree: ActionType.MENU_TREE_UPDATE_TAG,
  updateFolder: ActionType.MENU_TREE_UPDATE_FOLDER,
  deleteFolder: ActionType.MENU_TREE_DELETE_FOLDER,
  restoreDeletedTask: ActionType.TASK_SHARED_RESTORE_DELETED,
  addCounter: ActionType.COUNTER_ADD,
  updateCounter: ActionType.COUNTER_UPDATE,
  deleteCounter: ActionType.COUNTER_DELETE,
  setCounterForDay: ActionType.COUNTER_SET_FOR_DATE,
  setMetric: ActionType.METRIC_UPSERT,
  addTaskFromText: [
    ActionType.TASK_SHARED_ADD,
    ActionType.TASK_SHARED_APPLY_SHORT_SYNTAX,
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
  'never dispatched by the app': [
    'BOARDS_UPDATE_PANEL_CFG',
    'LOAD_BACKUP_DATA',
    'TASK_SHARED_MOVE_IN_TODAY',
  ],
  'never dispatched by the app; the sidebar order is the menu tree': [
    'PROJECT_UPDATE_ORDER',
    'TAG_UPDATE_ORDER',
  ],
  "a browser's own storage migration or recovery": [
    'MIGRATION_GENESIS_IMPORT',
    'RECOVERY_DATA_IMPORT',
  ],
  'whole-board: the import route and checkpoints write these': [
    'LOAD_ALL_DATA',
    'REPAIR_AUTO',
  ],
  'a bare update of many tasks that skips the single-task rules: updateManyTasks makes one app update per task':
    ['TASK_SHARED_UPDATE_MULTIPLE'],
  'reduced exactly as scheduling, which covers a reschedule as the schedule dialog does':
    ['TASK_SHARED_RESCHEDULE_WITH_TIME'],
  'up, down, top and bottom variants: the one move route with a target position covers them':
    [
      'TASK_MOVE_UP',
      'TASK_MOVE_DOWN',
      'TASK_MOVE_TOP',
      'TASK_MOVE_BOTTOM',
      'WORK_CONTEXT_MOVE_UP',
      'WORK_CONTEXT_MOVE_DOWN',
      'WORK_CONTEXT_MOVE_TOP',
      'WORK_CONTEXT_MOVE_BOTTOM',
      'PROJECT_MOVE_TASK_UP_BACKLOG',
      'PROJECT_MOVE_TASK_DOWN_BACKLOG',
      'PROJECT_MOVE_TASK_TOP_BACKLOG',
      'PROJECT_MOVE_TASK_BOTTOM_BACKLOG',
    ],
  'done by the app itself: its own follow-up code makes these where they belong': [
    'PROJECT_AUTO_MOVE_TO_BACKLOG',
    'PROJECT_AUTO_MOVE_FROM_BACKLOG',
    'TASK_SHARED_PLAN_DEADLINE_FOR_TODAY',
    'TASK_SHARED_REMOVE_TAGS_ALL',
    'COUNTER_SYNC_TIME',
    'TIME_TRACKING_SYNC_SESSIONS',
    'TIME_TRACKING_UPDATE_CONTEXT_DATA',
    'METRIC_LOG_FOCUS_SESSION',
    'ARCHIVE_COMPRESS',
    'ARCHIVE_FLUSH_YOUNG_TO_OLD',
  ],
  'overlaps a route that stays': [
    'TASK_SHARED_ADD_TAG',
    'TASK_UPDATE_MULTIPLE_SIMPLE',
    'TASK_SHARED_DELETE_REPEAT_CFG',
    'REPEAT_CFG_UPDATE_MULTIPLE',
    'REPEAT_CFG_DELETE_MULTIPLE',
    'TAG_DELETE_MULTIPLE',
    'METRIC_ADD',
    'METRIC_UPDATE',
    'METRIC_DELETE',
    'COUNTER_DELETE_MULTIPLE',
    'COUNTER_UPDATE_ALL',
    'COUNTER_UPDATE_ORDER',
    'COUNTER_SET_TODAY',
  ],
  'screen or device state': [
    'TASK_UPDATE_UI',
    'TASK_SHARED_DISMISS_REMINDER',
    'TASK_SHARED_CLEAR_DEADLINE_REMINDER',
    'PLANNER_UPSERT_DAY',
    'PLANNER_TRANSFER_TASK',
    'PLANNER_MOVE_IN_LIST',
    'PLANNER_MOVE_BEFORE_TASK',
  ],
  'integrations and plugins, set up in a browser': [
    'ISSUE_PROVIDER_ADD',
    'ISSUE_PROVIDER_UPDATE',
    'ISSUE_PROVIDER_SORT_FIRST',
    'TASK_SHARED_DELETE_ISSUE_PROVIDER',
    'TASK_SHARED_DELETE_ISSUE_PROVIDERS',
    'TASK_SHARED_BATCH_UPDATE_PROJECT',
    'PLUGIN_UPSERT_USER_DATA',
    'PLUGIN_DELETE_USER_DATA',
    'PLUGIN_UPSERT_METADATA',
    'PLUGIN_DELETE_METADATA',
  ],
  'rarely used': [
    'PROJECT_UPDATE_ADVANCED_CFG',
    'TAG_UPDATE_ADVANCED_CONFIG',
    'TASK_ROUND_TIME_SPENT',
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
    const offered = new Set<string>(Object.values(OFFERED).flat());
    const listed = Object.values(NOT_OFFERED)
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

  it("lists the app's reminder choices as the app has them", () => {
    expect([...REMIND_OPTIONS].sort()).toEqual(
      Object.values(TaskReminderOptionId).sort(),
    );
  });
});
