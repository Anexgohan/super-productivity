import {
  BoardCfg,
  BoardPanelCfg,
  BoardPanelCfgScheduledState,
  BoardPanelCfgTaskDoneState,
  BoardPanelCfgTaskTypeFilter,
} from './boards.model';

/**
 * The starter boards moved to `@sp/shared-schema` so the bridge holds the same list.
 * Nothing reaches the op-log until a board is edited, so without a shared copy the bridge saw no boards while the browser was plainly drawing two.
 * An API caller trusting that answer would then create a duplicate of a board it could not see.
 */
export { DEFAULT_BOARDS } from '@sp/shared-schema';

export const DEFAULT_BOARD_CFG: BoardCfg = {
  id: '',
  cols: 1,
  panels: [],
  title: '',
};

export const DEFAULT_PANEL_CFG: BoardPanelCfg = {
  id: '',
  title: '',
  taskIds: [],
  taskDoneState: BoardPanelCfgTaskDoneState.All,
  excludedTagIds: [],
  includedTagIds: [],
  scheduledState: BoardPanelCfgScheduledState.All,
  backlogState: BoardPanelCfgTaskTypeFilter.All,
  isParentTasksOnly: false,
  projectIds: [''],
};
