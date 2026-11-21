import { editsNotInCheckpoint, type RemoteOperationApplyStorePort } from '@sp/sync-core';
import {
  FULL_STATE_OP_TYPES,
  Operation,
  OperationLogEntry,
} from '../core/operation.types';
import type { OperationLogStoreService } from '../persistence/operation-log-store.service';
import { remoteThenLocalStore } from './server-order-delete-rule.util';

/**
 * This browser's unsent edits the checkpoint apply puts on top: those the newest checkpoint lacks by the server's stored numbers.
 * Read before the checkpoint is logged, so the "bring it back" saves logged with it are not among them.
 */
export const unsentEditsNotInCheckpoint = ({
  unsynced,
  checkpointOps,
  discardablePendingOpIds,
  ownServerSeq,
}: {
  unsynced: readonly OperationLogEntry[];
  checkpointOps: readonly Operation[];
  discardablePendingOpIds: readonly string[];
  ownServerSeq: (opId: string) => number | undefined;
}): Operation[] => {
  const fullStateOps = checkpointOps.filter((op) => FULL_STATE_OP_TYPES.has(op.opType));
  const discardable = new Set(discardablePendingOpIds);
  return editsNotInCheckpoint({
    unsent: unsynced
      .filter(
        (entry) =>
          entry.source === 'local' &&
          !discardable.has(entry.op.id) &&
          !FULL_STATE_OP_TYPES.has(entry.op.opType),
      )
      .map((entry) => entry.op),
    checkpointBaseSeq: fullStateOps[fullStateOps.length - 1]?.repairBaseServerSeq ?? 0,
    ownServerSeq,
  });
};

/**
 * The change log as the remote-apply store for a checkpoint.
 * One write logs the checkpoint with the ids of the edits its apply puts on top, then this browser's "bring it back" saves.
 * No crash can leave the checkpoint logged without that record.
 */
export const checkpointApplyStore = (
  store: OperationLogStoreService,
  unsentOnTopOpIds: readonly string[],
): RemoteOperationApplyStorePort<Operation> => {
  const append = async (
    remoteOps: Operation[],
    localOps: Operation[],
    options: { pendingApply: true },
  ): Promise<{
    seqs: number[];
    writtenOps: Operation[];
    skippedCount: number;
    localOps: Operation[];
  }> => {
    const { written } = await store.appendMixedSourceBatchSkipDuplicates([
      { ops: remoteOps, source: 'remote', options: { ...options, unsentOnTopOpIds } },
      ...(localOps.length > 0 ? [{ ops: localOps, source: 'local' as const }] : []),
    ]);
    const remote = written.filter((entry) => entry.source === 'remote');
    return {
      seqs: remote.map((entry) => entry.seq),
      writtenOps: remote.map((entry) => entry.op),
      skippedCount: remoteOps.length - remote.length,
      localOps: written
        .filter((entry) => entry.source === 'local')
        .map((entry) => entry.op),
    };
  };
  return {
    ...remoteThenLocalStore(store),
    appendBatchSkipDuplicates: (ops, _source, options) => append(ops, [], options),
    appendRemoteThenLocalSkipDuplicates: append,
  };
};
