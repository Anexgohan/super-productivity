import { describe, expect, it } from 'vitest';
import {
  localDayKey,
  planCheckpointRetention,
  RETAINED_CHECKPOINT_DAYS,
} from '../src/sync/checkpoint-retention';

// Day N is any receivedAt inside it; the plan only compares day keys.
const day = (n: number, minute = 0): number => n * 1_000 + minute;
const dayKey = (ms: number): string => String(Math.floor(ms / 1_000));

describe('planCheckpointRetention', () => {
  it('keeps everything with fewer than two checkpoints', () => {
    expect(planCheckpointRetention([], dayKey)).toBeNull();
    expect(
      planCheckpointRetention([{ serverSeq: 5, receivedAt: day(1) }], dayKey),
    ).toBeNull();
  });

  it('keeps all changes from the second-newest checkpoint', () => {
    const plan = planCheckpointRetention(
      [
        { serverSeq: 10, receivedAt: day(1) },
        { serverSeq: 20, receivedAt: day(1, 1) },
      ],
      dayKey,
    );
    expect(plan?.keepAllFromSeq).toBe(10);
    expect([...(plan?.keptCheckpointSeqs ?? [])]).toEqual([]);
  });

  it('keeps the newest checkpoint of each older day, newest day first', () => {
    const plan = planCheckpointRetention(
      [
        { serverSeq: 2, receivedAt: day(1) },
        { serverSeq: 4, receivedAt: day(3) },
        { serverSeq: 5, receivedAt: day(3, 1) },
        { serverSeq: 7, receivedAt: day(4) },
        { serverSeq: 9, receivedAt: day(5) },
      ],
      dayKey,
    );
    expect(plan?.keepAllFromSeq).toBe(7);
    expect([...(plan?.keptCheckpointSeqs ?? [])].sort((a, b) => a - b)).toEqual([2, 5]);
  });

  it('counts only days that have a checkpoint, up to the limit', () => {
    // One checkpoint on each of ten days, far apart: the newest seven days stay.
    const checkpoints = Array.from({ length: 10 }, (_, i) => ({
      serverSeq: i + 1,
      receivedAt: day(i * 5),
    }));
    const plan = planCheckpointRetention(checkpoints, dayKey);
    expect(RETAINED_CHECKPOINT_DAYS).toBe(7);
    expect(plan?.keepAllFromSeq).toBe(9);
    expect([...(plan?.keptCheckpointSeqs ?? [])].sort((a, b) => a - b)).toEqual([
      4, 5, 6, 7, 8,
    ]);
  });

  it('a busy day with many checkpoints counts once', () => {
    const checkpoints = [
      ...Array.from({ length: 24 }, (_, i) => ({
        serverSeq: 100 + i,
        receivedAt: day(9, i),
      })),
      { serverSeq: 50, receivedAt: day(8) },
      { serverSeq: 40, receivedAt: day(7, 2) },
      { serverSeq: 39, receivedAt: day(7, 1) },
    ];
    const plan = planCheckpointRetention(checkpoints, dayKey);
    expect(plan?.keepAllFromSeq).toBe(122);
    expect([...(plan?.keptCheckpointSeqs ?? [])].sort((a, b) => a - b)).toEqual([40, 50]);
  });

  it('accepts checkpoints in any order', () => {
    const plan = planCheckpointRetention(
      [
        { serverSeq: 9, receivedAt: day(5) },
        { serverSeq: 2, receivedAt: day(1) },
        { serverSeq: 7, receivedAt: day(4) },
      ],
      dayKey,
    );
    expect(plan?.keepAllFromSeq).toBe(7);
    expect([...(plan?.keptCheckpointSeqs ?? [])]).toEqual([2]);
  });
});

describe('localDayKey', () => {
  it('splits at local midnight', () => {
    const lateEvening = new Date(2026, 10, 20, 23, 59).getTime();
    const nextMorning = new Date(2026, 10, 21, 0, 1).getTime();
    const sameDayEarly = new Date(2026, 10, 20, 0, 1).getTime();
    expect(localDayKey(lateEvening)).not.toBe(localDayKey(nextMorning));
    expect(localDayKey(lateEvening)).toBe(localDayKey(sameDayEarly));
  });
});
