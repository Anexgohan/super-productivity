/**
 * When a board is due for a checkpoint (anex/checkpoints): 1,000 changes or 20 MB since the newest full-state point,
 * at most once an hour, retries spaced out, counters kept across restarts. Synthetic rows only.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { SuperSyncServerOperation } from '@sp/shared-schema';
import {
  CHECKPOINT_EVERY_BYTES,
  CHECKPOINT_EVERY_CHANGES,
  CHECKPOINT_MIN_INTERVAL_MS,
  CHECKPOINT_RETRY_MS,
  CheckpointTracker,
  isFullStatePoint,
} from '../src/checkpoints';

const dirs: string[] = [];
const statePath = (): string => {
  const dir = mkdtempSync(join(tmpdir(), 'checkpoints-test-'));
  dirs.push(dir);
  return join(dir, 'checkpoint-state.json');
};
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

let seq = 0;
const row = (op: Record<string, unknown>): SuperSyncServerOperation =>
  ({ serverSeq: ++seq, receivedAt: 0, op }) as unknown as SuperSyncServerOperation;
const change = (payload = 'x'): SuperSyncServerOperation =>
  row({ opType: 'UPD', payload });
const fullImport = (): SuperSyncServerOperation =>
  row({ opType: 'SYNC_IMPORT', payload: 'state' });
const changes = (n: number): SuperSyncServerOperation[] =>
  Array.from({ length: n }, () => change());

const HOUR_LATER = CHECKPOINT_MIN_INTERVAL_MS + 1;

describe('checkpoints: when one is due', () => {
  it('counts only REPAIRs with a base, and full imports, as full-state points', () => {
    expect(isFullStatePoint({ opType: 'SYNC_IMPORT' })).toBe(true);
    expect(isFullStatePoint({ opType: 'BACKUP_IMPORT' })).toBe(true);
    expect(isFullStatePoint({ opType: 'REPAIR', repairBaseServerSeq: 5 })).toBe(true);
    expect(isFullStatePoint({ opType: 'REPAIR' })).toBe(false);
    expect(isFullStatePoint({ opType: 'UPD' })).toBe(false);
  });

  it('is due after 1,000 changes since the newest full-state point, not before', () => {
    const t = new CheckpointTracker(statePath());
    t.observe([fullImport(), ...changes(CHECKPOINT_EVERY_CHANGES - 1)]);
    expect(t.isDue(HOUR_LATER)).toBe(false);
    t.observe([change()]);
    expect(t.isDue(HOUR_LATER)).toBe(true);
  });

  it('is due after 20 MB of new history, however few changes', () => {
    const t = new CheckpointTracker(statePath());
    t.observe([fullImport(), change('a'.repeat(CHECKPOINT_EVERY_BYTES))]);
    expect(t.state.changesSince).toBe(1);
    expect(t.isDue(HOUR_LATER)).toBe(true);
  });

  it('restarts its counters at every full-state point, the bridge own checkpoints included', () => {
    const t = new CheckpointTracker(statePath());
    t.observe([fullImport(), ...changes(CHECKPOINT_EVERY_CHANGES)]);
    const repair = row({ opType: 'REPAIR', repairBaseServerSeq: seq, payload: 'state' });
    t.observe([repair]);
    expect(t.state).toMatchObject({
      lastFullStateSeq: repair.serverSeq,
      changesSince: 0,
      bytesSince: 0,
    });
    expect(t.isDue(HOUR_LATER)).toBe(false);
  });

  it('takes the first chance on a board whose history it has not counted back to a full-state point', () => {
    const t = new CheckpointTracker(statePath());
    expect(t.isDue(HOUR_LATER)).toBe(false);
    t.observe([change()]);
    expect(t.isDue(HOUR_LATER)).toBe(true);
  });

  it('writes at most once an hour, and spaces out retries after a refusal', () => {
    const t = new CheckpointTracker(statePath());
    t.observe([fullImport(), ...changes(CHECKPOINT_EVERY_CHANGES)]);
    const start = 10 * CHECKPOINT_MIN_INTERVAL_MS;
    t.markAttempt(start, 'REPAIR_STALE: someone saved meanwhile');
    expect(t.isDue(start + CHECKPOINT_RETRY_MS - 1)).toBe(false);
    expect(t.isDue(start + CHECKPOINT_RETRY_MS)).toBe(true);
    t.markAttempt(start + CHECKPOINT_RETRY_MS, null);
    t.observe(changes(CHECKPOINT_EVERY_CHANGES));
    expect(t.isDue(start + CHECKPOINT_RETRY_MS + CHECKPOINT_MIN_INTERVAL_MS - 1)).toBe(
      false,
    );
    expect(t.isDue(start + CHECKPOINT_RETRY_MS + CHECKPOINT_MIN_INTERVAL_MS)).toBe(true);
  });

  it('records a hold once, without counting it as an attempt, so the checkpoint follows as soon as the hold ends', () => {
    const t = new CheckpointTracker(statePath());
    t.observe([fullImport(), ...changes(CHECKPOINT_EVERY_CHANGES)]);
    expect(t.holdBack('held back: archive')).toBe(true);
    expect(t.holdBack('held back: archive')).toBe(false);
    expect(t.state.lastError).toBe('held back: archive');
    expect(t.isDue(HOUR_LATER)).toBe(true);
  });

  it('keeps its counters across a restart', () => {
    const path = statePath();
    const first = new CheckpointTracker(path);
    first.observe([fullImport(), ...changes(10)]);
    const again = new CheckpointTracker(path);
    expect(again.state).toMatchObject({ changesSince: 10, countsComplete: true });
    expect(again.isDue(HOUR_LATER)).toBe(false);
  });
});
