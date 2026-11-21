/**
 * Inputs for the rule that a later edit beats a delete of the same task or note, by device time (findEditsThatBeatDeletes in @sp/sync-core).
 * The downloaded deletes name only the top task, so a deleted task's subtasks are read from its payload and from the state shown.
 */
import type { ItemDelete, RemoteOperationApplyStorePort } from '@sp/sync-core';
import { extractActionPayload, Operation, OpType } from '../core/operation.types';
import { isLwwUpdateActionType } from '../core/lww-update-action-types';
import type { OperationLogStoreService } from '../persistence/operation-log-store.service';
import { Note, NoteState } from '../../features/note/note.model';
import { TaskState } from '../../features/tasks/task.model';
import { NOTE_FEATURE_NAME } from '../../features/note/store/note.reducer';
import { TASK_FEATURE_NAME } from '../../features/tasks/store/task.reducer';

const DELETED_ITEM_TYPES: ReadonlySet<string> = new Set(['TASK', 'NOTE']);

/** True for a change that recreates a task or note it finds missing. */
export const recreatesItem = (op: Operation): boolean =>
  DELETED_ITEM_TYPES.has(op.entityType) && isLwwUpdateActionType(op.actionType);

const stringsIn = (value: unknown): string[] =>
  Array.isArray(value) ? value.filter((id): id is string => typeof id === 'string') : [];

/** The tasks a delete's payload names: a single delete's subtasks, or every task a bulk delete took with its subtasks. */
const subTaskIdsIn = (payload: unknown): string[] => {
  const action = extractActionPayload(payload);
  const single = action['task'] as { subTaskIds?: unknown } | undefined;
  const bulk = (Array.isArray(action['tasks']) ? action['tasks'] : []) as (
    | { id?: unknown; subTaskIds?: unknown }
    | undefined
  )[];
  return [
    ...stringsIn(single?.subTaskIds),
    ...bulk.flatMap((task) => stringsIn([task?.id, ...stringsIn(task?.subTaskIds)])),
  ];
};

/** Every task and note the downloaded deletes removed, each with its delete's device time; a deleted task's subtasks go with it. */
export const itemsRemovedBy = (
  ops: readonly Operation[],
  shownTasks: TaskState | undefined,
): ItemDelete[] =>
  ops.flatMap((op) => {
    if (op.opType !== OpType.Delete || !DELETED_ITEM_TYPES.has(op.entityType)) return [];
    const named = [op.entityId, ...(op.entityIds ?? [])].filter(
      (id): id is string => !!id,
    );
    const ids =
      op.entityType === 'TASK'
        ? [
            ...named,
            ...subTaskIdsIn(op.payload),
            ...named.flatMap((id) => shownTasks?.entities[id]?.subTaskIds ?? []),
          ]
        : named;
    return [...new Set(ids)].map((entityId) => ({
      entityType: op.entityType,
      entityId,
      deletedAt: op.timestamp,
    }));
  });

const idsOf = (slice: unknown): ReadonlySet<string> => {
  const entities = (slice as { entities?: Record<string, unknown> } | undefined)
    ?.entities;
  return new Set(entities ? Object.keys(entities) : []);
};

/** A shown task or note that a checkpoint lacks, whose delete time the server may know. */
export interface CheckpointCandidate {
  entityType: 'TASK' | 'NOTE';
  entityId: string;
  parentId?: string;
}

/** The ids of the tasks a checkpoint holds, archived ones included. */
const tasksHeldBy = (checkpoint: Record<string, unknown>): ReadonlySet<string> => {
  const archived = (key: string): unknown =>
    (checkpoint[key] as { task?: unknown } | undefined)?.task;
  return new Set([
    ...idsOf(checkpoint['task']),
    ...idsOf(archived('archiveYoung')),
    ...idsOf(archived('archiveOld')),
  ]);
};

/** The shown tasks a checkpoint holds nowhere, so a subtask brought back can bring its parent along. */
export const tasksMissingFromCheckpoint = (
  shownTasks: TaskState | undefined,
  checkpoint: Record<string, unknown>,
): Set<string> => {
  const held = tasksHeldBy(checkpoint);
  return new Set(Object.keys(shownTasks?.entities ?? {}).filter((id) => !held.has(id)));
};

/** The tasks and notes shown now that the checkpoint holds nowhere, its archives included. */
export const itemsMissingFromCheckpoint = (
  shown: { tasks: TaskState | undefined; notes: NoteState | undefined },
  checkpoint: Record<string, unknown>,
): CheckpointCandidate[] => {
  const heldNotes = idsOf(checkpoint['note']);
  const tasks = [...tasksMissingFromCheckpoint(shown.tasks, checkpoint)].map((id) => {
    const parentId = shown.tasks?.entities[id]?.parentId;
    return {
      entityType: 'TASK' as const,
      entityId: id,
      ...(parentId ? { parentId } : {}),
    };
  });
  const notes = Object.keys(shown.notes?.entities ?? {})
    .filter((id) => !heldNotes.has(id))
    .map((id) => ({ entityType: 'NOTE' as const, entityId: id }));
  return [...tasks, ...notes];
};

/** The applied edits that show: an edit to an item the checkpoint lacks (`TYPE:id` in `missingKeys`) that did not come back changes nothing. */
export const editsShown = (
  applied: readonly Operation[],
  missingKeys: ReadonlySet<string>,
  state: Record<string, unknown>,
): Operation[] =>
  applied.filter((op) => {
    if (!missingKeys.has(`${op.entityType}:${op.entityId ?? ''}`)) return true;
    const slice = state[
      op.entityType === 'NOTE' ? NOTE_FEATURE_NAME : TASK_FEATURE_NAME
    ] as { entities?: Record<string, unknown> } | undefined;
    return !!op.entityId && !!slice?.entities?.[op.entityId];
  });

/** The note states to send back, as shown. */
export const bringBackNoteStates = (
  noteIds: Iterable<string>,
  shownNotes: NoteState | undefined,
): Note[] =>
  [...noteIds]
    .map((id) => shownNotes?.entities[id])
    .filter((note): note is Note => note !== undefined);

/** The change log as the remote-apply store, able to log this browser's own saves right after the remote ops in one write. */
export const remoteThenLocalStore = (
  store: OperationLogStoreService,
): RemoteOperationApplyStorePort<Operation> => ({
  appendBatchSkipDuplicates: (ops, source, options) =>
    store.appendBatchSkipDuplicates(ops, source, options),
  mergeRemoteOpClocks: (ops) => store.mergeRemoteOpClocks(ops),
  markReducersCommittedAndMergeClocks: (seqs, ops, rejectedOpIds) =>
    store.markReducersCommittedAndMergeClocks(seqs, ops, rejectedOpIds),
  markApplied: (seqs) => store.markApplied(seqs),
  markFailed: (opIds) => store.markFailed(opIds),
  clearFullStateOpsExcept: (excludeIds) => store.clearFullStateOpsExcept(excludeIds),
  appendRemoteThenLocalSkipDuplicates: async (remoteOps, localOps, options) => {
    const { written } = await store.appendMixedSourceBatchSkipDuplicates([
      { ops: remoteOps, source: 'remote', options },
      { ops: localOps, source: 'local' },
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
  },
});
