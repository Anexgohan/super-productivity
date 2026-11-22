/** The bridge's two heap caps, sized from the container's memory cap (`SP_BRIDGE_MEM_LIMIT`), so that one value decides both. */
import { totalmem } from 'node:os';

/** Neither cap goes below this. */
export const MIN_HEAP_MB = 96;
/** The main process holds the API, the encryption key and one import's bytes at a time. */
const MAIN_SHARE = 0.2;
/** The rules worker holds every resident board, a whole imported board included. */
const WORKER_SHARE = 0.5;

export interface HeapLimits {
  mainMb: number;
  workerMb: number;
}

/** The caps for a container of `limitBytes`; with no container cap (0, or as large as the machine), both stay at the minimum. */
export const heapLimitsFor = (
  limitBytes: number,
  machineBytes = totalmem(),
): HeapLimits => {
  if (!(limitBytes > 0) || limitBytes >= machineBytes) {
    return { mainMb: MIN_HEAP_MB, workerMb: MIN_HEAP_MB };
  }
  const mb = limitBytes / 1048576;
  return {
    mainMb: Math.max(MIN_HEAP_MB, Math.floor(mb * MAIN_SHARE)),
    workerMb: Math.max(MIN_HEAP_MB, Math.floor(mb * WORKER_SHARE)),
  };
};

/** The caps for the container this process runs in. */
export const heapLimits = (): HeapLimits =>
  heapLimitsFor(process.constrainedMemory() ?? 0);
