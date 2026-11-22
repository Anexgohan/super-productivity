/**
 * The wire op a browser uploads for a regular op, shared by the upload service and the container's app rules.
 * Returns null for an op that stays on this device.
 */
import { ActionType, isMultiEntityPayload, Operation } from '../core/operation.types';
import { isLwwUpdateActionType } from '../core/lww-update-action-types';
import type { SyncOperation } from '../sync-providers/provider.interface';
import {
  stripLocalOnlySyncScheduleSettings,
  stripLocalOnlySyncSettingsFromGlobalConfig,
} from '../../features/config/local-only-sync-settings.util';
import { bringsItemBack } from './server-order-delete-rule.util';

const sanitizeRegularOpPayloadForUpload = (op: Operation): unknown | null => {
  if (
    op.actionType === ActionType.TASK_SHARED_DELETE_MULTIPLE &&
    isMultiEntityPayload(op.payload)
  ) {
    const actionPayload = { ...op.payload.actionPayload };
    delete actionPayload['tasks'];
    return {
      ...op.payload,
      actionPayload,
    };
  }

  if (
    op.entityType === 'GLOBAL_CONFIG' &&
    isLwwUpdateActionType(op.actionType) &&
    typeof op.payload === 'object' &&
    op.payload !== null
  ) {
    if (isMultiEntityPayload(op.payload)) {
      return {
        ...op.payload,
        actionPayload: stripLocalOnlySyncSettingsFromGlobalConfig(
          op.payload.actionPayload,
        ),
      };
    }
    return stripLocalOnlySyncSettingsFromGlobalConfig(
      op.payload as Record<string, unknown>,
    );
  }

  if (
    op.actionType !== ActionType.GLOBAL_CONFIG_UPDATE_SECTION ||
    typeof op.payload !== 'object' ||
    op.payload === null ||
    !('actionPayload' in op.payload)
  ) {
    return op.payload;
  }

  const multiEntityPayload = op.payload as {
    actionPayload?: Record<string, unknown>;
    entityChanges?: unknown;
  };
  const actionPayload = multiEntityPayload.actionPayload;
  if (
    !actionPayload ||
    actionPayload['sectionKey'] !== 'sync' ||
    typeof actionPayload['sectionCfg'] !== 'object' ||
    actionPayload['sectionCfg'] === null
  ) {
    return op.payload;
  }

  const sectionCfg = stripLocalOnlySyncScheduleSettings(
    actionPayload['sectionCfg'] as Record<string, unknown>,
  );
  if (Object.keys(sectionCfg).length === 0) {
    // GLOBAL_CONFIG_UPDATE_SECTION replays from actionPayload; entityChanges are empty.
    return null;
  }

  return {
    ...multiEntityPayload,
    actionPayload: {
      ...actionPayload,
      sectionCfg,
    },
  };
};

export const syncOpFromOperation = (op: Operation): SyncOperation | null => {
  const payload = sanitizeRegularOpPayloadForUpload(op);
  if (payload === null) {
    return null;
  }

  return {
    id: op.id,
    clientId: op.clientId,
    actionType: op.actionType,
    opType: op.opType,
    entityType: op.entityType,
    entityId: op.entityId,
    entityIds: op.entityIds,
    payload,
    vectorClock: op.vectorClock,
    timestamp: op.timestamp,
    schemaVersion: op.schemaVersion,
    ...(op.syncImportReason ? { syncImportReason: op.syncImportReason } : {}),
    ...(op.repairBaseServerSeq !== undefined
      ? { repairBaseServerSeq: op.repairBaseServerSeq }
      : {}),
    ...(bringsItemBack(op) ? { recreatesEntityAfterDelete: true } : {}),
  };
};
