import { describe, expect, it } from 'vitest';
import { heapLimitsFor } from '../src/heap-limits';

const MB = 1048576;
const MACHINE = 8192 * MB;

describe('heapLimitsFor', () => {
  it('keeps the main heap at 96 MB in a 256m container', () => {
    expect(heapLimitsFor(256 * MB, MACHINE)).toEqual({ mainMb: 96, workerMb: 128 });
  });

  it('sizes both heaps from a 1g container', () => {
    expect(heapLimitsFor(1024 * MB, MACHINE)).toEqual({ mainMb: 204, workerMb: 512 });
  });

  it('keeps both heaps at 96 MB with no container cap', () => {
    expect(heapLimitsFor(0, MACHINE)).toEqual({ mainMb: 96, workerMb: 96 });
    expect(heapLimitsFor(MACHINE, MACHINE)).toEqual({ mainMb: 96, workerMb: 96 });
  });
});
