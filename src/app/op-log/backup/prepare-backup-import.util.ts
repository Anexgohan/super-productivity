import { isDataRepairPossible } from '../validation/is-data-repair-possible.util';
import { recordCriticalErrorTime } from '../../util/critical-error-signal';
import { OpLog } from '../../core/log';
import { AppDataComplete, AllModelConfig } from '../model/model-config';
import { CompleteBackup } from '../core/types/sync.types';
import { normalizeGlobalConfigStartOfNextDay } from '../../features/config/normalize-start-of-next-day-config';
import type { FullValidationResult } from '../validation/validation-fn';

export interface PreparedBackupImport {
  data: AppDataComplete;
  migratedLegacy: boolean;
  repaired: boolean;
  /** The validation of the data before any repair. */
  validation: FullValidationResult;
}

/** Thrown when a backup is invalid and cannot be repaired; carries the failed validation. */
export class BackupNotRepairableError extends Error {
  constructor(readonly validation: FullValidationResult) {
    super('Data validation failed and repair not possible');
  }
}

/** What every backup import runs before it replaces any state: unwrap, upgrade legacy files, validate, repair. Shared with the container's API. */
export const prepareBackupForImport = async (
  data: AppDataComplete | CompleteBackup<AllModelConfig>,
): Promise<PreparedBackupImport> => {
  // 1. Normalize backup structure
  let backupData: AppDataComplete;

  if ('crossModelVersion' in data && 'timestamp' in data && 'data' in data) {
    backupData = data.data;
  } else {
    backupData = data as AppDataComplete;
  }

  // 2. Migrate legacy backups (pre-v14) that have the old data shape
  const { isLegacyBackupData, migrateLegacyBackup } =
    await import('./migrate-legacy-backup');
  const migratedLegacy = isLegacyBackupData(
    backupData as unknown as Record<string, unknown>,
  );
  if (migratedLegacy) {
    OpLog.normal('BackupService: Detected legacy backup format, running migration...');
    backupData = migrateLegacyBackup(backupData as unknown as Record<string, unknown>);
  }

  const normalizedGlobalConfig = normalizeGlobalConfigStartOfNextDay(
    backupData.globalConfig,
  );
  if (normalizedGlobalConfig) {
    backupData = {
      ...backupData,
      globalConfig: normalizedGlobalConfig,
    };
  }

  // 3. Validate data
  const { validateFull } = await import('../validation/validation-fn');
  const validationResult = validateFull(backupData);
  let validatedData = backupData;

  if (!validationResult.isValid) {
    // Damaged backup data — hold off the rating prompt.
    recordCriticalErrorTime();
    // Try to repair
    OpLog.normal('BackupService: Validation failed, attempting repair...', {
      success: validationResult.typiaResult.success,
      errors:
        'errors' in validationResult.typiaResult
          ? validationResult.typiaResult.errors.length
          : 0,
      hasArchiveYoung: !!backupData.archiveYoung,
      hasArchiveOld: !!backupData.archiveOld,
    });
    if (isDataRepairPossible(backupData)) {
      const errors =
        'errors' in validationResult.typiaResult
          ? validationResult.typiaResult.errors
          : [];
      const { dataRepair } = await import('../validation/data-repair');
      validatedData = dataRepair(backupData, errors).data;
    } else {
      throw new BackupNotRepairableError(validationResult);
    }
  }

  return {
    data: validatedData,
    migratedLegacy,
    repaired: !validationResult.isValid,
    validation: validationResult,
  };
};
