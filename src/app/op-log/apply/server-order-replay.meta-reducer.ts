/**
 * anex fork, Stage 9: a browser follows the server's order.
 *
 * One reducer pass that goes back to the state the server confirmed, applies the downloaded changes and this browser's
 * accepted changes by their server numbers, keeps that as the new confirmed state, and applies the changes the server
 * has not placed yet on top. Local-only state and edits made while the download was being applied are kept from the
 * state shown (server-order-local-state.util.ts). The plan comes from planServerOrderApply in @sp/sync-core.
 *
 * Runs inside the operation capture (it is no user change) and outside the bulk apply, which it uses for both passes.
 * A bulk apply marked keepsLocalOnlyState (a checkpoint) keeps the local-only state the same way.
 * The edits made while it applies are applied again once the unsent edits are on top (reapplyEditsReplacedByCheckpoint).
 */
import { Action, ActionReducer, createAction, props } from '@ngrx/store';
import { Operation } from '../core/operation.types';
import { getDeferredActions } from '../capture/operation-capture.meta-reducer';
import { bulkApplyOperations } from './bulk-hydration.action';
import { runWithBulkReplayFailureFilter } from './bulk-replay-failure-collector';
import {
  keepLocalOnlyState,
  NO_UNSAVED_LOCAL_TIME,
  UnsavedLocalTime,
} from './server-order-local-state.util';

export const serverOrderReplay = createAction(
  '[OperationLog] Replay In Server Order',
  props<{
    /** The state the server confirmed. */
    confirmed: object;
    /** Changes in server order: the downloaded ones and this browser's accepted ones up to the last downloaded. */
    ordered: Operation[];
    /** This browser's changes the server has not placed yet, in the order they were made. */
    onTop: Operation[];
    /** The downloaded changes: only their failures count as failures of this batch. */
    downloadedOpIds: string[];
    localClientId?: string;
  }>(),
);

/**
 * Computes the confirmed state from the server's history (the newest checkpoint and the changes after it) without
 * touching the state shown; read it with takeReplayedConfirmedState. Failures of old changes are not this batch's.
 */
export const serverOrderRebuild = createAction(
  '[OperationLog] Rebuild Confirmed State',
  props<{ ops: Operation[]; localClientId?: string }>(),
);

/** Applies again the edits made while a checkpoint was applied, which it replaced; dispatched after the unsent edits go on top. */
export const reapplyEditsReplacedByCheckpoint = createAction(
  '[OperationLog] Reapply Edits Replaced By Checkpoint',
);

/** The changes a dispatched bulk apply or server-order replay applies to the state shown, for effects that react to them. */
export const opsAppliedBy = (action: Action): Operation[] => {
  if (action.type === bulkApplyOperations.type) {
    return (action as ReturnType<typeof bulkApplyOperations>).operations;
  }
  if (action.type === serverOrderReplay.type) {
    const { ordered, onTop } = action as ReturnType<typeof serverOrderReplay>;
    return [...ordered, ...onTop];
  }
  return [];
};

const REBUILD_INITIAL_STATE = { type: '[OperationLog] Rebuild Confirmed State: initial' };

let unsavedLocalTimeSource: () => UnsavedLocalTime = () => NO_UNSAVED_LOCAL_TIME;
let lastConfirmedState: object | undefined;
let editsReplacedByCheckpoint: Action[] = [];

/** Where the replay reads the time tracked but not saved as a change yet; set by ServerOrderService. */
export const setUnsavedLocalTimeSource = (source: () => UnsavedLocalTime): void => {
  unsavedLocalTimeSource = source;
};

/** The confirmed state the last replay computed, handed out once. */
export const takeReplayedConfirmedState = (): object | undefined => {
  const state = lastConfirmedState;
  lastConfirmedState = undefined;
  return state;
};

export const serverOrderReplayMetaReducer = <S>(
  reducer: ActionReducer<S>,
): ActionReducer<S> => {
  return (state: S | undefined, action: Action): S => {
    if (action.type === serverOrderRebuild.type && state !== undefined) {
      const { ops, localClientId } = action as ReturnType<typeof serverOrderRebuild>;
      lastConfirmedState = runWithBulkReplayFailureFilter(
        () => false,
        () =>
          reducer(
            reducer(undefined, REBUILD_INITIAL_STATE),
            bulkApplyOperations({ operations: ops, localClientId }),
          ),
      ) as object;
      return state;
    }
    if (
      action.type === bulkApplyOperations.type &&
      (action as ReturnType<typeof bulkApplyOperations>).keepsLocalOnlyState &&
      state !== undefined
    ) {
      // These ran on the state the checkpoint replaces; they are saved after it, so they belong on top of it.
      editsReplacedByCheckpoint = getDeferredActions();
      return keepLocalOnlyState(
        reducer(state, action) as object,
        state as object,
        unsavedLocalTimeSource(),
      ) as S;
    }
    if (action.type === reapplyEditsReplacedByCheckpoint.type && state !== undefined) {
      const edits = editsReplacedByCheckpoint;
      editsReplacedByCheckpoint = [];
      return edits.reduce<S>((shown, edit) => reducer(shown, edit), state);
    }
    if (action.type !== serverOrderReplay.type || state === undefined) {
      return reducer(state, action);
    }
    const { confirmed, ordered, onTop, downloadedOpIds, localClientId } =
      action as ReturnType<typeof serverOrderReplay>;
    const downloaded = new Set(downloadedOpIds);

    const { confirmedNext, replayed } = runWithBulkReplayFailureFilter(
      (op) => downloaded.has(op.id),
      () => {
        const next = reducer(
          confirmed as S,
          bulkApplyOperations({ operations: ordered, localClientId }),
        );
        return {
          confirmedNext: next,
          replayed:
            onTop.length > 0
              ? reducer(next, bulkApplyOperations({ operations: onTop, localClientId }))
              : next,
        };
      },
    );
    lastConfirmedState = confirmedNext as object;

    // Edits made while the download was applied are already shown and saved after it; they belong on top too.
    let shown = keepLocalOnlyState(
      replayed as object,
      state as object,
      unsavedLocalTimeSource(),
    ) as S;
    for (const deferred of getDeferredActions()) {
      shown = reducer(shown, deferred);
    }
    return shown;
  };
};
