/**
 * Import check process entry (anex/app-rules): checks one backup file and exits.
 *
 * A file can need far more memory to check than its size suggests, and running out of it ends the whole process at once. So the
 * check runs here, in a short-lived process with its own heap cap, and never in the bridge or the app-rules worker: when it runs out,
 * only this process ends. The file arrives on stdin; the result leaves on fd 3 as one JSON line, then the checked data when accepted.
 */
import './globals';
// The app's NgRx stores are partially compiled, so loading them needs Angular's compiler, as in the worker.
import '@angular/compiler';
import { createWriteStream } from 'node:fs';
import type { Writable } from 'node:stream';
import type { ImportCheckHeader } from '../src/app-rules-protocol';
import { checkImport } from './board-transfer';

/** Text pieces are written at most this long, so no copy of the whole file is made outside the heap. */
const WRITE_CHARS = 1 << 20;

const readStdin = async (): Promise<string> => {
  process.stdin.setEncoding('utf8');
  let text = '';
  for await (const chunk of process.stdin) text += chunk as string;
  return text;
};

const write = (out: Writable, piece: string): Promise<void> =>
  new Promise((resolve, reject) =>
    out.write(piece, (err) => (err ? reject(err) : resolve())),
  );

const main = async (): Promise<void> => {
  const check = await checkImport({ text: await readStdin() });
  const out = createWriteStream('', { fd: 3 });
  const header: ImportCheckHeader = check.accepted
    ? (({ json, ...rest }) => ({ ...rest, bytes: Buffer.byteLength(json) }))(check)
    : check;
  await write(out, `${JSON.stringify(header)}\n`);
  if (check.accepted) {
    const { json } = check;
    for (let i = 0; i < json.length; ) {
      let end = Math.min(i + WRITE_CHARS, json.length);
      // A piece never ends between the two halves of a character beyond U+FFFF, which would be written as two replacement characters.
      const last = json.charCodeAt(end - 1);
      if (end < json.length && last >= 0xd800 && last <= 0xdbff) end++;
      await write(out, json.slice(i, end));
      i = end;
    }
  }
  await new Promise<void>((resolve, reject) => {
    out.on('error', reject);
    out.end(resolve);
  });
};

// The error's name only: its message may quote the file.
main().catch((err: unknown) => {
  console.error(
    `sp-bridge import check: failed: ${err instanceof Error ? err.name : typeof err}`,
  );
  process.exitCode = 1;
});
