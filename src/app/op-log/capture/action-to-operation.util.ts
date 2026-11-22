/**
 * The op a browser saves for a persistent action, shared by the op-log effect and the container's app rules.
 */
import {
  ActionType,
  EntityChange,
  MultiEntityPayload,
  Operation,
  VectorClock,
} from '../core/operation.types';
import { PersistentAction } from '../core/persistent-action.interface';
import { CURRENT_SCHEMA_VERSION } from '../persistence/schema-migration.service';
import {
  PayloadValidationResult,
  validateOperationPayload,
} from '../validation/validate-operation-payload';

/** What the caller decides for the op: identity, clock and time are its own, the rest follows from the action. */
export interface OperationEnvelope {
  id: string;
  clientId: string;
  vectorClock: VectorClock;
  timestamp: number;
  entityChanges: EntityChange[];
}

// Validate that at least one entity identifier exists for non-bulk operations
// Bulk operations with entityType 'ALL' don't need specific entity IDs
// This catches programming errors early - all persistent actions must have entity identifiers
// Also validates entityId is not empty/whitespace to match server-side validation
export const hasValidEntityIdentifiers = (action: PersistentAction): boolean => {
  const isBulkAllOperation = action.meta.entityType === 'ALL';
  const hasValidEntityId =
    action.meta.entityId &&
    typeof action.meta.entityId === 'string' &&
    action.meta.entityId.trim().length > 0;
  const hasValidEntityIds =
    action.meta.entityIds?.length &&
    action.meta.entityIds.every(
      (id: unknown) => id && typeof id === 'string' && (id as string).trim().length > 0,
    );
  return !!(isBulkAllOperation || hasValidEntityId || hasValidEntityIds);
};

export const addReplayDateFieldsToActionPayload = (
  action: PersistentAction,
  actionPayload: Record<string, unknown>,
  operationTimestamp: number,
): Record<string, unknown> => {
  if (action.type !== ActionType.TASK_SHARED_UPDATE) {
    return actionPayload;
  }

  const task = actionPayload['task'];
  if (typeof task !== 'object' || task === null) {
    return actionPayload;
  }

  const taskUpdate = task as Record<string, unknown>;
  const changes = taskUpdate['changes'];
  if (typeof changes !== 'object' || changes === null) {
    return actionPayload;
  }

  const taskChanges = changes as Record<string, unknown>;
  if (taskChanges['isDone'] !== true) {
    return actionPayload;
  }

  return {
    ...actionPayload,
    task: {
      ...taskUpdate,
      changes: {
        ...taskChanges,
        doneOn:
          typeof taskChanges['doneOn'] === 'number'
            ? taskChanges['doneOn']
            : operationTimestamp,
      },
    },
  };
};

export const operationFromAction = (
  action: PersistentAction,
  envelope: OperationEnvelope,
): { op: Operation; validation: PayloadValidationResult } => {
  // Extract payload (everything except type and meta)
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  const { type, meta, ...rawActionPayload } = action;

  const actionPayload = addReplayDateFieldsToActionPayload(
    action,
    rawActionPayload,
    envelope.timestamp,
  );

  // Create multi-entity payload with action payload and computed changes
  const multiEntityPayload: MultiEntityPayload = {
    actionPayload: actionPayload as Record<string, unknown>,
    entityChanges: envelope.entityChanges,
  };

  // For bulk operations, entityIds is provided but entityId may not be.
  // The server requires entityId for non-full-state operations.
  // Use the first entityId from the array as the primary entityId if not explicitly set.
  const entityIds =
    action.meta.entityIds ?? (action.meta.entityId ? [action.meta.entityId] : undefined);
  const entityId = action.meta.entityId ?? entityIds?.[0];

  const op: Operation = {
    id: envelope.id,
    // NgRx action.type is string, but it matches ActionType enum values
    actionType: action.type as ActionType,
    // Use the action's declared opType from meta. We don't derive from entity changes because
    // some operations have different semantic meaning than their state changes suggest.
    // E.g., moveToArchive is UPDATE (tasks moved, not deleted) but shows as DELETE in state.
    opType: action.meta.opType,
    entityType: action.meta.entityType,
    entityId,
    entityIds,
    payload: multiEntityPayload,
    clientId: envelope.clientId,
    vectorClock: envelope.vectorClock,
    timestamp: envelope.timestamp,
    schemaVersion: CURRENT_SCHEMA_VERSION,
  };

  // CHECKPOINT A: Validate payload before persisting
  return { op, validation: validateOperationPayload(op) };
};
