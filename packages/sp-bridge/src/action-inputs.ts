/**
 * The inputs of the app actions the API offers (anex/app-actions): one schema per action, named as the app's action creator.
 *
 * Shared by the routes, which list them, and the app rules, which check them. Ids and fields only, never raw action props,
 * so a caller can't send a malformed entity: each action's builder fills the rest from the board, as the app's own service does.
 * Each input is a public API shape: add fields, never rename or remove one.
 */
import { z } from 'zod';

const id = z.string().min(1);
const dayStr = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'expected YYYY-MM-DD');
const clockStr = z.string().regex(/^([01]?\d|2[0-3]):[0-5]\d$/, 'expected HH:mm');

export const ACTION_INPUTS = {
  deleteTasks: z.strictObject({ taskIds: z.array(id).min(1) }),
  deleteTask: z.strictObject({ taskId: id }),
  updateTask: z.strictObject({
    taskId: id,
    changes: z
      .strictObject({
        title: z.string().min(1).optional(),
        notes: z.string().optional(),
        isDone: z.boolean().optional(),
        timeEstimate: z.number().int().min(0).optional(),
      })
      .refine((c) => Object.keys(c).length > 0, 'expected at least one change'),
  }),
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
} as const;

export type ActionName = keyof typeof ACTION_INPUTS;
export type ActionInput<N extends ActionName> = z.infer<(typeof ACTION_INPUTS)[N]>;

export const isActionName = (name: string): name is ActionName =>
  Object.prototype.hasOwnProperty.call(ACTION_INPUTS, name);

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
