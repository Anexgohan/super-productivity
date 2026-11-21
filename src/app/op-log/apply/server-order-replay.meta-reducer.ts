/**
 * One reducer pass puts a browser in the server's order: from the confirmed state it applies the downloaded and accepted changes by server number.
 * That result is the new confirmed state, and the changes the server has not placed yet go on top of it.
 * Local-only state and edits made while the download applied are kept from the state shown (server-order-local-state.util.ts).
 * The plan comes from planServerOrderApply in @sp/sync-core.
 * Runs inside the operation capture (it is no user change) and outside the bulk apply, which it uses for both passes.
 * A checkpoint (a bulk apply marked keepsLocalOnlyState) keeps the local-only state too; reapplyEditsReplacedByCheckpoint puts edits back on top.
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

/** After the unsent edits went on top of a checkpoint: shows the checkpoint, those edits, then every edit typed while it applied, in that order. */
export const reapplyEditsReplacedByCheckpoint = createAction(
  '[OperationLog] Reapply Edits Replaced By Checkpoint',
  props<{ onTop: Operation[] }>(),
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
let checkpointApplied: { state: object; localClientId?: string } | undefined;

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
      const checkpointState = reducer(state, action) as object;
      const { localClientId } = action as ReturnType<typeof bulkApplyOperations>;
      checkpointApplied = { state: checkpointState, localClientId };
      return keepLocalOnlyState(
        checkpointState,
        state as object,
        unsavedLocalTimeSource(),
      ) as S;
    }
    if (action.type === reapplyEditsReplacedByCheckpoint.type && state !== undefined) {
      const applied = checkpointApplied;
      checkpointApplied = undefined;
      if (!applied) return state;
      const { onTop } = action as ReturnType<typeof reapplyEditsReplacedByCheckpoint>;
      // Their failures were reported when they first went on top.
      const withOnTop = runWithBulkReplayFailureFilter(
        () => false,
        () =>
          onTop.length > 0
            ? reducer(
                applied.state as S,
                bulkApplyOperations({
                  operations: onTop,
                  localClientId: applied.localClientId,
                }),
              )
            : (applied.state as S),
      );
      // Edits typed while it applied ran on the replaced state or under the unsent edits; they are later than both.
      return getDeferredActions().reduce<S>(
        (shown, edit) => reducer(shown, edit),
        keepLocalOnlyState(
          withOnTop as object,
          state as object,
          unsavedLocalTimeSource(),
        ) as S,
      );
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
