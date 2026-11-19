/**
 * A change made on top of the newest full state does not conflict with an entity change stored before it
 * (anex/checkpoints). Reproduces dev, 2026-11-20: the bridge's checkpoint (a REPAIR with its base) at seq 1107, a fresh
 * browser whose clock held only the bridge and itself, and the card's previous change (seq 1106, from the bridge, with a
 * clock of 20 devices): the browser's save was refused as CONCURRENT although the checkpoint contained 1106.
 *
 * And any later full state counts, not only the newest. Dev, 2026-11-20: a browser signed in on checkpoint 1124, edited
 * a card offline (last changed at 1117 by another browser), and checkpoint 1132 was written before it went online; the
 * save was refused because only 1132 was checked, and got through only on the browser's own conflict retry.
 */
import { describe, expect, it, vi } from 'vitest';
import type { Prisma } from '@prisma/client';
import {
  FULL_STATE_BOUNDARY_LIMIT,
  getFullStateBoundaries,
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
  isFullImport: false,
};
const checkpoints = [checkpoint];

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
    expect(isCoveredByFullState(op, before, checkpoints)).toBe(true);
    expect(
      resolveConflictForExistingOp(op, 'R_hLptXtxIQogTOYF0TUr', before, checkpoints),
    ).toEqual({ hasConflict: false });
  });

  it('still refuses a save from a device that has not seen the checkpoint', () => {
    const op = save({ 'sp-bridge': 1500, B_e8O7SO: 1 });
    expect(isCoveredByFullState(op, before, checkpoints)).toBe(false);
    expect(
      resolveConflictForExistingOp(op, 'R_hLptXtxIQogTOYF0TUr', before, checkpoints),
    ).toMatchObject({ hasConflict: true, conflictType: 'concurrent' });
  });

  it('still refuses a save concurrent with a change stored after the checkpoint', () => {
    const after = {
      clientId: 'B_other',
      vectorClock: { 'sp-bridge': 1606, B_other: 1 },
      serverSeq: 1108,
    };
    const op = save({ 'sp-bridge': 1606, B_e8O7SO: 1 });
    expect(isCoveredByFullState(op, after, checkpoints)).toBe(false);
    expect(
      resolveConflictForExistingOp(op, 'R_hLptXtxIQogTOYF0TUr', after, checkpoints),
    ).toMatchObject({ hasConflict: true, conflictType: 'concurrent' });
  });

  it('changes nothing for a stored change without a known seq, or when there is no full state', () => {
    const op = save({ 'sp-bridge': 1606, B_e8O7SO: 1 });
    expect(isCoveredByFullState(op, { serverSeq: undefined }, checkpoints)).toBe(false);
    expect(isCoveredByFullState(op, before, null)).toBe(false);
    expect(isCoveredByFullState(op, before, [])).toBe(false);
  });

  describe('a save made on top of an older checkpoint than the newest', () => {
    const earlierBrowser = {
      clientId: 'B_JTO6eK',
      vectorClock: { ...MANY_DEVICES, B_JTO6eK: 15, 'sp-bridge': 1606 },
      serverSeq: 1117,
    };
    const signedInOn: FullStateBoundary = {
      serverSeq: 1124,
      authorId: 'sp-bridge',
      authorCounter: 1610,
      isFullImport: false,
    };
    const newest: FullStateBoundary = {
      serverSeq: 1132,
      authorId: 'sp-bridge',
      authorCounter: 1612,
      isFullImport: false,
    };
    const offlineEdit = save({ 'sp-bridge': 1610, B_DmRczB: 19, B_WZujPJ: 64 });

    it('was refused when only the newest checkpoint counted', () => {
      expect(isCoveredByFullState(offlineEdit, earlierBrowser, [newest])).toBe(false);
      expect(
        resolveConflictForExistingOp(offlineEdit, 'card', earlierBrowser, [newest]),
      ).toMatchObject({ hasConflict: true, conflictType: 'concurrent' });
    });

    it('is accepted: the checkpoint it was made on contains the stored change', () => {
      expect(
        resolveConflictForExistingOp(offlineEdit, 'card', earlierBrowser, [
          newest,
          signedInOn,
        ]),
      ).toEqual({ hasConflict: false });
    });

    it('is still refused when the checkpoint it was made on came before the stored change', () => {
      const storedLater = { ...earlierBrowser, serverSeq: 1128 };
      expect(
        resolveConflictForExistingOp(offlineEdit, 'card', storedLater, [
          newest,
          signedInOn,
        ]),
      ).toMatchObject({ hasConflict: true, conflictType: 'concurrent' });
    });
  });

  it('reads the newest causal full states once per transaction, with their author counters', async () => {
    const findMany = vi.fn().mockResolvedValue([
      {
        serverSeq: 1107,
        clientId: 'sp-bridge',
        opType: 'REPAIR',
        vectorClock: { ...MANY_DEVICES, 'sp-bridge': 1606 },
      },
    ]);
    const tx = { operation: { findMany } } as unknown as Prisma.TransactionClient;
    expect(await getFullStateBoundaries(1, tx)).toEqual(checkpoints);
    await getFullStateBoundaries(1, tx);
    expect(findMany).toHaveBeenCalledTimes(1);
    const args = findMany.mock.calls[0][0];
    expect(args.where.userId).toBe(1);
    expect(args.where.OR).toBeDefined();
    expect(args.orderBy).toEqual({ serverSeq: 'desc' });
    expect(args.take).toBe(FULL_STATE_BOUNDARY_LIMIT);
  });

  it('stops at the newest full import: the full states before it were replaced', async () => {
    const tx = {
      operation: {
        findMany: vi.fn().mockResolvedValue([
          {
            serverSeq: 30,
            clientId: 'sp-bridge',
            opType: 'REPAIR',
            vectorClock: { 'sp-bridge': 9 },
          },
          {
            serverSeq: 20,
            clientId: 'B_import',
            opType: 'SYNC_IMPORT',
            vectorClock: { B_import: 4 },
          },
          {
            serverSeq: 10,
            clientId: 'sp-bridge',
            opType: 'REPAIR',
            vectorClock: { 'sp-bridge': 5 },
          },
        ]),
      },
    } as unknown as Prisma.TransactionClient;
    const boundaries = await getFullStateBoundaries(1, tx);
    expect(boundaries.map((b) => b.serverSeq)).toEqual([30, 20]);
    expect(boundaries[1].isFullImport).toBe(true);
    // A save made on the checkpoint at 10, before the import, does not get past a change stored before it.
    const stale = save({ 'sp-bridge': 5, B_e8O7SO: 1 });
    expect(isCoveredByFullState(stale, { serverSeq: 5 }, boundaries)).toBe(false);
  });

  it('skips a full state whose clock lacks its author', async () => {
    const tx = {
      operation: {
        findMany: vi
          .fn()
          .mockResolvedValue([
            { serverSeq: 5, clientId: 'x', opType: 'REPAIR', vectorClock: {} },
          ]),
      },
    } as unknown as Prisma.TransactionClient;
    expect(await getFullStateBoundaries(1, tx)).toEqual([]);
  });
});
