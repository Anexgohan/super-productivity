/**
 * The app's root reducer, assembled the way the app's store assembles it (anex/state-check).
 *
 * Keep in step with src/app/root-store/feature-stores.module.ts (every StoreModule.forFeature there) and with META_REDUCERS.
 * tests/app-rules-features.spec.ts fails when a feature is registered there but not here.
 */
import { combineReducers, compose, type ActionReducer } from '@ngrx/store';
import { META_REDUCERS } from '../../../src/app/root-store/meta/meta-reducer-registry';
import {
  LAYOUT_FEATURE_NAME,
  layoutReducer,
} from '../../../src/app/core-ui/layout/store/layout.reducer';
import {
  CONFIG_FEATURE_NAME,
  globalConfigReducer,
} from '../../../src/app/features/config/store/global-config.reducer';
import {
  FOCUS_MODE_FEATURE_KEY,
  focusModeReducer,
} from '../../../src/app/features/focus-mode/store/focus-mode.reducer';
import {
  IDLE_FEATURE_KEY,
  idleReducer,
} from '../../../src/app/features/idle/store/idle.reducer';
import { issueProvidersFeature } from '../../../src/app/features/issue/store/issue-provider.reducer';
import {
  METRIC_FEATURE_NAME,
  metricReducer,
} from '../../../src/app/features/metric/store/metric.reducer';
import {
  NOTE_FEATURE_NAME,
  noteReducer,
} from '../../../src/app/features/note/store/note.reducer';
import {
  PROJECT_FEATURE_NAME,
  projectReducer,
} from '../../../src/app/features/project/store/project.reducer';
import {
  menuTreeFeatureKey,
  menuTreeReducer,
} from '../../../src/app/features/menu-tree/store/menu-tree.reducer';
import {
  SIMPLE_COUNTER_FEATURE_NAME,
  simpleCounterReducer,
} from '../../../src/app/features/simple-counter/store/simple-counter.reducer';
import {
  SECTION_FEATURE_NAME,
  sectionReducer,
} from '../../../src/app/features/section/store/section.reducer';
import {
  TAG_FEATURE_NAME,
  tagReducer,
} from '../../../src/app/features/tag/store/tag.reducer';
import {
  TASK_REPEAT_CFG_FEATURE_NAME,
  taskRepeatCfgReducer,
} from '../../../src/app/features/task-repeat-cfg/store/task-repeat-cfg.reducer';
import {
  TASK_FEATURE_NAME,
  taskReducer,
} from '../../../src/app/features/tasks/store/task.reducer';
import { WORK_CONTEXT_FEATURE_NAME } from '../../../src/app/features/work-context/store/work-context.selectors';
import { workContextReducer } from '../../../src/app/features/work-context/store/work-context.reducer';
import { boardsFeature } from '../../../src/app/features/boards/store/boards.reducer';
import { timeTrackingFeature } from '../../../src/app/features/time-tracking/store/time-tracking.reducer';
import { plannerFeature } from '../../../src/app/features/planner/store/planner.reducer';
import { appStateFeature } from '../../../src/app/root-store/app-state/app-state.reducer';
import {
  PLUGIN_USER_DATA_FEATURE_NAME,
  pluginUserDataReducer,
} from '../../../src/app/plugins/store/plugin-user-data.reducer';
import {
  PLUGIN_METADATA_FEATURE_NAME,
  pluginMetadataReducer,
} from '../../../src/app/plugins/store/plugin-metadata.reducer';
import {
  REMINDER_FEATURE_NAME,
  reminderReducer,
} from '../../../src/app/features/reminder/store/reminder.reducer';

export type RootState = Record<string, unknown>;

export const buildRootReducer = (): ActionReducer<RootState> => {
  const reducers = {
    [appStateFeature.name]: appStateFeature.reducer,
    [LAYOUT_FEATURE_NAME]: layoutReducer,
    [CONFIG_FEATURE_NAME]: globalConfigReducer,
    [FOCUS_MODE_FEATURE_KEY]: focusModeReducer,
    [IDLE_FEATURE_KEY]: idleReducer,
    [issueProvidersFeature.name]: issueProvidersFeature.reducer,
    [METRIC_FEATURE_NAME]: metricReducer,
    [NOTE_FEATURE_NAME]: noteReducer,
    [PROJECT_FEATURE_NAME]: projectReducer,
    [menuTreeFeatureKey]: menuTreeReducer,
    [SIMPLE_COUNTER_FEATURE_NAME]: simpleCounterReducer,
    [SECTION_FEATURE_NAME]: sectionReducer,
    [TAG_FEATURE_NAME]: tagReducer,
    [TASK_REPEAT_CFG_FEATURE_NAME]: taskRepeatCfgReducer,
    [TASK_FEATURE_NAME]: taskReducer,
    [WORK_CONTEXT_FEATURE_NAME]: workContextReducer,
    [boardsFeature.name]: boardsFeature.reducer,
    [timeTrackingFeature.name]: timeTrackingFeature.reducer,
    [plannerFeature.name]: plannerFeature.reducer,
    [PLUGIN_USER_DATA_FEATURE_NAME]: pluginUserDataReducer,
    [PLUGIN_METADATA_FEATURE_NAME]: pluginMetadataReducer,
    [REMINDER_FEATURE_NAME]: reminderReducer,
  };
  // The reducer map is heterogeneous by design; combineReducers types each slice, which a mixed map can't satisfy.
  const combined = combineReducers(
    reducers as unknown as Parameters<typeof combineReducers>[0],
  );
  return compose(...META_REDUCERS)(combined) as ActionReducer<RootState>;
};
