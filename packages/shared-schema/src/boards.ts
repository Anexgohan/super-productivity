/**
 * Board shapes and the starter boards every fresh install shows.
 *
 * These live here rather than in the Angular tree because both sides need them.
 * The client uses `DEFAULT_BOARDS` as its NgRx initial state; the bridge needs the same list to say what boards an account has before any edit lands.
 * Without a shared copy the bridge reports no boards while the browser plainly draws two, and an API client that trusts it creates a duplicate.
 *
 * Nothing here may import from the Angular app: `boards.const.ts` reaches `@ngx-formly/core` through `tag.const` and `work-context.const`.
 */

export enum BoardPanelCfgTaskDoneState {
  All = 1,
  Done = 2,
  UnDone = 3,
}

export enum BoardPanelCfgScheduledState {
  All = 1,
  Scheduled = 2,
  NotScheduled = 3,
}

export enum BoardPanelCfgTaskTypeFilter {
  All = 1,
  NoBacklog = 2,
  OnlyBacklog = 3,
}

export type BoardSortField = 'dueDate' | 'created' | 'title' | 'timeEstimate';
export type BoardMatchMode = 'all' | 'any';

export interface BoardSrcCfg {
  includedTagIds: string[];
  excludedTagIds: string[];
  // Absent = 'all' (today's behavior): all required tags must match.
  includedTagsMatch?: BoardMatchMode;
  // Absent = 'any' (today's behavior): exclude on any match.
  excludedTagsMatch?: BoardMatchMode;
  // Absent/[''] = "All Projects". Optional so the typia validator tolerates
  // legacy data (panels that still carry `projectId` and no `projectIds`) on
  // raw-data paths that validate before the reducer's `sanitizePanelCfg` runs
  // (e.g. the legacy PFAPI → op-log migration). `sanitizePanelCfg` always
  // normalizes this to a defined array before it reaches any component.
  projectIds?: string[];
  taskDoneState: BoardPanelCfgTaskDoneState;
  scheduledState: BoardPanelCfgScheduledState;
  isParentTasksOnly: boolean;
  // Absent = manual order (user-controlled taskIds).
  sortBy?: BoardSortField;
  sortDir?: 'asc' | 'desc';
  /** @deprecated Migrated to sortBy/sortDir on load and scrubbed on save. */
  sortByDue?: 'off' | 'asc' | 'desc';
  // optional since newly added
  backlogState?: BoardPanelCfgTaskTypeFilter;
}

export interface BoarFieldsToRemove {
  tagIds?: string[];
}

export interface BoardPanelCfg extends BoardSrcCfg {
  id: string;
  title: string;
  taskIds: string[];
}

export interface BoardCfg {
  id: string;
  title: string;
  cols: number;
  panels: BoardPanelCfg[];
  // Absent/[''] = unassigned ("All Projects"), the same sentinel
  // `BoardSrcCfg.projectIds` uses, so `isAllProjects` serves both. Optional so
  // the typia validator tolerates boards written by any client that predates
  // the field; `sanitizeBoard` normalizes it before it reaches a component.
  projectIds?: string[];
}

/**
 * Ids of the system tags the starter boards filter on. `tag.const.ts` builds its tags from these, so a rename lands in one place and cannot silently
 * decouple a tag from the panel that filters on it.
 */
export const BOARD_TAG_IDS = {
  urgent: 'EM_URGENT',
  important: 'EM_IMPORTANT',
  inProgress: 'KANBAN_IN_PROGRESS',
} as const;

/**
 * Titles are i18n keys, not display text: the client resolves them at render time, so one stored board shows its own wording in every language.
 * A caller reading these through the API sees the raw key, which is correct - the board really is titled `F.BOARDS.DEFAULT.KANBAN` on disk.
 */
export const DEFAULT_BOARDS: BoardCfg[] = [
  {
    id: 'EISENHOWER_MATRIX',
    title: 'F.BOARDS.DEFAULT.EISENHAUER_MATRIX',
    cols: 2,
    projectIds: [''],
    panels: [
      {
        id: 'URGENT_AND_IMPORTANT',
        title: 'F.BOARDS.DEFAULT.URGENT_IMPORTANT',
        includedTagIds: [BOARD_TAG_IDS.important, BOARD_TAG_IDS.urgent],
        excludedTagIds: [],
        taskIds: [],
        // Show done and undone alike so the done-toggle (which only flips isDone) leaves the task visible, as Eisenhower has no Done column. #7498
        taskDoneState: BoardPanelCfgTaskDoneState.All,
        scheduledState: BoardPanelCfgScheduledState.All,
        backlogState: BoardPanelCfgTaskTypeFilter.All,
        isParentTasksOnly: true,
        projectIds: [''],
      },
      {
        id: 'NOT_URGENT_AND_IMPORTANT',
        title: 'F.BOARDS.DEFAULT.NOT_URGENT_IMPORTANT',
        includedTagIds: [BOARD_TAG_IDS.important],
        excludedTagIds: [BOARD_TAG_IDS.urgent],
        taskIds: [],
        taskDoneState: BoardPanelCfgTaskDoneState.All,
        scheduledState: BoardPanelCfgScheduledState.All,
        backlogState: BoardPanelCfgTaskTypeFilter.All,
        isParentTasksOnly: true,
        projectIds: [''],
      },
      {
        id: 'URGENT_AND_NOT_IMPORTANT',
        title: 'F.BOARDS.DEFAULT.URGENT_NOT_IMPORTANT',
        includedTagIds: [BOARD_TAG_IDS.urgent],
        excludedTagIds: [BOARD_TAG_IDS.important],
        taskIds: [],
        taskDoneState: BoardPanelCfgTaskDoneState.All,
        scheduledState: BoardPanelCfgScheduledState.All,
        backlogState: BoardPanelCfgTaskTypeFilter.All,
        isParentTasksOnly: true,
        projectIds: [''],
      },
      {
        id: 'NOT_URGENT_AND_NOT_IMPORTANT',
        title: 'F.BOARDS.DEFAULT.NOT_URGENT_NOT_IMPORTANT',
        includedTagIds: [],
        excludedTagIds: [BOARD_TAG_IDS.important, BOARD_TAG_IDS.urgent],
        taskIds: [],
        taskDoneState: BoardPanelCfgTaskDoneState.All,
        scheduledState: BoardPanelCfgScheduledState.All,
        backlogState: BoardPanelCfgTaskTypeFilter.All,
        isParentTasksOnly: true,
        projectIds: [''],
      },
    ],
  },
  {
    id: 'KANBAN_DEFAULT',
    title: 'F.BOARDS.DEFAULT.KANBAN',
    cols: 3,
    projectIds: [''],
    panels: [
      {
        id: 'TODO',
        title: 'F.BOARDS.DEFAULT.TO_DO',
        taskDoneState: BoardPanelCfgTaskDoneState.UnDone,
        includedTagIds: [],
        excludedTagIds: [BOARD_TAG_IDS.inProgress],
        taskIds: [],
        scheduledState: BoardPanelCfgScheduledState.All,
        backlogState: BoardPanelCfgTaskTypeFilter.NoBacklog,
        isParentTasksOnly: false,
        projectIds: [''],
      },
      {
        id: 'IN_PROGRESS',
        title: 'F.BOARDS.DEFAULT.IN_PROGRESS',
        taskDoneState: BoardPanelCfgTaskDoneState.UnDone,
        includedTagIds: [BOARD_TAG_IDS.inProgress],
        excludedTagIds: [],
        taskIds: [],
        scheduledState: BoardPanelCfgScheduledState.All,
        backlogState: BoardPanelCfgTaskTypeFilter.NoBacklog,
        isParentTasksOnly: false,
        projectIds: [''],
      },
      {
        id: 'DONE',
        title: 'F.BOARDS.DEFAULT.DONE',
        taskDoneState: BoardPanelCfgTaskDoneState.Done,
        includedTagIds: [],
        // Don't filter out completed tasks that still carry the in-progress tag: they should land here as soon as they're marked done. #7498
        excludedTagIds: [],
        taskIds: [],
        scheduledState: BoardPanelCfgScheduledState.All,
        backlogState: BoardPanelCfgTaskTypeFilter.NoBacklog,
        isParentTasksOnly: false,
        projectIds: [''],
      },
    ],
  },
];

/** A deep copy, so a caller that mutates what it is given cannot edit the starter list for everyone else in the process. */
export const cloneDefaultBoards = (): BoardCfg[] => structuredClone(DEFAULT_BOARDS);
