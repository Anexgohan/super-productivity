/**
 * A change made on top of the newest full state does not conflict with an entity change stored before it
 * (anex/checkpoints). Reproduces dev, 2026-11-20: the bridge's checkpoint (a REPAIR with its base) at seq 1107, a fresh
 * browser whose clock held only the bridge and itself, and the card's previous change (seq 1106, from the bridge, with a
 * clock of 20 devices): the browser's save was refused as CONCURRENT although the checkpoint contained 1106.
 */
import { describe, expect, it, vi } from 'vitest';
import type { Prisma } from '@prisma/client';
import {
  getFullStateBoundary,
  isCoveredByFullState,
  resolveConflictForExistingOp,
  type FullStateBoundary,
} from '../src/sync/conflict';
import type { Operation } from '../src/sync/sync.types';

const MANY_DEVICES = { B_XBfKcy: 410, B_yALfBd: 128, B_WZujPJ: 63, 'sp-bridge': 1605 };
const before = { clientId: 'sp-bridge', vectorClock: MANY_DEVICES, serverSeq: 1106 };
const checkpoint: FullStateBoundary = {
  serverSeq: 1107,
  authorId: 'sp-bridge',
  authorCounter: 1606,
};

const save = (vectorClock: Record<string, number>): Operation => ({
  id: 'op-browser',
  clientId: 'B_e8O7SO',
  actionType: '[Task Shared] updateTask',
  opType: 'UPD',
  entityType: 'TASK',
  entityId: 'R_hLptXtxIQogTOYF0TUr',
  payload: 'encrypted',
  vectorClock,
  timestamp: 1_000,
  schemaVersion: 4,
});

describe('full-state boundary in conflict detection', () => {
  it('reads today as a conflict without the boundary: the fresh browser does not list the other devices', () => {
    const op = save({ 'sp-bridge': 1606, B_e8O7SO: 1 });
    expect(
      resolveConflictForExistingOp(op, 'R_hLptXtxIQogTOYF0TUr', before),
    ).toMatchObject({
      hasConflict: true,
      conflictType: 'concurrent',
    });
  });

  it('accepts a save made on top of the checkpoint against a change the checkpoint contains', () => {
    const op = save({ 'sp-bridge': 1606, B_e8O7SO: 1 });
    expect(isCoveredByFullState(op, before, checkpoint)).toBe(true);
    expect(
      resolveConflictForExistingOp(op, 'R_hLptXtxIQogTOYF0TUr', before, checkpoint),
    ).toEqual({ hasConflict: false });
  });

  it('still refuses a save from a device that has not seen the checkpoint', () => {
    const op = save({ 'sp-bridge': 1500, B_e8O7SO: 1 });
    expect(isCoveredByFullState(op, before, checkpoint)).toBe(false);
    expect(
      resolveConflictForExistingOp(op, 'R_hLptXtxIQogTOYF0TUr', before, checkpoint),
    ).toMatchObject({ hasConflict: true, conflictType: 'concurrent' });
  });

  it('still refuses a save concurrent with a change stored after the checkpoint', () => {
    const after = {
      clientId: 'B_other',
      vectorClock: { 'sp-bridge': 1606, B_other: 1 },
      serverSeq: 1108,
    };
    const op = save({ 'sp-bridge': 1606, B_e8O7SO: 1 });
    expect(isCoveredByFullState(op, after, checkpoint)).toBe(false);
    expect(
      resolveConflictForExistingOp(op, 'R_hLptXtxIQogTOYF0TUr', after, checkpoint),
    ).toMatchObject({ hasConflict: true, conflictType: 'concurrent' });
  });

  it('changes nothing for a stored change without a known seq, or when there is no full state', () => {
    const op = save({ 'sp-bridge': 1606, B_e8O7SO: 1 });
    expect(isCoveredByFullState(op, { serverSeq: undefined }, checkpoint)).toBe(false);
    expect(isCoveredByFullState(op, before, null)).toBe(false);
  });

  it('reads the newest causal full state once per transaction, with its author counter', async () => {
    const findFirst = vi.fn().mockResolvedValue({
      serverSeq: 1107,
      clientId: 'sp-bridge',
      vectorClock: { ...MANY_DEVICES, 'sp-bridge': 1606 },
    });
    const tx = { operation: { findFirst } } as unknown as Prisma.TransactionClient;
    expect(await getFullStateBoundary(1, tx)).toEqual(checkpoint);
    await getFullStateBoundary(1, tx);
    expect(findFirst).toHaveBeenCalledTimes(1);
    const where = findFirst.mock.calls[0][0].where;
    expect(where.userId).toBe(1);
    expect(where.OR).toBeDefined();
  });

  it('has no boundary when the full state clock lacks its author', async () => {
    const tx = {
      operation: {
        findFirst: vi
          .fn()
          .mockResolvedValue({ serverSeq: 5, clientId: 'x', vectorClock: {} }),
      },
    } as unknown as Prisma.TransactionClient;
    expect(await getFullStateBoundary(1, tx)).toBeNull();
  });
});
