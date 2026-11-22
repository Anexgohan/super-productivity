/** Whole-board export and import through the API. An import saves the board to a file first and uploads nothing unless that save succeeded. */
import { createHash } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import type { AppRulesImportCheck, AppRulesImportCounts } from './app-rules-protocol';
import type { ImportFile } from './import-check';
import type { ImportIdentity, StateStore } from './state-store';
import { isOutcomeUnknown } from './sync-client';

export const PRE_IMPORT_DIR = 'pre-import';
export const KEEP_SAVED_PER_BOARD = 3;
export const IMPORT_BODY_LIMIT_BYTES = 30 * 1024 * 1024;

export interface ImportResult {
  imported: true;
  serverSeq: number | null;
  /** The file this import saved the board to first; `?saved=<name>` imports it back. */
  savedBefore: string;
  migratedLegacy: boolean;
  repaired: boolean;
  counts: AppRulesImportCounts;
  /** Changes that reached the server after the board was saved; the import wiped them and the saved file lacks them. */
  droppedServerChanges: number | null;
  /** False when the board could not read the import back yet; API writes to it wait until it has. */
  readBack: boolean;
}

/** An import refusal with its status; `details` joins the error body. */
export class ImportError extends Error {
  constructor(
    readonly statusCode: number,
    message: string,
    readonly details: Record<string, unknown> = {},
  ) {
    super(message);
  }
}

const SAVED_NAME =
  /^pre-import\.(container|user-\d+)\.\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}\.\d{3}Z\.json$/;

export const savedFileName = (board: string, at: Date): string =>
  `pre-import.${board}.${at.toISOString().replace(/:/g, '-')}.json`;

/** The saved files of one board, oldest first. */
export const savedFilesOf = (dataDir: string, board: string): string[] => {
  const dir = join(dataDir, PRE_IMPORT_DIR);
  if (!existsSync(dir)) return [];
  const prefix = `pre-import.${board}.`;
  return readdirSync(dir)
    .filter((name) => name.startsWith(prefix) && SAVED_NAME.test(name))
    .sort();
};

/** Deletes all but the newest `keep` saved files of one board, and never the one an unsettled import names. */
export const pruneSavedFiles = (
  dataDir: string,
  board: string,
  keep = KEEP_SAVED_PER_BOARD,
): void => {
  const spare = readUnsettled(dataDir, board)?.savedBefore;
  const files = savedFilesOf(dataDir, board).filter((name) => name !== spare);
  for (const name of files.slice(0, Math.max(0, files.length - keep))) {
    rmSync(join(dataDir, PRE_IMPORT_DIR, name), { force: true });
  }
};

/** An import whose upload got no answer: what a retry of the same file needs to be the same op to the server. */
interface UnsettledImport extends ImportIdentity {
  bodySha256: string;
  savedBefore: string;
  savedSeq: number;
}

const unsettledPath = (dataDir: string, board: string): string =>
  join(dataDir, PRE_IMPORT_DIR, `unsettled.${board}.json`);

const readUnsettled = (dataDir: string, board: string): UnsettledImport | null => {
  try {
    return JSON.parse(readFileSync(unsettledPath(dataDir, board), 'utf8'));
  } catch {
    return null;
  }
};

const writeUnsettled = (dataDir: string, board: string, u: UnsettledImport): void => {
  const path = unsettledPath(dataDir, board);
  writeFileSync(`${path}.tmp`, JSON.stringify(u));
  renameSync(`${path}.tmp`, path);
};

/** Reads one of this board's saved files. Only names this bridge writes are accepted, so no other path can be read. */
export const readSavedFile = (dataDir: string, board: string, name: string): Buffer => {
  if (!SAVED_NAME.test(name)) {
    throw new ImportError(
      400,
      'saved must be the name of a file an earlier import saved, like pre-import.user-2.2026-11-21T10-00-00.000Z.json.',
    );
  }
  if (
    !name.startsWith(`pre-import.${board}.`) ||
    !savedFilesOf(dataDir, board).includes(name)
  ) {
    throw new ImportError(404, `This board has no saved file named ${name}.`);
  }
  return readFileSync(join(dataDir, PRE_IMPORT_DIR, name));
};

/** The board as the app's own backup file, after a sync. */
export const exportBoard = async (store: StateStore): Promise<Buffer> => {
  await store.refresh().catch(() => undefined);
  return store.exclusive(() => store.appRules.exportBackup());
};

const NOT_READ_BACK_WRITES =
  'The import is in place on the server, but this board has not read it back yet. Try again shortly.';
const UNSETTLED_WRITES =
  'The last import got no answer from the sync server, so this board takes no writes until it has synced again. Try again shortly.';

const REFUSALS = {
  'not-json': [400, 'The body is not JSON. Send the backup file as it was saved.'],
  invalid: [
    422,
    'The backup is not valid and cannot be repaired, so nothing was imported.',
  ],
  'still-invalid': [
    422,
    'The backup was repaired but is still not valid, so nothing was imported.',
  ],
  'too-large': [
    413,
    'Checking this file needs more memory than the import check may use, so nothing was imported.',
  ],
} as const;

/** A checked import, its data sealed for the upload; the plain data is gone by then. */
type SealedCheck =
  | (Omit<Extract<AppRulesImportCheck, { accepted: true }>, 'bytes'> & {
      sealed: Uint8Array;
    })
  | Extract<AppRulesImportCheck, { accepted: false }>;

/** Each form of the file lives only until the next exists: the check takes the body, and the checked data goes once it is sealed. */
const checkAndSeal = async (
  store: StateStore,
  file: ImportFile,
): Promise<SealedCheck> => {
  const check = await store.appRules.checkImport(file);
  if (!check.accepted) return check;
  const { bytes, ...rest } = check;
  return { ...rest, sealed: await store.sealBackupImport(new Uint8Array(bytes)) };
};

/** Replaces the board with a backup file, as the app's own restore does. Takes the bytes out of `file`. */
export const importBoard = async (
  store: StateStore,
  file: ImportFile,
): Promise<ImportResult> => {
  const tag = `sp-bridge: ${store.boardName}: import`;
  if (store.appRules.blocked) {
    throw new ImportError(409, store.appRulesStatus.error ?? 'The board is blocked.');
  }
  if (!store.beginImport()) {
    throw new ImportError(409, 'Another import is running on this board.');
  }
  let result: ImportResult;
  try {
    try {
      await store.refresh();
    } catch (err) {
      throw new ImportError(
        503,
        `The board could not sync before the import, so nothing was imported: ${(err as Error).message}`,
      );
    }
    void store.state;
    if (!file.body)
      throw new ImportError(400, 'Send the backup file as the request body.');
    const bodySize = file.body.byteLength;
    const bodySha256 = createHash('sha256').update(file.body).digest('hex');
    const unsettled = readUnsettled(store.dataDir, store.boardName);
    const retry = unsettled?.bodySha256 === bodySha256 ? unsettled : null;

    result = await store.exclusive(async () => {
      let check: SealedCheck;
      try {
        check = await checkAndSeal(store, file);
      } catch (err) {
        throw new ImportError(
          503,
          `The app rules could not check the file, so nothing was imported: ${(err as Error).message}`,
        );
      }
      if (!check.accepted) {
        const [status, message] = REFUSALS[check.reason];
        throw new ImportError(status, message, { errors: check.errors });
      }

      // A retry of an import whose answer was lost keeps that attempt's save: it holds the board from before either.
      const dir = join(store.dataDir, PRE_IMPORT_DIR);
      let savedBefore: string;
      let saved: { seq: number };
      if (
        retry &&
        savedFilesOf(store.dataDir, store.boardName).includes(retry.savedBefore)
      ) {
        savedBefore = retry.savedBefore;
        saved = { seq: retry.savedSeq };
      } else {
        savedBefore = savedFileName(store.boardName, new Date());
        try {
          mkdirSync(dir, { recursive: true });
          saved = await store.appRules.exportToFile(join(dir, savedBefore));
        } catch (err) {
          throw new ImportError(
            500,
            `The board could not be saved before the import, so nothing was imported: ${(err as Error).message}`,
          );
        }
      }

      const identity = retry ?? store.newImportIdentity();
      const { sealed, schemaVersion } = check;
      // A retry sends the same sealed bytes: the same op to the server.
      const upload = (): ReturnType<StateStore['uploadBackupImport']> =>
        store.uploadBackupImport(sealed, schemaVersion, identity);
      // A refusal only says that attempt stored nothing, so once any attempt of this import got no answer, only an acceptance settles it.
      let unknown = retry !== null;
      const unknownOutcome = (reason: string): ImportError => {
        writeUnsettled(store.dataDir, store.boardName, {
          opId: identity.opId,
          vectorClock: identity.vectorClock,
          bodySha256,
          savedBefore,
          savedSeq: saved.seq,
        });
        store.closeWritesUntil(0, UNSETTLED_WRITES);
        return new ImportError(
          502,
          `It is not known whether the import landed: ${reason} ` +
            'Send the same file again to settle it: the retry is the same import to the server, so it cannot restore twice.',
          { savedBefore, outcome: 'unknown' },
        );
      };
      let res: Awaited<ReturnType<StateStore['uploadBackupImport']>>;
      try {
        res = await upload().catch((err: unknown) => {
          if (!isOutcomeUnknown(err)) throw err;
          unknown = true;
          return upload();
        });
      } catch (err) {
        if (isOutcomeUnknown(err))
          throw unknownOutcome('the sync server did not answer.');
        const e = err as {
          statusCode?: number;
          upstreamStatus?: number;
          message?: string;
        };
        const message = e.message ?? 'The upload failed.';
        if (unknown)
          throw unknownOutcome(
            `an attempt got no answer, and the next was refused (${message}).`,
          );
        throw new ImportError(
          e.statusCode ?? (e.upstreamStatus ? 502 : 500),
          `${message} The board is unchanged.`,
          { savedBefore },
        );
      }
      if (!res.accepted) {
        const message = `The sync server refused the import (${res.errorCode ?? 'refused'}: ${res.error ?? ''}).`;
        if (unknown)
          throw unknownOutcome(
            `an attempt got no answer, and the next was refused (${message})`,
          );
        throw new ImportError(409, `${message} The board is unchanged.`, {
          savedBefore,
          errorCode: res.errorCode ?? null,
        });
      }
      rmSync(unsettledPath(store.dataDir, store.boardName), { force: true });
      store.closeWritesUntil(res.serverSeq ?? 0, NOT_READ_BACK_WRITES);
      console.log(
        `${tag}: ${(bodySize / 1048576).toFixed(1)} MB in, saved as of change ${saved.seq}, ` +
          `imported at server seq ${res.serverSeq ?? '?'}`,
      );
      return {
        imported: true,
        serverSeq: res.serverSeq ?? null,
        savedBefore,
        migratedLegacy: check.migratedLegacy,
        repaired: check.repaired,
        counts: check.counts,
        droppedServerChanges:
          res.serverSeq === undefined ? null : Math.max(0, res.serverSeq - 1 - saved.seq),
        readBack: false,
      } satisfies ImportResult;
    });
  } finally {
    store.endImport();
    try {
      pruneSavedFiles(store.dataDir, store.boardName);
    } catch (err) {
      console.error(`${tag}: could not prune saved files: ${(err as Error).message}`);
    }
  }

  // The board reads its own import back, as every browser will.
  await store.refresh().catch(() => undefined);
  return { ...result, readBack: store.writesClosed === null };
};
