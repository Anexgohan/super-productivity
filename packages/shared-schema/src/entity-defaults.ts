/**
 * Defaults for new tasks, tags and projects, shared by the browser and the bridge so an entity created through the API matches one created in the app.
 * Plain data only: the app re-types these against its own models, and nothing here may import from the Angular tree.
 */

export type WorkContextHue =
  | '50'
  | '100'
  | '200'
  | '300'
  | '400'
  | '500'
  | '600'
  | '700'
  | '800'
  | '900';

export const DEFAULT_PROJECT_COLOR = '#29a1aa';
export const DEFAULT_TAG_COLOR = '#a05db1';
export const DEFAULT_TODAY_TAG_COLOR = '#6495ED';
export const DEFAULT_BACKGROUND_IMAGE_BLUR = 0;
export const DEFAULT_BACKGROUND_OVERLAY_OPACITY = 20;

export const PRESET_COLORS: readonly string[] = [
  '#ef5350', // red
  '#ff7043', // deep orange
  '#ffa726', // orange
  '#ffca28', // amber
  '#ffee58', // yellow
  '#d4e157', // lime
  '#9ccc65', // light green
  '#66bb6a', // green
  '#29a1aa', // teal
  '#26c6da', // cyan
  '#29b6f6', // light blue
  '#42a5f5', // blue
  '#5c6bc0', // indigo
  '#7e57c2', // deep purple
  '#a05db1', // purple
  '#ab47bc', // purple alt
  '#ec407a', // pink
  '#8d6e63', // brown
  '#78909c', // blue grey
];

/** Chosen once at creation and written into the entity, so replaying the op stays deterministic. */
export const getRandomWorkContextColor = (): string =>
  PRESET_COLORS[Math.floor(Math.random() * PRESET_COLORS.length)];

export interface WorkContextThemeDefaults {
  isAutoContrast: boolean;
  isDisableBackgroundTint: boolean;
  primary: string;
  huePrimary: WorkContextHue;
  accent: string;
  hueAccent: WorkContextHue;
  warn: string;
  hueWarn: WorkContextHue;
  backgroundImageDark: string | null;
  backgroundImageLight: string | null;
  backgroundOverlayOpacity: number;
  backgroundImageBlur: number;
}

export const WORK_CONTEXT_DEFAULT_THEME: WorkContextThemeDefaults = {
  isAutoContrast: true,
  isDisableBackgroundTint: false,
  primary: DEFAULT_TAG_COLOR,
  huePrimary: '500',
  accent: '#ff4081',
  hueAccent: '500',
  warn: '#e11826',
  hueWarn: '500',
  backgroundImageDark: null,
  backgroundImageLight: null,
  backgroundOverlayOpacity: DEFAULT_BACKGROUND_OVERLAY_OPACITY,
  backgroundImageBlur: DEFAULT_BACKGROUND_IMAGE_BLUR,
};

export const WORKLOG_EXPORT_DEFAULTS = {
  cols: ['DATE', 'START', 'END', 'TIME_CLOCK', 'TITLES_INCLUDING_SUB'] as (
    | 'DATE'
    | 'START'
    | 'END'
    | 'TIME_CLOCK'
    | 'TITLES_INCLUDING_SUB'
  )[],
  roundWorkTimeTo: null,
  roundStartTimeTo: null,
  roundEndTimeTo: null,
  separateTasksBy: ' | ',
  groupBy: 'DATE' as const,
};

export const WORK_CONTEXT_DEFAULT_COMMON = {
  advancedCfg: {
    worklogExportSettings: WORKLOG_EXPORT_DEFAULTS,
  },
  theme: WORK_CONTEXT_DEFAULT_THEME,
  taskIds: [] as string[],
  icon: null as string | null,
  id: '',
  title: '',
};

export const DEFAULT_TASK = {
  id: '',
  subTaskIds: [] as string[],
  timeSpentOnDay: {} as Record<string, number>,
  timeSpent: 0,
  timeEstimate: 0,
  isDone: false,
  title: '',
  tagIds: [] as string[],
  created: Date.now(),
  attachments: [] as unknown[],
};

export const DEFAULT_TAG = {
  color: null as string | null,
  created: Date.now(),
  ...WORK_CONTEXT_DEFAULT_COMMON,
  icon: null as string | null,
  title: '',
  id: '',
  theme: { ...WORK_CONTEXT_DEFAULT_THEME, primary: DEFAULT_TAG_COLOR },
};

export const DEFAULT_PROJECT = {
  isHiddenFromMenu: false,
  isArchived: false,
  isDone: false,
  doneOn: null as number | null,
  isEnableBacklog: false,
  backlogTaskIds: [] as string[],
  noteIds: [] as string[],
  ...WORK_CONTEXT_DEFAULT_COMMON,
  theme: { ...WORK_CONTEXT_DEFAULT_THEME, primary: DEFAULT_PROJECT_COLOR },
};

type DefaultTag = typeof DEFAULT_TAG;

/** A new tag as the app's tag service builds it: caller fields win, except that a missing colour gets a random preset. */
export const createTagObject = <
  T extends { id?: string; title?: string; color?: string | null },
>(
  tag: T,
  newId: () => string,
): Omit<DefaultTag, keyof T> & T => ({
  ...DEFAULT_TAG,
  id: tag.id || newId(),
  title: tag.title || 'EMPTY',
  created: Date.now(),
  icon: null,
  taskIds: [],
  ...tag,
  color: tag.color || getRandomWorkContextColor(),
});
