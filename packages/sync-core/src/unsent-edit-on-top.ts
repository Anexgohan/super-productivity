/**
 * anex fork, Stage 8 of the container-authority work: a browser's unsent edits go on top of what
 * the server has confirmed.
 *
 * A change downloaded from the server is confirmed: the server stored it. An edit this browser has
 * not sent yet is not. Where the two touch the same item, the result is the confirmed change with
 * the unsent edit over it, whatever the clocks of the devices say: the edit that reaches the server
 * last wins. Fields only the downloaded change touched keep its values.
 *
 * Only edits that set values qualify (the host's allow-list). Running one of them again changes
 * nothing more, so a copy that lands twice is harmless. Edits that add, such as tracked time, and
 * everything else keep the host's timestamp rule.
 *
 * Pure functions: the host supplies which edits are unsent, which action types set values, and the
 * changed fields of each side.
 */

import { isLwwUpdatePayload, OpType } from './operation.types';
import type { Operation } from './operation.types';
import type { EntityConflictLike } from './conflict-resolution';

export interface UnsentEditOnTopRules<TOperation extends Operation<string>> {
  /** Action types whose edits only set values, so running one again changes nothing more. */
  setValueActionTypes: ReadonlySet<string>;
  /**
   * Whole-item copies another browser made (its LWW Update types). They set every field, so they
   * qualify on the downloaded side; an unsent copy keeps the timestamp rule, since its full
   * snapshot would override fields the downloaded edit changed.
   */
  downloadedCopyActionTypes: ReadonlySet<string>;
  /** Ids of this client's edits the server has not confirmed yet. */
  unsentOpIds: ReadonlySet<string>;
  /** True when an op changes more than one item; such ops keep the host's timestamp rule. */
  isMultiEntity: (op: TOperation) => boolean;
}

const isSetValueEdit = <TOperation extends Operation<string>>(
  op: TOperation,
  rules: UnsentEditOnTopRules<TOperation>,
): boolean =>
  op.opType === OpType.Update &&
  rules.setValueActionTypes.has(op.actionType) &&
  !rules.isMultiEntity(op);

/**
 * A downloaded whole-item copy that only sets values: not one that brings a deleted item back or
 * moves it to another project, which need more than its fields.
 */
const isDownloadedCopy = <TOperation extends Operation<string>>(
  op: TOperation,
  rules: UnsentEditOnTopRules<TOperation>,
): boolean =>
  op.opType === OpType.Update &&
  rules.downloadedCopyActionTypes.has(op.actionType) &&
  !rules.isMultiEntity(op) &&
  isLwwUpdatePayload(op.payload) &&
  op.payload.recreatesEntityAfterDelete !== true &&
  op.payload.projectMoveFootprint === undefined;

const hasOnlyUnsentSetValueEdits = <TOperation extends Operation<string>>(
  ops: readonly TOperation[],
  rules: UnsentEditOnTopRules<TOperation>,
): boolean =>
  ops.length > 0 &&
  ops.every((op) => rules.unsentOpIds.has(op.id) && isSetValueEdit(op, rules));

/**
 * True when the conflict is unsent set-value edits against downloaded set-value edits: the unsent
 * ones go on top. A conflict whose local side is already confirmed (both sides on the server) is
 * never one: each device would keep its own side and they would never agree.
 */
export const isUnsentEditOnTopConflict = <TOperation extends Operation<string>>(
  conflict: EntityConflictLike<TOperation>,
  rules: UnsentEditOnTopRules<TOperation>,
): boolean =>
  hasOnlyUnsentSetValueEdits(conflict.localOps, rules) &&
  conflict.remoteOps.length > 0 &&
  conflict.remoteOps.every(
    (op) => isSetValueEdit(op, rules) || isDownloadedCopy(op, rules),
  );

/**
 * True when unsent set-value edits meet a downloaded delete of the same item: the edit wins and the
 * host brings the item back with it (user decision 2026-11-20: a lost edit cannot be recovered, an
 * item that comes back can be deleted again).
 */
export const isUnsentEditOverRemoteDelete = <TOperation extends Operation<string>>(
  conflict: EntityConflictLike<TOperation>,
  rules: UnsentEditOnTopRules<TOperation>,
): boolean =>
  hasOnlyUnsentSetValueEdits(conflict.localOps, rules) &&
  conflict.remoteOps.some((op) => op.opType === OpType.Delete);

/** The downloaded change's fields, with the unsent edit's fields over them. */
export const unsentEditOnTopChanges = (
  localChanges: Readonly<Record<string, unknown>>,
  remoteChanges: Readonly<Record<string, unknown>>,
): Record<string, unknown> => ({ ...remoteChanges, ...localChanges });

/**
 * The fields a whole-item copy sets: the item it carries, without its id. Undefined when the op is
 * not a copy of this item, so the host reads it its usual way.
 */
export const wholeItemCopyFields = (
  op: Operation<string>,
  entityId: string,
): Record<string, unknown> | undefined => {
  if (!isLwwUpdatePayload(op.payload)) return undefined;
  const { id, ...fields } = op.payload.actionPayload;
  if (entityId !== '*' && id !== entityId) return undefined;
  return fields;
};

/**
 * The fields one side of a conflict sets, copies read with `wholeItemCopyFields` and other edits
 * with the host's reader. Opaque when any op sets no readable field: a merged edit built without
 * it would drop that op's change.
 */
export const unsentEditOnTopFields = <TOperation extends Operation<string>>(
  ops: readonly TOperation[],
  entityId: string,
  readEdit: (op: TOperation) => Record<string, unknown>,
): { fields: Record<string, unknown>; isOpaque: boolean } => {
  const fields: Record<string, unknown> = {};
  let isOpaque = false;
  for (const op of ops) {
    if (op.opType === OpType.Delete) continue;
    const opFields = wholeItemCopyFields(op, entityId) ?? readEdit(op);
    if (Object.keys(opFields).length === 0) isOpaque = true;
    Object.assign(fields, opFields);
  }
  return { fields, isOpaque };
};

const uniqueById = <TOperation extends Operation<string>>(
  ops: readonly TOperation[],
): TOperation[] => [...new Map(ops.map((op) => [op.id, op])).values()];

/**
 * Joins the qualifying conflicts of one item into one, its downloaded edits in the order they came.
 * Conflict detection makes one conflict per downloaded edit, and a merge refuses an item with more
 * than one, so without this an item edited twice on another device would fall back to the
 * timestamp rule. Other conflicts are returned unchanged, in their place.
 */
export const joinUnsentEditOnTopConflicts = <
  TOperation extends Operation<string>,
  TConflict extends EntityConflictLike<TOperation>,
>(
  conflicts: readonly TConflict[],
  isQualifying: (conflict: TConflict) => boolean,
): TConflict[] => {
  const joined: TConflict[] = [];
  const joinedIndexByItem = new Map<string, number>();
  for (const conflict of conflicts) {
    if (!isQualifying(conflict)) {
      joined.push(conflict);
      continue;
    }
    const itemKey = `${conflict.entityType}:${conflict.entityId}`;
    const index = joinedIndexByItem.get(itemKey);
    if (index === undefined) {
      joinedIndexByItem.set(itemKey, joined.length);
      joined.push(conflict);
      continue;
    }
    const earlier = joined[index];
    joined[index] = {
      ...earlier,
      localOps: uniqueById([...earlier.localOps, ...conflict.localOps]),
      remoteOps: uniqueById([...earlier.remoteOps, ...conflict.remoteOps]),
    };
  }
  return joined;
};
