/**
 * The inputs of the app actions the API offers (anex/app-actions): one schema per action, named as the app's action creator.
 *
 * Shared by the routes, which list them, and the app rules, which check them.
 * Ids and fields only, never raw action props, so a caller can't send a malformed entity.
 * Each action's builder fills the rest from the board, as the app's own service does.
 * Each input is a public API shape: add fields, never rename or remove one.
 */
import { z } from 'zod';

const id = z.string().min(1);
const dayStr = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'expected YYYY-MM-DD');
const clockStr = z.string().regex(/^([01]?\d|2[0-3]):[0-5]\d$/, 'expected HH:mm');
const isoTime = z.iso.datetime({ offset: true });
const ids = z.array(id).min(1);
/** The app's reminder choices (TaskReminderOptionId), relative to the time they belong to. */
export const REMIND_OPTIONS = [
  'DoNotRemind',
  'AtStart',
  'm5',
  'm10',
  'm15',
  'm30',
  'h1',
] as const;
const remind = z.enum(REMIND_OPTIONS);
const duration = z.number().int().min(1);
const anchor = z.union([id, z.null()]);

/** A node of a sidebar tree as the app stores it: a folder (`f`) or an item, a project (`p`) or a tag (`t`). */
export type MenuTreeInputNode =
  | { k: 'p' | 't'; id: string }
  | {
      k: 'f';
      id: string;
      name: string;
      isExpanded?: boolean;
      children: MenuTreeInputNode[];
    };

const folderName = z.string().trim().min(1).max(200);

const menuTreeOf = (item: 'p' | 't'): z.ZodType<MenuTreeInputNode[]> => {
  const node: z.ZodType<MenuTreeInputNode> = z.lazy(() =>
    z.union([
      z.strictObject({ k: z.literal(item), id }),
      z.strictObject({
        k: z.literal('f'),
        id,
        name: folderName,
        isExpanded: z.boolean().optional(),
        children: z.array(node),
      }),
    ]),
  );
  return z.array(node);
};

const menuTreeName = z.enum(['project', 'tag']);

const counterType = z.enum(['StopWatch', 'ClickCounter', 'RepeatedCountdownReminder']);

/** A counter's settings, as its settings dialog edits them. */
const counterSettings = z.strictObject({
  title: z.string().min(1).optional(),
  type: counterType.optional(),
  icon: z.string().min(1).nullable().optional(),
  isEnabled: z.boolean().optional(),
  isHideButton: z.boolean().optional(),
  isTrackStreaks: z.boolean().optional(),
  streakMinValue: z.number().int().min(1).optional(),
  streakMode: z.enum(['specific-days', 'weekly-frequency']).optional(),
  // Weekday 0 (Sunday) to 6, as the app keys them.
  streakWeekDays: z
    .partialRecord(z.enum(['0', '1', '2', '3', '4', '5', '6']), z.boolean())
    .optional(),
  streakWeeklyFrequency: z.number().int().min(1).max(7).optional(),
  countdownDuration: duration.optional(),
});

const taskChanges = z
  .strictObject({
    title: z.string().min(1).optional(),
    notes: z.string().optional(),
    isDone: z.boolean().optional(),
    timeEstimate: z.number().int().min(0).optional(),
  })
  .refine((c) => Object.keys(c).length > 0, 'expected at least one change');

export const ACTION_INPUTS = {
  deleteTasks: z.strictObject({ taskIds: z.array(id).min(1) }),
  deleteTask: z.strictObject({ taskId: id }),
  updateTask: z.strictObject({ taskId: id, changes: taskChanges }),
  // The monthly anchors, subtask templates and reminders are left to the app's dialog: their rules depend on each other.
  addTaskRepeatCfgToTask: z.strictObject({
    taskId: id,
    repeatCycle: z.enum(['DAILY', 'WEEKLY', 'MONTHLY', 'YEARLY']).optional(),
    repeatEvery: z.number().int().min(1).optional(),
    startDate: dayStr.optional(),
    startTime: clockStr.optional(),
    isPaused: z.boolean().optional(),
    monday: z.boolean().optional(),
    tuesday: z.boolean().optional(),
    wednesday: z.boolean().optional(),
    thursday: z.boolean().optional(),
    friday: z.boolean().optional(),
    saturday: z.boolean().optional(),
    sunday: z.boolean().optional(),
    defaultEstimate: z.number().int().min(0).optional(),
    notes: z.string().optional(),
    tagIds: z.array(id).optional(),
    order: z.number().int().optional(),
    repeatFromCompletionDate: z.boolean().optional(),
    waitForCompletion: z.boolean().optional(),
  }),
  // A section's fields, checked against the app's defaults and its validation; the sync section and per-device preferences are refused.
  updateGlobalConfigSection: z.strictObject({
    sectionKey: id,
    changes: z
      .record(z.string(), z.unknown())
      .refine((c) => Object.keys(c).length > 0, 'expected at least one change'),
  }),
  moveToArchive: z.strictObject({ taskIds: ids }),
  restoreTask: z.strictObject({ taskId: id }),
  scheduleTaskWithTime: z.strictObject({
    taskId: id,
    at: isoTime,
    remind: remind.optional(),
    isMoveToBacklog: z.boolean().optional(),
  }),
  unscheduleTask: z.strictObject({ taskId: id }),
  setDeadline: z.union([
    z.strictObject({ taskId: id, day: dayStr }),
    z.strictObject({ taskId: id, at: isoTime, remind: remind.optional() }),
  ]),
  removeDeadline: z.strictObject({ taskId: id }),
  planTaskForDay: z.strictObject({ taskId: id, day: dayStr }),
  planTasksForToday: z.strictObject({ taskIds: ids }),
  removeTasksFromTodayTag: z.strictObject({ taskIds: ids }),
  // Adds a duration in ms to the task's day, the caller's today unless given.
  logTime: z.strictObject({ taskId: id, date: dayStr.optional(), duration }),
  removeTimeSpent: z.strictObject({ taskId: id, date: dayStr.optional(), duration }),
  updateManyTasks: z.strictObject({
    updates: z
      .array(z.strictObject({ taskId: id, changes: taskChanges }))
      .min(1)
      .max(100),
  }),
  // Sections belong to a project or to Today.
  addSection: z.union([
    z.strictObject({ title: z.string().min(1), projectId: id }),
    z.strictObject({ title: z.string().min(1), today: z.literal(true) }),
  ]),
  updateSection: z.strictObject({ sectionId: id, title: z.string().min(1) }),
  deleteSection: z.strictObject({ sectionId: id }),
  // The task goes after `afterTaskId` in the section: the end if left out, the top if null.
  addTaskToSection: z.strictObject({
    sectionId: id,
    taskId: id,
    afterTaskId: anchor.optional(),
  }),
  // The task goes after `afterTaskId` among the context's tasks outside sections: the top if left out or null.
  removeTaskFromSection: z.strictObject({
    sectionId: id,
    taskId: id,
    afterTaskId: anchor.optional(),
  }),
  archiveProject: z.strictObject({ projectId: id }),
  unarchiveProject: z.strictObject({ projectId: id }),
  // The task goes after `afterTaskId` in the list, the top if null; a backlog list is the project's backlog.
  moveTask: z.strictObject({
    taskId: id,
    list: z.union([
      z.strictObject({ today: z.literal(true) }),
      z.strictObject({ tagId: id }),
      z.strictObject({ projectId: id, backlog: z.boolean().optional() }),
      z.strictObject({ parentId: id }),
    ]),
    afterTaskId: anchor,
  }),
  moveAllBacklogToRegular: z.strictObject({ projectId: id }),
  // A project with unfinished tasks needs `unfinished`: move them to the Inbox, or mark them done.
  completeProject: z.strictObject({
    projectId: id,
    unfinished: z.enum(['moveToInbox', 'markDone']).optional(),
  }),
  reopenProject: z.strictObject({ projectId: id }),
  setProjectHidden: z.strictObject({ projectId: id, hidden: z.boolean() }),
  // Turning the backlog off moves its tasks into the regular list, as in the app.
  setProjectBacklog: z.strictObject({ projectId: id, enabled: z.boolean() }),
  // Every section of the project or of Today, in the new order.
  updateSectionOrder: z.union([
    z.strictObject({ projectId: id, sectionIds: ids }),
    z.strictObject({ today: z.literal(true), sectionIds: ids }),
  ]),
  updateAttachment: z.strictObject({
    taskId: id,
    attachmentId: id,
    changes: z
      .strictObject({
        title: z.string().optional(),
        path: z.string().min(1).optional(),
      })
      .refine((c) => Object.keys(c).length > 0, 'expected at least one change'),
  }),
  deleteAttachment: z.strictObject({ taskId: id, attachmentId: id }),
  // Skips one future day of a repeating task.
  skipRepeatInstance: z.strictObject({ repeatCfgId: id, day: dayStr }),
  // Every note of the project or of Today, in the new order.
  updateNoteOrder: z.union([
    z.strictObject({ projectId: id, noteIds: ids }),
    z.strictObject({ today: z.literal(true), noteIds: ids }),
  ]),
  moveNote: z.strictObject({ noteId: id, projectId: id }),
  // The whole sidebar tree: folders hold projects (or tags) and folders; a new folder needs a new unique id.
  updateProjectTree: z.strictObject({ tree: menuTreeOf('p') }),
  updateTagTree: z.strictObject({ tree: menuTreeOf('t') }),
  updateFolder: z.strictObject({ tree: menuTreeName, folderId: id, name: folderName }),
  // The folder's projects or tags leave the tree with it; the sidebar then lists them at the top level.
  deleteFolder: z.strictObject({ tree: menuTreeName, folderId: id }),
  // A task deleted on any device in the last 7 days, back where it was, with its subtasks.
  restoreDeletedTask: z.strictObject({ taskId: id }),
  addCounter: counterSettings.extend({
    title: z.string().min(1),
    type: counterType,
  }),
  updateCounter: z.strictObject({
    counterId: id,
    changes: counterSettings.refine(
      (c) => Object.keys(c).length > 0,
      'expected at least one change',
    ),
  }),
  deleteCounter: z.strictObject({ counterId: id }),
  // A stopwatch counts ms; the other counters count clicks.
  setCounterForDay: z.strictObject({
    counterId: id,
    day: dayStr,
    value: z.number().int().min(0),
  }),
  // The day's evaluation, as its sheet writes it: only the fields given change.
  setMetric: z.strictObject({
    day: dayStr,
    changes: z
      .strictObject({
        notes: z.string().nullable().optional(),
        impactOfWork: z.number().int().min(1).max(4).nullable().optional(),
        energyCheckin: z.number().int().min(1).max(3).nullable().optional(),
        remindTomorrow: z.boolean().optional(),
      })
      .refine((c) => Object.keys(c).length > 0, 'expected at least one change'),
  }),
  // A new task from one line in the user's short syntax, such as "Write report #work +Acme @tomorrow 1h".
  addTaskFromText: z.strictObject({
    text: z.string().trim().min(1),
    projectId: id.optional(),
  }),
} as const;

export type ActionName = keyof typeof ACTION_INPUTS;
export type ActionInput<N extends ActionName> = z.infer<(typeof ACTION_INPUTS)[N]>;

export const isActionName = (name: string): name is ActionName =>
  Object.prototype.hasOwnProperty.call(ACTION_INPUTS, name);

/** One action of a build that runs several in order, each on the board the one before it left, uploaded together. */
export interface ActStep {
  name: string;
  input: unknown;
}

/** When the caller says an action happens, instead of now: a day (YYYY-MM-DD) or a time with its UTC offset. */
export const ACTION_WHEN = z.union([
  z.strictObject({ today: dayStr }),
  z.strictObject({
    now: z.iso.datetime({ offset: true }),
  }),
  z.strictObject({}),
]);

export type ActionWhen = z.infer<typeof ACTION_WHEN>;

/** Where an input is wrong, by path and rule only: the values a caller sent are never echoed. */
export const inputErrorsOf = (error: z.ZodError): string[] =>
  error.issues
    .slice(0, 20)
    .map(
      (issue) =>
        `${issue.path.length ? issue.path.join('.') : '(input)'}: ${issue.message}`,
    );
