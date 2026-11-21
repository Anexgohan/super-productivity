/**
 * Before a checkpoint is applied, a browser asks the server for the numbers of its unsent saves, so a save the checkpoint holds is not applied twice.
 * Runs the app's own ServerOrderService from source, with a fake server.
 */
import '@angular/compiler';
import '../app-rules/globals';
import { Injector, ɵINJECTOR_SCOPE as INJECTOR_SCOPE } from '@angular/core';
import { Store } from '@ngrx/store';
import { describe, expect, it, vi } from 'vitest';
import { editsNotInCheckpoint } from '@sp/sync-core';
import { ServerOrderService } from '../../../src/app/op-log/sync/server-order.service';
import { OperationLogStoreService } from '../../../src/app/op-log/persistence/operation-log-store.service';
import { SyncProviderManager } from '../../../src/app/op-log/sync-providers/provider-manager.service';
import { SyncProviderId } from '../../../src/app/op-log/sync-providers/provider.const';
import { CLIENT_ID_PROVIDER } from '../../../src/app/op-log/util/client-id.provider';
import type { Operation } from '../../../src/app/op-log/core/operation.types';

// From source, as the app builds it, so a stale package build can never test old provider types.
vi.mock(
  '@sp/sync-providers/provider-types',
  () => import('../../sync-providers/src/provider-types'),
);
// Resolved lazily through the injector and never reached here; their modules load the app's UI, which needs a browser.
vi.mock('../../../src/app/op-log/sync/operation-log-download.service', () => ({
  OperationLogDownloadService: class {},
}));
vi.mock('../../../src/app/op-log/sync/conflict-resolution.service', () => ({
  ConflictResolutionService: class {},
}));
vi.mock('../../../src/app/op-log/sync-providers/wrapped-provider.service', () => ({
  WrappedProviderService: class {},
}));
vi.mock('../../../src/app/op-log/capture/operation-capture.service', () => ({
  OperationCaptureService: class {},
}));
vi.mock('../../../src/app/op-log/apply/operation-applier.service', () => ({
  OperationApplierService: class {},
}));
vi.mock('../../../src/app/features/tasks/task-time-sync.service', () => ({
  TaskTimeSyncService: class {},
}));
vi.mock('../../../src/app/features/simple-counter/simple-counter.service', () => ({
  SimpleCounterService: class {},
}));
// Provided as fakes below; only their tokens are needed.
vi.mock('../../../src/app/op-log/persistence/operation-log-store.service', () => ({
  OperationLogStoreService: class {},
}));
vi.mock('../../../src/app/op-log/sync-providers/provider-manager.service', () => ({
  SyncProviderManager: class {},
}));

const A = 'B_browserA';

const edit = (id: string): Operation =>
  ({
    id,
    clientId: A,
    actionType: '[Task Shared] updateTask',
    opType: 'UPD',
    entityType: 'TASK',
    entityId: 't1',
    payload: {
      actionPayload: { task: { id: 't1', changes: { title: id } } },
      entityChanges: [],
    },
    vectorClock: { [A]: 1 },
    timestamp: 1_790_000_000_000,
    schemaVersion: 4,
  }) as unknown as Operation;

/** The service with these unsent saves in the change log and a server answering the stored numbers as given. */
const serviceWith = (
  unsent: Operation[],
  getStoredServerSeqs: (
    opIds: readonly string[],
  ) => Promise<{ opId: string; serverSeq: number }[]>,
): { service: ServerOrderService; asked: ReturnType<typeof vi.fn> } => {
  const asked = vi.fn(getStoredServerSeqs);
  const provider = { id: SyncProviderId.SuperSync, getStoredServerSeqs: asked };
  const injector = Injector.create({
    providers: [
      { provide: INJECTOR_SCOPE, useValue: 'root' },
      { provide: Store, useValue: {} },
      {
        provide: OperationLogStoreService,
        useValue: {
          getUnsynced: async () => unsent.map((op) => ({ op, source: 'local' })),
        },
      },
      {
        provide: SyncProviderManager,
        useValue: { syncEpoch: 0, getActiveProvider: () => provider },
      },
      { provide: CLIENT_ID_PROVIDER, useValue: { loadClientId: async () => A } },
    ],
  });
  return { service: injector.get(ServerOrderService), asked };
};

describe('learning the numbers of unsent saves before a checkpoint', () => {
  it('leaves out of the edits on top a save the server stored before the checkpoint base, after a reload lost its number', async () => {
    const inCheckpoint = edit('stored-before-base');
    const afterBase = edit('stored-after-base');
    const notStored = edit('not-stored');
    const known = edit('known');
    const { service, asked } = serviceWith(
      [inCheckpoint, afterBase, notStored, known],
      async () => [
        { opId: 'stored-before-base', serverSeq: 40 },
        { opId: 'stored-after-base', serverSeq: 60 },
        { opId: 'never-asked', serverSeq: 3 },
      ],
    );
    service.recordAccepted([known], [{ opId: 'known', accepted: true, serverSeq: 45 }]);

    await service.learnUnsentServerSeqs();

    const onTop = editsNotInCheckpoint({
      unsent: [inCheckpoint, afterBase, notStored],
      checkpointBaseSeq: 50,
      ownServerSeq: (opId) => service.ownServerSeq(opId),
    });
    expect(onTop.map((op) => op.id)).toEqual(['stored-after-base', 'not-stored']);
    expect(asked).toHaveBeenCalledWith([
      'stored-before-base',
      'stored-after-base',
      'not-stored',
    ]);
    expect(service.ownServerSeq('never-asked')).toBeUndefined();
  });

  it('asks nothing when every unsent save has a known number', async () => {
    const known = edit('known');
    const { service, asked } = serviceWith([known], async () => []);
    service.recordAccepted([known], [{ opId: 'known', accepted: true, serverSeq: 45 }]);

    await service.learnUnsentServerSeqs();

    expect(asked).not.toHaveBeenCalled();
  });

  it('fails when the server cannot answer, so the checkpoint apply stops before anything changes', async () => {
    const { service } = serviceWith([edit('unknown')], async () => {
      throw new Error('HTTP 500');
    });

    await expect(service.learnUnsentServerSeqs()).rejects.toThrow('HTTP 500');
  });
});
