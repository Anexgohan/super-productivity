/** Prints the main process's heap cap in MB, for the image's start command to pass to `--max-old-space-size`. */
import { heapLimits } from './heap-limits';

process.stdout.write(`${heapLimits().mainMb}\n`);
