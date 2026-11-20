import { inject, Injectable } from '@angular/core';
import {
  getPayloadKey,
  isUnsentEditOnTopConflict,
  isUnsentEditOverRemoteDelete,
  joinUnsentEditOnTopConflicts,
  unsentEditOnTopFields,
  UnsentEditOnTopRules,
} from '@sp/sync-core';
import { ENTITY_REGISTRY } from '../core/entity-registry';
import { toLwwUpdateActionType } from '../core/lww-update-action-types';
import { ActionType, EntityConflict, Operation } from '../core/operation.types';
import { OperationLogStoreService } from '../persistence/operation-log-store.service';
import { isMultiEntityOperation } from '../util/get-op-entity-ids.util';
import { mergeChangedFields } from './conflict-disjoint-merge.util';

/**
 * Edits that only set values, so running one again changes nothing more (user decision
 * 2026-11-20: an allow-list; every other type keeps the timestamp rule until it is checked).
 */
const SET_VALUE_ACTION_TYPES: ReadonlySet<string> = new Set<string>([
  ActionType.TASK_SHARED_UPDATE,
  ActionType.PROJECT_UPDATE,
  ActionType.TAG_UPDATE,
]);

/**
 * Whole-item copies of the same item types, made by another browser after a refused upload (user
 * decision 2026-11-20, Stage 8 Step 4). Taken on the downloaded side only.
 */
const DOWNLOADED_COPY_ACTION_TYPES: ReadonlySet<string> = new Set<string>([
  toLwwUpdateActionType('TASK'),
  toLwwUpdateActionType('PROJECT'),
  toLwwUpdateActionType('TAG'),
]);

/**
 * anex fork, Stage 8 of the container-authority work: where a downloaded change meets an edit
 * this browser has not sent yet, the result is the downloaded change with the unsent edit over it
 * (see `packages/sync-core/src/unsent-edit-on-top.ts`). The conflict resolver builds that as one
 * new edit at the end of the change log, with a clock covering both sides, and marks the originals
 * replaced, as it does for a disjoint-field merge; a task deleted on another device comes back
 * with the unsent edit.
 */
@Injectable({ providedIn: 'root' })
export class UnsentEditOnTopService {
  private opLogStore = inject(OperationLogStoreService);
  private entityRegistry = inject(ENTITY_REGISTRY);

  /** Reads this browser's unsent edits once for a batch of conflicts. */
  async rulesForBatch(): Promise<UnsentEditOnTopRules<Operation>> {
    const unsent = await this.opLogStore.getUnsynced();
    return {
      setValueActionTypes: SET_VALUE_ACTION_TYPES,
      downloadedCopyActionTypes: DOWNLOADED_COPY_ACTION_TYPES,
      unsentOpIds: new Set(
        unsent.filter((entry) => entry.source === 'local').map((entry) => entry.op.id),
      ),
      isMultiEntity: isMultiEntityOperation,
    };
  }

  /**
   * True when the conflict is merged with the unsent edit on top. Refused when either side's
   * changed fields cannot be read: the merged edit carries only the fields it can read, so it
   * would drop the rest.
   */
  isOnTopMerge(
    conflict: EntityConflict,
    rules: UnsentEditOnTopRules<Operation>,
  ): boolean {
    const payloadKey =
      getPayloadKey(this.entityRegistry, conflict.entityType) ||
      conflict.entityType.toLowerCase();
    return (
      isUnsentEditOnTopConflict(conflict, rules) &&
      !this.readSide(conflict.localOps, payloadKey, conflict.entityId).isOpaque &&
      !this.readSide(conflict.remoteOps, payloadKey, conflict.entityId).isOpaque
    );
  }

  /**
   * The fields one side of an "on top" merge sets: whole-item copies read in full, other edits the
   * way the disjoint-field merge reads them. Same signature as `mergeChangedFields`.
   */
  changedFields = (
    ops: Operation[],
    payloadKey: string,
    entityId: string,
  ): Record<string, unknown> => this.readSide(ops, payloadKey, entityId).fields;

  private readSide(
    ops: Operation[],
    payloadKey: string,
    entityId: string,
  ): { fields: Record<string, unknown>; isOpaque: boolean } {
    return unsentEditOnTopFields(ops, entityId, (op) =>
      mergeChangedFields([op], payloadKey, entityId),
    );
  }

  /** A task deleted on another device comes back with this browser's unsent edit. */
  isTaskEditOverRemoteDelete(
    conflict: EntityConflict,
    rules: UnsentEditOnTopRules<Operation>,
  ): boolean {
    return (
      conflict.entityType === 'TASK' && isUnsentEditOverRemoteDelete(conflict, rules)
    );
  }

  /**
   * One conflict per item for the merged ones: conflict detection makes one per downloaded edit,
   * and the resolver refuses to merge an item with more than one.
   */
  async joinConflicts(conflicts: EntityConflict[]): Promise<EntityConflict[]> {
    if (conflicts.length < 2) return conflicts;
    const rules = await this.rulesForBatch();
    return joinUnsentEditOnTopConflicts(conflicts, (conflict) =>
      this.isOnTopMerge(conflict, rules),
    );
  }
}
