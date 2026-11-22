/**
 * Headless stand-ins for the app parts an action build runs without a UI (anex/app-actions).
 *
 * Each method a follow-up rule calls forwards to the app's own selector or action creator, copied from the service it stands in for,
 * so the rules stay the app's and only the plumbing between them and the store is ours. A method no rule here reaches is absent:
 * a call to one fails the build, rather than letting a change upload without its follow-ups.
 */
import { BehaviorSubject, EMPTY, Observable, of } from 'rxjs';
import { select } from '@ngrx/store';
import { take } from 'rxjs/operators';
import type { Action } from '@ngrx/store';
import type { Update } from '@ngrx/entity';
import { TaskSharedActions } from '../../../../src/app/root-store/meta/task-shared.actions';
import {
  selectTaskById,
  selectTaskByIdWithSubTaskData,
  selectTasksByIdFactory,
  selectTasksByRepeatConfigId,
} from '../../../../src/app/features/tasks/store/task.selectors';
import type {
  Task,
  TaskReminderOptionId,
  TaskWithSubTasks,
} from '../../../../src/app/features/tasks/task.model';
import { remindOptionToMilliseconds } from '../../../../src/app/features/tasks/util/remind-option-to-milliseconds';
import { unique } from '../../../../src/app/util/unique';
import type { TaskArchiveService } from '../../../../src/app/features/archive/task-archive.service';
import type { DateService } from '../../../../src/app/core/date/date.service';
import type { RootState } from '../root-reducer';

/** A store over one build's state: emits the current state to every reader, as the app's store does, and hands dispatches to the build. */
export class HeadlessStore extends Observable<RootState> {
  constructor(
    private readonly _state$: BehaviorSubject<RootState>,
    private readonly _dispatch: (action: Action) => void,
  ) {
    super((subscriber) => _state$.subscribe(subscriber));
  }

  dispatch(action: Action): void {
    this._dispatch(action);
  }

  select<T>(selector: (state: RootState) => T): Observable<T> {
    return this.pipe(select(selector));
  }
}

const notHeadless = (what: string): never => {
  throw Object.assign(
    new Error(`${what} is not available to the app rules' action builds`),
    {
      statusCode: 501,
    },
  );
};

/** TaskService, as far as the follow-up rules reach: its reads are the app's selectors, its writes the app's actions. */
export class HeadlessTaskService {
  constructor(
    private readonly _store: HeadlessStore,
    private readonly _taskArchiveService: TaskArchiveService,
  ) {}

  private _live<T>(selector: unknown, props?: object): Observable<T> {
    return this._store.pipe(select(selector as never, props as never)) as Observable<T>;
  }

  getByIdOnce$(id: string): Observable<Task> {
    return this._live<Task>(selectTaskById, { id }).pipe(take(1));
  }

  getByIdLive$(id: string): Observable<Task> {
    return this._live<Task>(selectTaskById, { id });
  }

  getByIdsLive$(ids: string[]): Observable<Task[]> {
    return this._live<Task[]>(selectTasksByIdFactory(ids));
  }

  getByIdWithSubTaskData$(id: string): Observable<TaskWithSubTasks> {
    return this._live<TaskWithSubTasks>(selectTaskByIdWithSubTaskData, { id }).pipe(
      take(1),
    );
  }

  getTasksByRepeatCfgId$(repeatCfgId: string): Observable<Task[]> {
    return this._live<Task[]>(selectTasksByRepeatConfigId, { repeatCfgId }).pipe(take(1));
  }

  async getArchiveTasksForRepeatCfgId(repeatCfgId: string): Promise<Task[]> {
    const archiveTaskState = await this._taskArchiveService.load();
    const ids = (archiveTaskState && (archiveTaskState.ids as string[])) || [];
    const archiveTasks = ids
      .map((id) => archiveTaskState.entities[id])
      .filter((task): task is Task => !!task);
    return archiveTasks.filter((task) => task.repeatCfgId === repeatCfgId);
  }

  update(id: string, changedFields: Partial<Task>): void {
    // The app's version also moves subtasks along with a project change; no follow-up rule here changes a project.
    if (Object.prototype.hasOwnProperty.call(changedFields, 'projectId')) {
      notHeadless('TaskService.update with a projectId');
    }
    this._store.dispatch(
      TaskSharedActions.updateTask({ task: { id, changes: changedFields } }),
    );
  }

  updateTags(task: Task, newTagIds: string[]): void {
    this._store.dispatch(
      TaskSharedActions.updateTask({
        task: { id: task.id, changes: { tagIds: unique(newTagIds) } },
      }),
    );
  }

  scheduleTask(
    task: Task | TaskWithSubTasks,
    due: number,
    remindCfg: TaskReminderOptionId,
    isMoveToBacklog: boolean = false,
  ): void {
    this._store.dispatch(
      TaskSharedActions.scheduleTaskWithTime({
        task,
        dueWithTime: due,
        remindAt: remindOptionToMilliseconds(due, remindCfg),
        isMoveToBacklog,
      }),
    );
  }

  reScheduleTask({
    task,
    due,
    remindCfg,
    isMoveToBacklog = false,
  }: {
    task: Task;
    due: number;
    remindCfg: TaskReminderOptionId;
    isMoveToBacklog: boolean;
  }): void {
    this._store.dispatch(
      TaskSharedActions.reScheduleTaskWithTime({
        task,
        dueWithTime: due,
        remindAt: remindOptionToMilliseconds(due, remindCfg),
        isMoveToBacklog,
      }),
    );
  }

  updateArchiveTasks(_updates: Update<Task>[]): Promise<void> {
    return notHeadless('Updating archived tasks');
  }

  createNewTaskWithDefaults(): Task {
    return notHeadless('Creating a repeat instance');
  }
}

/** WorkContextService: no context is active in the container, so the rule that picks the next task to track finds none. */
export class HeadlessWorkContextService {
  mainListTaskIds$: Observable<string[]> = of([]);

  get activeWorkContextType(): never {
    return notHeadless('The active work context');
  }

  get activeWorkContextId(): never {
    return notHeadless('The active work context');
  }
}

/** MatDialog: no one is there to answer, so every dialog is cancelled, as closing it would. */
export class HeadlessMatDialog {
  open(): { afterClosed: () => Observable<undefined> } {
    return { afterClosed: () => of(undefined) };
  }
}

/** GlobalTrackingIntervalService: no timer ticks in the container; the day is the build's, from the app's DateService. */
export class HeadlessTrackingInterval {
  constructor(private readonly _dateService: DateService) {}

  globalInterval$: Observable<number> = EMPTY;
  tick$: Observable<never> = EMPTY;

  get todayDateStr$(): Observable<string> {
    return of(this._dateService.todayStr());
  }

  todayDateStr(): string {
    return this._dateService.todayStr();
  }
}

/** A service the build's follow-ups inject but never reach: calling it fails the build, rather than running UI code headless. */
export const unreachable = (name: string): object =>
  new Proxy(
    {},
    {
      // The injector's own checks read plain object properties and Angular's lifecycle hooks; those stay as on any object.
      get: (target, prop, receiver) =>
        typeof prop === 'symbol' || prop in target || prop.startsWith('ng')
          ? Reflect.get(target, prop, receiver)
          : () => notHeadless(`${name}.${prop}`),
    },
  );
