/** Export and import checks with the app's own code: its backup steps, validation again after a repair, device-only sync settings stripped. */
import { getHeapStatistics } from 'node:v8';
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

/** Heap a check takes per byte of the file at its peak, with a little room. */
const CHECK_HEAP_PER_BYTE = 4;
/** The same when a character past U+00FF makes V8 hold the whole decoded text at two bytes a character. */
const CHECK_HEAP_PER_BYTE_TWO_BYTE = 6;

/** True when the UTF-8 holds a character past U+00FF: only those start with a byte of 0xC4 or more. */
const decodesToTwoByte = (bytes: Uint8Array): boolean => {
  for (let i = 0; i < bytes.length; i++) if (bytes[i] >= 0xc4) return true;
  return false;
};

const refused = (
  reason: 'not-json' | 'invalid' | 'still-invalid' | 'too-large',
  errors: string[],
): AppRulesImportCheck => ({ accepted: false, reason, errors });

const messageOf = (err: unknown): string =>
  (err instanceof Error ? err.message : String(err)).slice(0, 200);

/** Checks a backup file, wrapped or bare, for an import; on success the data comes back as compact JSON bytes, ready to upload. */
export const checkImport = async (bytes: ArrayBuffer): Promise<AppRulesImportCheck> => {
  // In use, garbage included, so this errs towards refusing: a check the heap cannot hold would end the worker for every board.
  const heap = getHeapStatistics();
  const free = heap.heap_size_limit - heap.used_heap_size;
  const perByte = decodesToTwoByte(new Uint8Array(bytes))
    ? CHECK_HEAP_PER_BYTE_TWO_BYTE
    : CHECK_HEAP_PER_BYTE;
  const need = perByte * bytes.byteLength;
  if (need > free) {
    return refused('too-large', [
      `needs about ${Math.ceil(need / 1048576)} MB of the app rules' memory, ${Math.floor(free / 1048576)} MB is free`,
    ]);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(new TextDecoder().decode(bytes));
  } catch {
    return refused('not-json', []);
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
    bytes: encodeJson(stripLocalOnlySyncSettingsFromAppData(prepared.data)),
    migratedLegacy: prepared.migratedLegacy,
    repaired: prepared.repaired,
    counts: countsOf(prepared.data),
    schemaVersion: CURRENT_SCHEMA_VERSION,
  };
};
