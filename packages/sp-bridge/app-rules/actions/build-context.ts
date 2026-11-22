/**
 * What an action builder reads and returns (anex/app-actions), shared by the registry and its builders.
 */
import type { Action } from '@ngrx/store';
import { selectTaskById } from '../../../../src/app/features/tasks/store/task.selectors';
import type { Task } from '../../../../src/app/features/tasks/task.model';
import type { TaskArchiveService } from '../../../../src/app/features/archive/task-archive.service';
import type { DateService } from '../../../../src/app/core/date/date.service';
import type { ActionInput, ActionName } from '../../src/action-inputs';

export interface BuildContext {
  /** The board as the app's selectors read it, with props as the app's services pass them. */
  select<T, P = undefined>(selector: (state: never, props: P) => T, props?: P): T;
  /** The board's archived tasks, read through the app's archive service. */
  archive: Pick<TaskArchiveService, 'getById' | 'hasTask' | 'load'>;
  /** The app's logical day on the build's clock, which is the caller's when they gave one. */
  dateService: Pick<DateService, 'todayStr' | 'getStartOfNextDayDiffMs'>;
}

export interface BuiltActions {
  actions: Action[];
  /** Ids the reply names, such as a new entity's. */
  refs: Record<string, string>;
}

export type Builder<N extends ActionName> = (
  ctx: BuildContext,
  input: ActionInput<N>,
) => BuiltActions | Promise<BuiltActions>;

export class ActionInputError extends Error {
  constructor(
    message: string,
    readonly statusCode: 400 | 404 | 409,
  ) {
    super(message);
  }
}

export const existingTask = (ctx: BuildContext, id: string): Task => {
  const task = ctx.select(selectTaskById as never, { id }) as Task | undefined;
  if (!task) throw new ActionInputError(`Task not found: ${id}`, 404);
  return task;
};

export const built = (...actions: Action[]): BuiltActions => ({ actions, refs: {} });
