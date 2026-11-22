/**
 * Runs the import check in its own short-lived process (app-rules/import-check.ts), one file per process.
 *
 * Checking a file can need many times its size in memory, and how much depends on its shape, not only its size, so no estimate
 * beforehand is safe. Running out of memory ends a Node process outright, so the check never runs in the bridge or the app-rules
 * worker: the child has its own heap cap, and when it runs out only the child ends and the import is refused.
 */
import { spawn } from 'node:child_process';
import type { Readable, Writable } from 'node:stream';
import type { AppRulesImportCheck, ImportCheckHeader } from './app-rules-protocol';

/** The file to check. The check takes the bytes out once the process has them, so no earlier holder keeps a copy while it runs. */
export interface ImportFile {
  body: Uint8Array | null;
}

export interface ImportCheckOptions {
  /** The built check, beside the app-rules worker. */
  path: string;
  /** Heap cap of the check process. */
  heapMb?: number;
  timeoutMs?: number;
}

/** Holds a 30 MB backup's check at its peak, with room; the bridge's container cap counts it on top of the bridge itself. */
export const IMPORT_CHECK_HEAP_MB = 256;
const IMPORT_CHECK_TIMEOUT_MS = 120_000;
/** Enough of the child's stderr to recognise how it ended. */
const STDERR_TAIL_BYTES = 4096;
/** What V8 prints when a process runs out of heap. */
const OUT_OF_MEMORY = /heap out of memory|Reached heap limit|Allocation failed/;

/** The check could not run or did not finish; the import answers 503. */
export class ImportCheckUnavailableError extends Error {}

/** Splits the child's output into the header line and the checked bytes after it. */
const readResult = (
  out: Readable,
): Promise<{ header: ImportCheckHeader; bytes: Buffer | null }> =>
  new Promise((resolve, reject) => {
    let head = Buffer.alloc(0);
    let header: ImportCheckHeader | null = null;
    let bytes: Buffer | null = null;
    let filled = 0;
    const take = (chunk: Buffer): void => {
      if (header !== null) {
        if (!bytes || filled + chunk.length > bytes.length) {
          throw new Error('more bytes than announced');
        }
        chunk.copy(bytes, filled);
        filled += chunk.length;
        return;
      }
      head = Buffer.concat([head, chunk]);
      const end = head.indexOf(0x0a);
      if (end === -1) return;
      header = JSON.parse(head.subarray(0, end).toString('utf8')) as ImportCheckHeader;
      bytes =
        header.accepted && header.bytes > 0 ? Buffer.allocUnsafeSlow(header.bytes) : null;
      const rest = head.subarray(end + 1);
      head = Buffer.alloc(0);
      if (rest.length) take(rest);
    };
    out.on('data', (chunk: Buffer) => {
      try {
        take(chunk);
      } catch (err) {
        out.destroy(err as Error);
      }
    });
    out.on('error', reject);
    out.on('end', () => {
      if (header === null) return reject(new Error('no result'));
      if (bytes && filled !== bytes.length) return reject(new Error('result cut short'));
      resolve({ header, bytes });
    });
  });

/** Checks `body` for an import in a fresh process. Refuses as `too-large` when the check ran out of memory; throws when it could not run. */
export const runImportCheck = async (
  file: ImportFile,
  opts: ImportCheckOptions,
): Promise<AppRulesImportCheck> => {
  const body = file.body;
  if (!body) throw new Error('the import file was already checked');
  file.body = null;
  const heapMb = opts.heapMb ?? IMPORT_CHECK_HEAP_MB;
  // A small young generation keeps the process's memory close to its heap cap, at little cost in time.
  const flags = [`--max-old-space-size=${heapMb}`, '--max-semi-space-size=1'];
  const child = spawn(process.execPath, [...flags, opts.path], {
    stdio: ['pipe', 'inherit', 'pipe', 'pipe'],
  });
  let stderrTail = '';
  child.stderr?.on('data', (chunk: Buffer) => {
    process.stderr.write(chunk);
    stderrTail = (stderrTail + chunk.toString('utf8')).slice(-STDERR_TAIL_BYTES);
  });
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    child.kill('SIGKILL');
  }, opts.timeoutMs ?? IMPORT_CHECK_TIMEOUT_MS);

  const exited = new Promise<{
    code: number | null;
    signal: NodeJS.Signals | null;
    spawnError?: Error;
  }>((resolve) => {
    child.on('error', (spawnError) => resolve({ code: null, signal: null, spawnError }));
    child.on('exit', (code, signal) => resolve({ code, signal }));
  });
  const resultPipe = child.stdio[3] as Readable | null;
  const result = resultPipe ? readResult(resultPipe).catch(() => null) : null;
  // A child that ends before reading everything closes its stdin; how it ended is what matters, not the write.
  const stdin = child.stdin as Writable;
  stdin.on('error', () => undefined);
  stdin.end(body);

  const [{ code, signal, spawnError }, out] = await Promise.all([exited, result]);
  clearTimeout(timer);

  if (spawnError) {
    throw new ImportCheckUnavailableError(
      `the import check could not start: ${spawnError.message}`,
    );
  }
  if (timedOut) {
    throw new ImportCheckUnavailableError(
      `the import check did not finish within ${(opts.timeoutMs ?? IMPORT_CHECK_TIMEOUT_MS) / 1000}s`,
    );
  }
  // SIGKILL that the timeout did not send is the kernel ending it for memory.
  if (OUT_OF_MEMORY.test(stderrTail) || signal === 'SIGKILL') {
    console.error(
      `sp-bridge: import check: ran out of its ${heapMb} MB heap; the import is refused`,
    );
    return {
      accepted: false,
      reason: 'too-large',
      errors: [`needs more than the ${heapMb} MB the import check may use`],
    };
  }
  if (code !== 0) {
    throw new ImportCheckUnavailableError(
      `the import check stopped (${signal ?? `exit code ${code}`})`,
    );
  }
  if (!out)
    throw new ImportCheckUnavailableError('the import check gave no complete result');
  if (!out.header.accepted) return out.header;
  const bytes = out.bytes ?? Buffer.alloc(0);
  return {
    ...out.header,
    bytes:
      bytes.byteOffset === 0 && bytes.byteLength === bytes.buffer.byteLength
        ? (bytes.buffer as ArrayBuffer)
        : new Uint8Array(bytes).buffer,
  };
};
