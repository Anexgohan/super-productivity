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
