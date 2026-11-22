/**
 * A browser marks its "bring it back" saves in the clear, so the server can refuse one a later delete beats.
 * A refused one is withdrawn without an error.
 * Runs the app's own upload conversion and rejected-ops service from source, with fakes for what they reach.
 */
import '@angular/compiler';
import '../app-rules/globals';
import { Injector, ɵINJECTOR_SCOPE as INJECTOR_SCOPE } from '@angular/core';
import { describe, expect, it, vi } from 'vitest';
import { syncOpFromOperation } from '../../../src/app/op-log/sync/upload-payload.util';
import { RejectedOpsHandlerService } from '../../../src/app/op-log/sync/rejected-ops-handler.service';
import { OperationLogStoreService } from '../../../src/app/op-log/persistence/operation-log-store.service';
import { SnackService } from '../../../src/app/core/snack/snack.service';
import { RepairOperationService } from '../../../src/app/op-log/validation/repair-operation.service';
import type {
  Operation,
  OperationLogEntry,
} from '../../../src/app/op-log/core/operation.types';
import type { SyncOperation } from '../../../src/app/op-log/sync-providers/provider.interface';

// The services below are only injected; their modules load the app's UI, which needs a browser.
vi.mock('../../../src/app/op-log/persistence/operation-log-store.service', () => ({
  OperationLogStoreService: class {},
}));
vi.mock('../../../src/app/core/snack/snack.service', () => ({ SnackService: class {} }));
vi.mock('../../../src/app/op-log/validation/repair-operation.service', () => ({
  RepairOperationService: class {},
}));
vi.mock('../../../src/app/util/native-dialogs', () => ({ alertDialog: () => undefined }));

const A = 'B_browserA';

type OpFields = Partial<Omit<Operation, 'actionType'>> & { actionType?: string };

const op = (overrides: OpFields): Operation =>
  ({
    id: 'op-1',
    clientId: A,
    actionType: '[TASK] LWW Update',
    opType: 'UPD',
    entityType: 'TASK',
    entityId: 't1',
    payload: {
      actionPayload: { id: 't1', title: 'Kept' },
      entityChanges: [],
      lwwUpdateMode: 'replace',
    },
    vectorClock: { [A]: 2 },
    timestamp: 20,
    schemaVersion: 1,
    ...overrides,
  }) as Operation;

const bringBack = (overrides: OpFields = {}): Operation =>
  op({
    ...overrides,
    payload: {
      actionPayload: { id: overrides.entityId ?? 't1', title: 'Kept' },
      entityChanges: [],
      lwwUpdateMode: 'replace',
      recreatesEntityAfterDelete: true,
    },
  });

const entry = (o: Operation, seq = 1): OperationLogEntry =>
  ({ seq, op: o, appliedAt: 1, source: 'local' }) as OperationLogEntry;

describe('the bring-back marker on an upload', () => {
  const wireOp = (o: Operation): SyncOperation | null => syncOpFromOperation(o);

  it('marks a task or note bring-back, in the clear beside the payload', () => {
    expect(wireOp(bringBack())?.recreatesEntityAfterDelete).toBe(true);
    expect(
      wireOp(bringBack({ entityType: 'NOTE', actionType: '[NOTE] LWW Update' }))
        ?.recreatesEntityAfterDelete,
    ).toBe(true);
  });

  it('leaves every other save unmarked', () => {
    const unmarked = [
      op({}),
      bringBack({ entityType: 'PROJECT', actionType: '[PROJECT] LWW Update' }),
      op({ actionType: '[Task] Update Task', payload: { task: { id: 't1' } } }),
    ];
    for (const o of unmarked) {
      expect(wireOp(o)).not.toHaveProperty('recreatesEntityAfterDelete');
    }
  });
});

describe('a bring-back the server refuses because a later delete beats it', () => {
  const handlerWith = (
    entries: OperationLogEntry[],
  ): { handler: RejectedOpsHandlerService; rejected: string[][]; snacks: unknown[] } => {
    const rejected: string[][] = [];
    const snacks: unknown[] = [];
    const injector = Injector.create({
      providers: [
        { provide: INJECTOR_SCOPE, useValue: 'root' },
        {
          provide: OperationLogStoreService,
          useValue: {
            getOpById: async (id: string) => entries.find((e) => e.op.id === id),
            markRejected: async (ids: string[]) => {
              rejected.push(ids);
            },
          },
        },
        { provide: SnackService, useValue: { open: (s: unknown) => snacks.push(s) } },
        { provide: RepairOperationService, useValue: {} },
      ],
    });
    return { handler: injector.get(RejectedOpsHandlerService), rejected, snacks };
  };

  it('is withdrawn without an error, and is no failed upload', async () => {
    const { handler, rejected, snacks } = handlerWith([entry(bringBack())]);

    const result = await handler.handleRejectedOps([
      {
        opId: 'op-1',
        error: 'A later delete of this item is on record',
        errorCode: 'DELETED_LATER',
      },
    ]);

    expect(rejected).toEqual([['op-1']]);
    expect(snacks).toEqual([]);
    expect(result).toEqual({
      kind: 'completed',
      mergedOpsCreated: 0,
      permanentRejectionCount: 0,
    });
  });

  it('is left alone when the download that brought the delete already withdrew it', async () => {
    const withdrawn = { ...entry(bringBack()), rejectedAt: 5 } as OperationLogEntry;
    const { handler, rejected } = handlerWith([withdrawn]);

    await handler.handleRejectedOps([{ opId: 'op-1', errorCode: 'DELETED_LATER' }]);

    expect(rejected).toEqual([]);
  });
});
