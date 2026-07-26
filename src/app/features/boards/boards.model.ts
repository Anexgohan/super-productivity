/**
 * Board shapes moved to `@sp/shared-schema` so the bridge reads the same definitions the client does.
 * This file stays as the app-facing name: many files import from it, and rewriting them all would bury the actual change.
 */
export {
  BoardPanelCfgTaskDoneState,
  BoardPanelCfgScheduledState,
  BoardPanelCfgTaskTypeFilter,
} from '@sp/shared-schema';

export type {
  BoardSortField,
  BoardMatchMode,
  BoardSrcCfg,
  BoarFieldsToRemove,
  BoardPanelCfg,
  BoardCfg,
} from '@sp/shared-schema';
