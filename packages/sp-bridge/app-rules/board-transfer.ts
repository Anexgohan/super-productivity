/** Export and import checks with the app's own code: its backup steps, validation again after a repair, device-only sync settings stripped. */
import {
  CROSS_MODEL_VERSION,
  type AppDataComplete,
} from '../../../src/app/op-log/model/model-config';
import {
  BackupNotRepairableError,
  prepareBackupForImport,
} from '../../../src/app/op-log/backup/prepare-backup-import.util';
import {
  validateFull,
  type FullValidationResult,
} from '../../../src/app/op-log/validation/validation-fn';
import { assertValidFullStatePayload } from '../../../src/app/op-log/core/operation.types';
import { stripLocalOnlySyncSettingsFromAppData } from '../../../src/app/features/config/local-only-sync-settings.util';
import { CURRENT_SCHEMA_VERSION } from '../../../src/app/op-log/persistence/schema-migration.service';
import type {
  AppRulesImportCheck,
  AppRulesImportCounts,
} from '../src/app-rules-protocol';

/** Paths and expected types from a failed validation, never the values. */
export const validationErrorsOf = (result: FullValidationResult): string[] => {
  const errors: string[] = [];
  if (!result.typiaResult.success) {
    for (const e of result.typiaResult.errors.slice(0, 20))
      errors.push(`${e.path}: expected ${e.expected}`);
  }
  if (result.crossModelError)
    errors.push(`cross-model: ${result.crossModelError.slice(0, 300)}`);
  return errors;
};

/** A transferable buffer holding exactly these bytes. */
const ownBuffer = (bytes: Uint8Array): ArrayBuffer =>
  bytes.byteOffset === 0 &&
  bytes.byteLength === bytes.buffer.byteLength &&
  bytes.buffer instanceof ArrayBuffer
    ? bytes.buffer
    : new Uint8Array(bytes).buffer;

const encodeJson = (value: unknown): ArrayBuffer =>
  ownBuffer(new TextEncoder().encode(JSON.stringify(value)));

const idCount = (model: unknown): number => {
  const ids = (model as { ids?: unknown } | null | undefined)?.ids;
  return Array.isArray(ids) ? ids.length : 0;
};

const countsOf = (data: AppDataComplete): AppRulesImportCounts => ({
  tasks: idCount(data.task),
  projects: idCount(data.project),
  tags: idCount(data.tag),
  notes: idCount(data.note),
  archivedTasks: idCount(data.archiveYoung?.task) + idCount(data.archiveOld?.task),
});

/** The app's backup file (`{timestamp, lastUpdate, crossModelVersion, data}`), as the app's own download writes it. */
export const encodeBackup = (appData: Record<string, unknown>): ArrayBuffer => {
  const now = Date.now();
  return encodeJson({
    timestamp: now,
    lastUpdate: now,
    crossModelVersion: CROSS_MODEL_VERSION,
    data: appData,
  });
};

const refused = (
  reason: 'not-json' | 'invalid' | 'still-invalid',
  errors: string[],
): CheckedImport => ({ accepted: false, reason, errors });

const messageOf = (err: unknown): string =>
  (err instanceof Error ? err.message : String(err)).slice(0, 200);

/** A checked import as the check process has it: the data to upload as compact JSON text, or why it was refused. */
export type CheckedImport =
  | (Omit<Extract<AppRulesImportCheck, { accepted: true }>, 'bytes'> & { json: string })
  | Extract<AppRulesImportCheck, { accepted: false }>;

/** Checks a backup file's text, wrapped or bare, for an import. Runs only in the import check process (import-check.ts). */
export const checkImport = async (file: {
  text: string | null;
}): Promise<CheckedImport> => {
  let parsed: unknown;
  try {
    parsed = JSON.parse(file.text ?? '');
  } catch {
    return refused('not-json', []);
  } finally {
    // The text can be twice the file's size; the checks after the parse never need it.
    file.text = null;
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    return refused('invalid', ['(root): expected an object']);
  }

  let prepared: Awaited<ReturnType<typeof prepareBackupForImport>>;
  try {
    prepared = await prepareBackupForImport(parsed as AppDataComplete);
  } catch (err) {
    return refused(
      'invalid',
      err instanceof BackupNotRepairableError
        ? validationErrorsOf(err.validation)
        : [`repair failed: ${messageOf(err)}`],
    );
  }
  parsed = null;

  if (prepared.repaired) {
    const again = validateFull(prepared.data);
    if (!again.isValid) return refused('still-invalid', validationErrorsOf(again));
  }
  try {
    assertValidFullStatePayload(prepared.data, 'import');
  } catch (err) {
    return refused('invalid', [messageOf(err)]);
  }

  return {
    accepted: true,
    json: JSON.stringify(stripLocalOnlySyncSettingsFromAppData(prepared.data)),
    migratedLegacy: prepared.migratedLegacy,
    repaired: prepared.repaired,
    counts: countsOf(prepared.data),
    schemaVersion: CURRENT_SCHEMA_VERSION,
  };
};
