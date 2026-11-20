/**
 * anex fork, Stage 9: what a server-order replay keeps from the state shown before it.
 *
 * The replay starts from the state the server confirmed, so on its own it would also undo what lives only in this
 * browser: the open task and its panel, the running timer, this browser's sync settings, and tracked time not yet saved
 * as a change. The synced data comes from the replay; everything else is kept from the state shown.
 */
import { BatchedTimeSyncEntry } from '../../core/util/batched-time-sync-accumulator';
import { BOARDS_FEATURE_NAME } from '../../features/boards/store/boards.reducer';
import { CONFIG_FEATURE_NAME } from '../../features/config/store/global-config.reducer';
import { GlobalConfigState } from '../../features/config/global-config.model';
import { withLocalOnlySyncSettings } from '../../features/config/local-only-sync-settings.util';
import { ISSUE_PROVIDER_FEATURE_KEY } from '../../features/issue/store/issue-provider.reducer';
import { menuTreeFeatureKey } from '../../features/menu-tree/store/menu-tree.reducer';
import { METRIC_FEATURE_NAME } from '../../features/metric/store/metric.reducer';
import { NOTE_FEATURE_NAME } from '../../features/note/store/note.reducer';
import { plannerFeatureKey } from '../../features/planner/store/planner.reducer';
import { PROJECT_FEATURE_NAME } from '../../features/project/store/project.reducer';
import { REMINDER_FEATURE_NAME } from '../../features/reminder/store/reminder.reducer';
import { SECTION_FEATURE_NAME } from '../../features/section/store/section.reducer';
import { SIMPLE_COUNTER_FEATURE_NAME } from '../../features/simple-counter/store/simple-counter.reducer';
import { SimpleCounterState } from '../../features/simple-counter/simple-counter.model';
import { TAG_FEATURE_NAME } from '../../features/tag/store/tag.reducer';
import { TASK_REPEAT_CFG_FEATURE_NAME } from '../../features/task-repeat-cfg/store/task-repeat-cfg.reducer';
import { TASK_FEATURE_NAME } from '../../features/tasks/store/task.reducer';
import { TaskState } from '../../features/tasks/task.model';
import {
  addPendingTimeToTaskState,
  projectPendingTimeFromTaskState,
} from '../../features/tasks/util/project-pending-time-from-task-state';
import { TIME_TRACKING_FEATURE_KEY } from '../../features/time-tracking/store/time-tracking.reducer';
import { PLUGIN_METADATA_FEATURE_NAME } from '../../plugins/store/plugin-metadata.reducer';
import { PLUGIN_USER_DATA_FEATURE_NAME } from '../../plugins/store/plugin-user-data.reducer';

/**
 * The store features holding synced data: the ones a checkpoint and a full import carry (StateSnapshotService's
 * selectors). Every other feature (layout, focus mode, idle, work context, app state) lives only in this browser.
 */
export const SYNCED_FEATURE_KEYS: readonly string[] = [
  TASK_FEATURE_NAME,
  PROJECT_FEATURE_NAME,
  TAG_FEATURE_NAME,
  CONFIG_FEATURE_NAME,
  NOTE_FEATURE_NAME,
  ISSUE_PROVIDER_FEATURE_KEY,
  plannerFeatureKey,
  BOARDS_FEATURE_NAME,
  METRIC_FEATURE_NAME,
  SIMPLE_COUNTER_FEATURE_NAME,
  TASK_REPEAT_CFG_FEATURE_NAME,
  menuTreeFeatureKey,
  TIME_TRACKING_FEATURE_KEY,
  PLUGIN_USER_DATA_FEATURE_NAME,
  PLUGIN_METADATA_FEATURE_NAME,
  REMINDER_FEATURE_NAME,
  SECTION_FEATURE_NAME,
];

/** Changes counted in this browser but not saved as a change yet. */
export interface UnsavedLocalTime {
  /** Tracked task time (TaskTimeSyncService and captured changes not yet written). */
  taskTime: readonly BatchedTimeSyncEntry[];
  /** Simple-counter stopwatch time (SimpleCounterService). */
  stopwatch: readonly BatchedTimeSyncEntry[];
}

export const NO_UNSAVED_LOCAL_TIME: UnsavedLocalTime = { taskTime: [], stopwatch: [] };

type StateRecord = Record<string, unknown>;

const keepTaskLocalFields = (replayed: TaskState, shown: TaskState): TaskState => {
  const stillThere = (id: string | null): string | null =>
    id && replayed.entities[id] ? id : null;
  return {
    ...replayed,
    currentTaskId: stillThere(shown.currentTaskId),
    selectedTaskId: stillThere(shown.selectedTaskId),
    taskDetailTargetPanel: shown.taskDetailTargetPanel,
    lastCurrentTaskId: shown.lastCurrentTaskId,
    isDataLoaded: shown.isDataLoaded,
  };
};

const keepLocalSyncSettings = (
  replayed: GlobalConfigState,
  shown: GlobalConfigState,
): GlobalConfigState =>
  replayed.sync && shown.sync
    ? { ...replayed, sync: withLocalOnlySyncSettings(replayed.sync, shown.sync) }
    : replayed;

/** The stopwatch saves its absolute value later, so the counted value shown is the one to keep. */
const keepUnsavedStopwatch = (
  replayed: SimpleCounterState,
  shown: SimpleCounterState,
  pending: readonly BatchedTimeSyncEntry[],
): SimpleCounterState => {
  let entities = replayed.entities;
  for (const { id, date } of pending) {
    const replayedCounter = entities[id];
    const shownValue = shown.entities[id]?.countOnDay?.[date];
    if (!replayedCounter || shownValue === undefined) {
      continue;
    }
    entities = {
      ...entities,
      [id]: {
        ...replayedCounter,
        countOnDay: { ...replayedCounter.countOnDay, [date]: shownValue },
      },
    };
  }
  return entities === replayed.entities ? replayed : { ...replayed, entities };
};

/**
 * The state to show after a replay: the synced features from `replayed`, everything else from `shown`, with the local
 * fields of the synced features and the time not saved yet carried over from `shown`.
 */
export const keepLocalOnlyState = <TState extends object>(
  replayed: TState,
  shown: TState,
  unsaved: UnsavedLocalTime = NO_UNSAVED_LOCAL_TIME,
): TState => {
  const replayedRecord = replayed as StateRecord;
  const shownRecord = shown as StateRecord;
  const next: StateRecord = { ...shownRecord };
  for (const key of SYNCED_FEATURE_KEYS) {
    if (key in replayedRecord) {
      next[key] = replayedRecord[key];
    }
  }

  const replayedTasks = replayedRecord[TASK_FEATURE_NAME] as TaskState | undefined;
  const shownTasks = shownRecord[TASK_FEATURE_NAME] as TaskState | undefined;
  if (replayedTasks && shownTasks) {
    next[TASK_FEATURE_NAME] = addPendingTimeToTaskState(
      keepTaskLocalFields(replayedTasks, shownTasks),
      unsaved.taskTime,
    );
  }

  const replayedConfig = replayedRecord[CONFIG_FEATURE_NAME] as
    | GlobalConfigState
    | undefined;
  const shownConfig = shownRecord[CONFIG_FEATURE_NAME] as GlobalConfigState | undefined;
  if (replayedConfig && shownConfig) {
    next[CONFIG_FEATURE_NAME] = keepLocalSyncSettings(replayedConfig, shownConfig);
  }

  const replayedCounters = replayedRecord[SIMPLE_COUNTER_FEATURE_NAME] as
    | SimpleCounterState
    | undefined;
  const shownCounters = shownRecord[SIMPLE_COUNTER_FEATURE_NAME] as
    | SimpleCounterState
    | undefined;
  if (replayedCounters && shownCounters && unsaved.stopwatch.length > 0) {
    next[SIMPLE_COUNTER_FEATURE_NAME] = keepUnsavedStopwatch(
      replayedCounters,
      shownCounters,
      unsaved.stopwatch,
    );
  }

  return next as TState;
};

/**
 * The state shown, as a confirmed state: the tracked time not saved as a change yet is taken out, since a replay adds
 * it back (keepLocalOnlyState) and the change that later saves it is applied on top.
 */
export const withoutUnsavedTaskTime = <TState extends object>(
  shown: TState,
  unsaved: UnsavedLocalTime,
): TState => {
  const shownRecord = shown as StateRecord;
  const tasks = shownRecord[TASK_FEATURE_NAME] as TaskState | undefined;
  if (!tasks || unsaved.taskTime.length === 0) {
    return shown;
  }
  const projected = projectPendingTimeFromTaskState(tasks, unsaved.taskTime);
  return projected === tasks
    ? shown
    : ({ ...shownRecord, [TASK_FEATURE_NAME]: projected } as TState);
};
