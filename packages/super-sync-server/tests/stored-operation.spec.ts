import { describe, expect, it } from 'vitest';
import {
  getStoredEntityIds,
  isSameDuplicateOperation,
  isSameIncomingOperation,
  isSameDuplicateTimestamp,
  pruneVectorClockForStorage,
  stableJsonStringify,
} from '../src/sync/stored-operation';
import {
  DuplicateOperationCandidate,
  MAX_VECTOR_CLOCK_SIZE,
  Operation,
} from '../src/sync/sync.types';

const op = (overrides: Partial<Operation> = {}): Operation => ({
  id: 'op-1',
  clientId: 'client-a',
  actionType: 'ADD_TASK',
  opType: 'CRT',
  entityType: 'TASK',
  entityId: 'task-1',
  payload: { title: 'A' },
  vectorClock: { 'client-a': 1 },
  timestamp: 1_000,
  schemaVersion: 1,
  ...overrides,
});

const duplicateCandidate = (
  overrides: Partial<DuplicateOperationCandidate> = {},
): DuplicateOperationCandidate => ({
  id: 'op-1',
  userId: 1,
  clientId: 'client-a',
  actionType: 'ADD_TASK',
  opType: 'CRT',
  entityType: 'TASK',
  entityId: 'task-1',
  entityIds: [],
  payload: { title: 'A' },
  vectorClock: { 'client-a': 1 },
  schemaVersion: 1,
  clientTimestamp: 1_000,
  receivedAt: 1_000,
  isPayloadEncrypted: false,
  syncImportReason: null,
  repairBaseServerSeq: null,
  ...overrides,
});

describe('stored-operation helpers', () => {
  it('matches causal REPAIR retries with the same base cursor', () => {
    const repair = op({
      opType: 'REPAIR',
      entityType: 'ALL',
      entityId: undefined,
      repairBaseServerSeq: 10,
    });

    expect(
      isSameIncomingOperation(
        { ...repair, entityIds: [] },
        { ...repair, entityIds: undefined },
        0,
        0,
      ),
    ).toBe(true);
  });

  it('accepts matching duplicate operations regardless of JSON key order', () => {
    const incoming = op({
      payload: { title: 'A', nested: { b: 2, a: 1 } },
    });
    const existing = duplicateCandidate({
      payload: { nested: { a: 1, b: 2 }, title: 'A' },
    });

    expect(isSameDuplicateOperation(existing, 1, incoming, 60_000)).toBe(true);
  });

  it('rejects duplicate ids when operation content differs', () => {
    const incoming = op({ payload: { title: 'B' } });

    expect(isSameDuplicateOperation(duplicateCandidate(), 1, incoming, 60_000)).toBe(
      false,
    );
  });

  it('accepts batch retries with identical entityIds', () => {
    const incoming = op({ entityIds: ['task-1', 'task-2'] });
    const existing = duplicateCandidate({ entityIds: ['task-1', 'task-2'] });

    expect(isSameDuplicateOperation(existing, 1, incoming, 60_000)).toBe(true);
  });

  it('rejects duplicate ids when entityIds differ', () => {
    const incoming = op({ entityIds: ['task-1', 'task-3'] });
    const existing = duplicateCandidate({ entityIds: ['task-1', 'task-2'] });

    expect(isSameDuplicateOperation(existing, 1, incoming, 60_000)).toBe(false);
  });

  it('rejects duplicate ids when only one side has entityIds', () => {
    const incomingWithBatch = op({ entityIds: ['task-1', 'task-2'] });
    expect(
      isSameDuplicateOperation(duplicateCandidate(), 1, incomingWithBatch, 60_000),
    ).toBe(false);

    const existingWithBatch = duplicateCandidate({ entityIds: ['task-1', 'task-2'] });
    expect(isSameDuplicateOperation(existingWithBatch, 1, op(), 60_000)).toBe(false);
  });

  it('accepts single-entity retries whose entityIds collapse to the scalar entityId', () => {
    // getStoredEntityIds persists [] when entityIds is exactly [entityId], so a
    // retry that re-sends that redundant array must still match the stored row.
    const incoming = op({ entityIds: ['task-1'] });

    expect(isSameDuplicateOperation(duplicateCandidate(), 1, incoming, 60_000)).toBe(
      true,
    );
  });

  it('rejects encrypted retries when entityIds differ', () => {
    // With both sides encrypted the payload comparison is skipped, so entityIds
    // must independently block a batch-op id collision.
    const incoming = op({
      payload: 'BASE64-CIPHERTEXT-A',
      isPayloadEncrypted: true,
      entityIds: ['task-1', 'task-3'],
    });
    const existing = duplicateCandidate({
      payload: 'BASE64-CIPHERTEXT-B',
      isPayloadEncrypted: true,
      entityIds: ['task-1', 'task-2'],
    });

    expect(isSameDuplicateOperation(existing, 1, incoming, 60_000)).toBe(false);
  });

  it('accepts encrypted retries whose ciphertext differs from the stored payload', () => {
    // Regression: when encryption is on, encrypt() generates a fresh random IV
    // per call, so a retry of the same logical op produces different ciphertext.
    // The server must still recognize it as a duplicate, otherwise the client
    // sees INVALID_OP_ID and marks the op as permanently rejected even though
    // the server already committed it (partial-success retry on flaky network).
    const incoming = op({
      payload: 'BASE64-CIPHERTEXT-WITH-FRESH-IV',
      isPayloadEncrypted: true,
    });
    const existing = duplicateCandidate({
      payload: 'BASE64-CIPHERTEXT-WITH-ORIGINAL-IV',
      isPayloadEncrypted: true,
    });

    expect(isSameDuplicateOperation(existing, 1, incoming, 60_000)).toBe(true);
  });

  it('rejects encrypted retries when structural fields differ', () => {
    // The ciphertext bypass must not let through a genuine id collision: if any
    // structural field (here vectorClock) differs, it's not a retry.
    const incoming = op({
      payload: 'BASE64-CIPHERTEXT-A',
      isPayloadEncrypted: true,
      vectorClock: { 'client-a': 2 },
    });
    const existing = duplicateCandidate({
      payload: 'BASE64-CIPHERTEXT-B',
      isPayloadEncrypted: true,
      vectorClock: { 'client-a': 1 },
    });

    expect(isSameDuplicateOperation(existing, 1, incoming, 60_000)).toBe(false);
  });

  it('rejects when only one side is encrypted', () => {
    // A sudden flip in encryption status for the same op id is suspicious and
    // should remain a hard rejection — the bypass only kicks in when both sides
    // declare the payload encrypted.
    const incoming = op({
      payload: 'BASE64-CIPHERTEXT',
      isPayloadEncrypted: true,
    });
    const existing = duplicateCandidate({
      payload: { title: 'A' },
      isPayloadEncrypted: false,
    });

    expect(isSameDuplicateOperation(existing, 1, incoming, 60_000)).toBe(false);
  });

  it('accepts retry timestamps previously clamped at the clock-drift boundary', () => {
    expect(isSameDuplicateTimestamp(160_000, 100_000, 170_000, 180_000, 60_000)).toBe(
      true,
    );
  });

  it('rejects retry timestamps outside the clock-drift boundary', () => {
    expect(isSameDuplicateTimestamp(160_001, 100_000, 170_000, 180_000, 60_000)).toBe(
      false,
    );
  });

  it('stable-stringifies object keys recursively', () => {
    expect(stableJsonStringify({ z: 1, a: { b: 2, a: 1 } })).toBe(
      '{"a":{"a":1,"b":2},"z":1}',
    );
  });

  it('prunes and mutates vector clocks before storage', () => {
    const incoming = op({
      clientId: 'client-25',
      vectorClock: Object.fromEntries(
        Array.from({ length: 25 }, (_, index) => [`client-${index + 1}`, index + 1]),
      ),
    });
    const originalClock = incoming.vectorClock;

    pruneVectorClockForStorage(incoming);

    expect(incoming.vectorClock).not.toBe(originalClock);
    expect(Object.keys(incoming.vectorClock)).toHaveLength(MAX_VECTOR_CLOCK_SIZE);
    expect(incoming.vectorClock['client-25']).toBe(25);
  });

  it('preserves the active full-state author while pruning', () => {
    const fullStateAuthor = 'import-client';
    const incoming = op({
      clientId: 'upload-client',
      vectorClock: {
        [fullStateAuthor]: 1,
        'upload-client': 2,
        ...Object.fromEntries(
          Array.from({ length: 25 }, (_, index) => [`old-client-${index}`, 100 + index]),
        ),
      },
    });

    pruneVectorClockForStorage(incoming, [fullStateAuthor]);

    expect(Object.keys(incoming.vectorClock)).toHaveLength(MAX_VECTOR_CLOCK_SIZE);
    expect(incoming.vectorClock[fullStateAuthor]).toBe(1);
    expect(incoming.vectorClock['upload-client']).toBe(2);
  });
});

describe('#8334 getStoredEntityIds', () => {
  const op = (over: Partial<Operation>): Operation => over as unknown as Operation;

  it('stores [] for a single-entity op (covered by the scalar)', () => {
    expect(getStoredEntityIds(op({ entityId: 'task-1' }))).toEqual([]);
    expect(getStoredEntityIds(op({ entityId: 'task-1', entityIds: ['task-1'] }))).toEqual(
      [],
    );
  });

  it('stores the full set for a multi-entity op', () => {
    expect(
      getStoredEntityIds(op({ entityId: 'task-1', entityIds: ['task-1', 'task-2'] })),
    ).toEqual(['task-1', 'task-2']);
  });

  it('stores [] for an entity-less op', () => {
    expect(getStoredEntityIds(op({}))).toEqual([]);
  });

  it('stores the id when a batch op dedups to one value that differs from entityId', () => {
    // The server does not enforce entityId === entityIds[0]; without this the
    // stored row would lose that entity (#8334).
    expect(
      getStoredEntityIds(op({ entityId: 'task-Z', entityIds: ['task-A', 'task-A'] })),
    ).toEqual(['task-A']);
  });
});
