/**
 * The changes a browser replays to rebuild the confirmed state from the server's history, taken the way a download takes them.
 */
import { type ServerOrderedOp } from '@sp/sync-core';
import { FULL_STATE_OP_TYPES, Operation } from '../core/operation.types';
import {
  getOperationSchemaVersion,
  MIN_SUPPORTED_SCHEMA_VERSION,
  SchemaMigrationService,
} from '../persistence/schema-migration.service';
import { SyncImportFilterService } from './sync-import-filter.service';

/**
 * The history from the newest checkpoint, or from the first change, to just before the batch, with no number missing.
 * Empty when the batch starts at the first change; undefined when the history cannot give that state.
 */
export const historyBeforeBatch = (
  history: readonly ServerOrderedOp<Operation>[],
  firstBatchSeq: number,
): ServerOrderedOp<Operation>[] | undefined => {
  const before = history.filter(({ serverSeq }) => serverSeq < firstBatchSeq);
  if (before.length === 0) return firstBatchSeq === 1 ? [] : undefined;
  const startsClean =
    (FULL_STATE_OP_TYPES.has(before[0].op.opType) || before[0].serverSeq === 1) &&
    !before.slice(1).some(({ op }) => FULL_STATE_OP_TYPES.has(op.opType)) &&
    before.every(({ serverSeq }, i) => serverSeq === before[0].serverSeq + i) &&
    before[before.length - 1].serverSeq === firstBatchSeq - 1;
  return startsClean ? before : undefined;
};

/**
 * The changes as a download applies them: migrated to the current schema and without those a full import in them invalidates.
 * Undefined when one of them cannot be read by this build, as a download would stop there.
 */
export const opsAsDownloadApplies = async (
  ops: readonly Operation[],
  migration: SchemaMigrationService,
  importFilter: SyncImportFilterService,
): Promise<Operation[] | undefined> => {
  const currentVersion = migration.getCurrentVersion();
  const migrated: Operation[] = [];
  for (const op of ops) {
    try {
      const version = getOperationSchemaVersion(op as { schemaVersion?: unknown });
      if (version < MIN_SUPPORTED_SCHEMA_VERSION || version > currentVersion) {
        return undefined;
      }
      const out = migration.migrateOperation(op);
      if (Array.isArray(out)) migrated.push(...out);
      else if (out !== null) migrated.push(out);
    } catch {
      return undefined;
    }
  }
  return (await importFilter.filterOpsInvalidatedBySyncImport(migrated)).validOps;
};
