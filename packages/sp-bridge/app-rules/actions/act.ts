/**
 * Builds one API action into the ops a browser would upload for it (anex/app-actions).
 *
 *  1. check the input, then build the app's actions from the board (registry.ts);
 *  2. dispatch them on a copy of the board, with the app's follow-up effects listening, as in a browser;
 *  3. check the board they leave with the app's full validation;
 *  4. turn every saved action, follow-ups included, into an op with the app's own code (operationFromAction, syncOpFromOperation).
 *
 * The board itself never changes here: it changes only from downloaded ops, when the uploaded ones come back.
 */
import { Injector, ɵINJECTOR_SCOPE as INJECTOR_SCOPE, type Type } from '@angular/core';
import { Store, type Action } from '@ngrx/store';
import { getEffectsMetadata } from '@ngrx/effects';
import { MatDialog } from '@angular/material/dialog';
import { BehaviorSubject, Subject, type Observable, type Subscription } from 'rxjs';
import { LOCAL_ACTIONS } from '../../../../src/app/util/local-actions.token';
import { DateService } from '../../../../src/app/core/date/date.service';
import { GlobalTrackingIntervalService } from '../../../../src/app/core/global-tracking-interval/global-tracking-interval.service';
import { TaskService } from '../../../../src/app/features/tasks/task.service';
import { WorkContextService } from '../../../../src/app/features/work-context/work-context.service';
import { TaskArchiveService } from '../../../../src/app/features/archive/task-archive.service';
import { TaskInternalEffects } from '../../../../src/app/features/tasks/store/task-internal.effects';
import { TaskRepeatCfgEffects } from '../../../../src/app/features/task-repeat-cfg/store/task-repeat-cfg.effects';
import { ArchiveStoreService } from '../../../../src/app/op-log/persistence/archive-store.service';
import { StateSnapshotService } from '../../../../src/app/op-log/backup/state-snapshot.service';
import { OperationCaptureService } from '../../../../src/app/op-log/capture/operation-capture.service';
import { setOperationCaptureService } from '../../../../src/app/op-log/capture/operation-capture.meta-reducer';
import { operationFromAction } from '../../../../src/app/op-log/capture/action-to-operation.util';
import { syncOpFromOperation } from '../../../../src/app/op-log/sync/upload-payload.util';
import {
  isPersistentAction,
  type PersistentAction,
} from '../../../../src/app/op-log/core/persistent-action.interface';
import { validateFull } from '../../../../src/app/op-log/validation/validation-fn';
import type { AppDataComplete } from '../../../../src/app/op-log/model/model-config';
import type { ArchiveModel } from '../../../../src/app/features/archive/archive.model';
import { selectMiscConfig } from '../../../../src/app/features/config/store/global-config.reducer';
import { normalizeStartOfNextDayConfig } from '../../../../src/app/features/config/normalize-start-of-next-day-config';
import { getStartOfNextDayDiffMs } from '../../../../src/app/util/start-of-next-day.util';
import { uuidv7 } from '../../../../src/app/util/uuid-v7';
import {
  ACTION_INPUTS,
  inputErrorsOf,
  isActionName,
  type ActionWhen,
} from '../../src/action-inputs';
import type { AppRulesActResult, BuiltOp } from '../../src/app-rules-protocol';
import type { RootState } from '../root-reducer';
import { logicalDayChange } from '../logical-day';
import { validationErrorsOf } from '../board-transfer';
import { ActionInputError, buildAction } from './registry';
import { realNow, withCallerClock } from './clock';
import {
  HeadlessMatDialog,
  HeadlessStore,
  HeadlessTaskService,
  HeadlessTrackingInterval,
  HeadlessWorkContextService,
} from './headless';

/** The app's effect classes whose follow-ups a build runs: each one saves changes the API must make too. */
export const FOLLOW_UP_EFFECTS: Type<object>[] = [
  TaskInternalEffects,
  TaskRepeatCfgEffects,
];

/** Rounds of the event loop a build waits for follow-ups that read the archive or another promise; none of them waits on a timer. */
const SETTLE_ROUNDS = 20;

export class ActError extends Error {
  constructor(
    message: string,
    readonly statusCode: number,
    readonly errors: string[] = [],
  ) {
    super(message);
  }
}

/** The board's archives as the build reads them; a follow-up that writes one has no place here, so it fails the build. */
interface ArchiveReader {
  loadArchiveYoung(): Promise<ArchiveModel | undefined>;
  loadArchiveOld(): Promise<ArchiveModel | undefined>;
  hasArchiveYoung(): Promise<boolean>;
  hasArchiveOld(): Promise<boolean>;
}

const readOnlyArchive = (archive: ArchiveReader): Record<string, unknown> => {
  const refuse = (): never => {
    throw new ActError(
      'A follow-up of this action changes the archive, which actions do not do yet.',
      501,
    );
  };
  return {
    loadArchiveYoung: () => archive.loadArchiveYoung(),
    loadArchiveOld: () => archive.loadArchiveOld(),
    hasArchiveYoung: () => archive.hasArchiveYoung(),
    hasArchiveOld: () => archive.hasArchiveOld(),
    saveArchiveYoung: refuse,
    saveArchiveOld: refuse,
    saveArchivesAtomic: refuse,
  };
};

const startOfNextDayDiffOf = (state: RootState): number => {
  const misc = normalizeStartOfNextDayConfig(selectMiscConfig(state as never));
  return getStartOfNextDayDiffMs(misc.startOfNextDayTime, misc.startOfNextDay);
};

/** The moment a build runs at: the caller's time, or the caller's day at the container's time of day, or now. */
const callerNowOf = (when: ActionWhen, state: RootState): number | null => {
  if ('now' in when) return Date.parse(when.now);
  if (!('today' in when)) return null;
  const diff = startOfNextDayDiffOf(state);
  const logical = new Date(realNow() - diff);
  const [y, m, d] = when.today.split('-').map(Number);
  const shifted = new Date(
    y,
    m - 1,
    d,
    logical.getHours(),
    logical.getMinutes(),
    logical.getSeconds(),
    logical.getMilliseconds(),
  );
  return shifted.getTime() + diff;
};

const reducerFailure = (action: Action, err: unknown): ActError =>
  new ActError(
    `The app's rules refused the change at ${action.type}: ${(err instanceof Error ? err.message : String(err)).slice(0, 200)}`,
    409,
  );

export interface ActBoard {
  clientId: string;
  state: RootState;
  reducer: (state: RootState, action: Action) => RootState;
  archive: ArchiveReader;
}

export const act = async (
  board: ActBoard,
  name: string,
  rawInput: unknown,
  when: ActionWhen,
): Promise<AppRulesActResult> => {
  if (!isActionName(name)) throw new ActError(`No such action: ${name}`, 404);
  const parsed = ACTION_INPUTS[name].safeParse(rawInput ?? {});
  if (!parsed.success) {
    throw new ActError(
      'The input is not valid for this action.',
      400,
      inputErrorsOf(parsed.error),
    );
  }
  return withCallerClock(callerNowOf(when, board.state), () =>
    build(board, name, parsed.data),
  );
};

const build = async (
  board: ActBoard,
  name: Parameters<typeof buildAction>[0],
  input: Parameters<typeof buildAction>[2],
): Promise<AppRulesActResult> => {
  let state = board.state;
  // The day a browser would count as today at this moment, as the app sets it before acting.
  const dayChange = logicalDayChange(state, Date.now());
  if (dayChange) state = board.reducer(state, dayChange);

  let built;
  try {
    built = buildAction(name, state, input);
  } catch (err) {
    if (err instanceof ActionInputError) throw new ActError(err.message, err.statusCode);
    throw err;
  }

  const state$ = new BehaviorSubject<RootState>(state);
  const actions$ = new Subject<Action>();
  const saved: PersistentAction[] = [];
  const queue: Action[] = [];
  let draining = false;
  let failure: unknown = null;
  let dispatched = 0;
  // FIFO, as the app's store: an action a follow-up dispatches is reduced once the one it follows has reached every listener.
  const dispatch = (action: Action): void => {
    queue.push(action);
    if (draining) return;
    draining = true;
    try {
      while (queue.length > 0 && failure === null) {
        const next = queue.shift() as Action;
        dispatched++;
        try {
          state = board.reducer(state, next);
        } catch (err) {
          failure = reducerFailure(next, err);
          break;
        }
        if (isPersistentAction(next) && !next.meta.isRemote) saved.push(next);
        state$.next(state);
        actions$.next(next);
      }
    } finally {
      draining = false;
    }
  };

  const store = new HeadlessStore(state$, dispatch);
  const injector = Injector.create({
    providers: [
      { provide: INJECTOR_SCOPE, useValue: 'root' },
      { provide: Store, useValue: store },
      { provide: LOCAL_ACTIONS, useValue: actions$ as Observable<Action> },
      { provide: ArchiveStoreService, useValue: readOnlyArchive(board.archive) },
      { provide: MatDialog, useClass: HeadlessMatDialog },
      { provide: WorkContextService, useClass: HeadlessWorkContextService },
      {
        provide: GlobalTrackingIntervalService,
        useFactory: (dateService: DateService) =>
          new HeadlessTrackingInterval(dateService),
        deps: [DateService],
      },
      {
        provide: TaskService,
        useFactory: (archive: TaskArchiveService) =>
          new HeadlessTaskService(store, archive),
        deps: [TaskArchiveService],
      },
      ...FOLLOW_UP_EFFECTS.map((effects) => ({ provide: effects, useClass: effects })),
    ],
  });
  const misc = normalizeStartOfNextDayConfig(selectMiscConfig(state as never));
  injector
    .get(DateService)
    .setStartOfNextDayDiff(misc.startOfNextDayTime, misc.startOfNextDay);
  const capture = injector.get(OperationCaptureService);
  setOperationCaptureService(capture);

  const subscriptions: Subscription[] = [];
  for (const effectsClass of FOLLOW_UP_EFFECTS) {
    const instance = injector.get(effectsClass) as Record<string, Observable<unknown>>;
    for (const [propertyName, config] of Object.entries(getEffectsMetadata(instance))) {
      const dispatches = config?.dispatch !== false;
      subscriptions.push(
        (instance[propertyName] as Observable<unknown>).subscribe({
          next: (out) => {
            if (dispatches) dispatch(out as Action);
          },
          error: (err: unknown) => {
            failure ??=
              err instanceof ActError
                ? err
                : new ActError(
                    `The follow-up ${effectsClass.name}.${String(propertyName)} failed: ${(err instanceof Error ? err.message : String(err)).slice(0, 200)}`,
                    (err as { statusCode?: number }).statusCode ?? 500,
                  );
          },
        }),
      );
    }
  }

  try {
    for (const action of built.actions) dispatch(action);
    // Some follow-ups read the archive first; wait until a round passes with nothing new.
    let seen = -1;
    for (let round = 0; round < SETTLE_ROUNDS && seen !== dispatched; round++) {
      seen = dispatched;
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
  } finally {
    subscriptions.forEach((s) => s.unsubscribe());
    saved.forEach((action) => capture.decrementPending(action));
  }
  if (failure !== null) throw failure;

  const validationStart = realNow();
  const snapshot = injector.get(StateSnapshotService);
  const after = await snapshot.getStateSnapshotAsync();
  const result = validateFull(after as unknown as AppDataComplete);
  if (!result.isValid) {
    // A board that was already invalid there stays writable: only what this change breaks refuses it.
    state$.next(board.state);
    const before = validateFull(
      (await snapshot.getStateSnapshotAsync()) as unknown as AppDataComplete,
    );
    const known = new Set(before.isValid ? [] : validationErrorsOf(before));
    const added = validationErrorsOf(result).filter((e) => !known.has(e));
    if (added.length > 0) {
      throw new ActError(
        "The change would leave the board invalid by the app's validation.",
        409,
        added,
      );
    }
  }
  const validationMs = realNow() - validationStart;

  const timestamp = realNow();
  const ops: BuiltOp[] = [];
  for (const action of saved) {
    const { op, validation } = operationFromAction(action, {
      id: uuidv7(),
      clientId: board.clientId,
      vectorClock: {},
      timestamp,
      entityChanges: capture.extractEntityChanges(action),
    });
    if (!validation.success) {
      throw new ActError(
        `The app built an invalid change for ${action.type}: ${validation.error}`,
        500,
      );
    }
    const wire = syncOpFromOperation(op);
    if (wire === null) continue;
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    const { id, clientId, vectorClock, ...rest } = wire;
    ops.push(rest as BuiltOp);
  }
  return { ops, refs: built.refs, validationMs };
};
