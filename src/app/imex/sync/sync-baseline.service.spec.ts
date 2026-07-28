import { TestBed } from '@angular/core/testing';
import { OperationLogStoreService } from '../../op-log/persistence/operation-log-store.service';
import {
  ContainerAuthorityService,
  IS_READ_ONLY_BOARD,
} from './container-authority.service';
import { SYNC_BASELINE_THRESHOLD, SyncBaselineService } from './sync-baseline.service';

describe('SyncBaselineService', () => {
  let service: SyncBaselineService;
  let opLogStore: jasmine.SpyObj<OperationLogStoreService>;
  let containerAuthority: jasmine.SpyObj<ContainerAuthorityService>;

  /** Only `seq` is read by the service, so entries are stubbed down to it. */
  const tailOps = (count: number): unknown[] =>
    Array.from({ length: count }, (_, i) => ({ seq: i + 1 }));

  beforeEach(() => {
    opLogStore = jasmine.createSpyObj('OperationLogStoreService', [
      'getUnsynced',
      'getLatestFullStateOpEntry',
      'getOpsAfterSeq',
    ]);
    containerAuthority = jasmine.createSpyObj('ContainerAuthorityService', [
      'isContainerManaged',
    ]);

    // Defaults describe a board that SHOULD publish, so each test relaxes exactly one guard.
    containerAuthority.isContainerManaged.and.resolveTo(true);
    opLogStore.getUnsynced.and.resolveTo([]);
    opLogStore.getLatestFullStateOpEntry.and.resolveTo({ seq: 8 } as never);
    opLogStore.getOpsAfterSeq.and.resolveTo(
      tailOps(SYNC_BASELINE_THRESHOLD + 1) as never,
    );

    TestBed.configureTestingModule({
      providers: [
        SyncBaselineService,
        { provide: OperationLogStoreService, useValue: opLogStore },
        { provide: ContainerAuthorityService, useValue: containerAuthority },
      ],
    });
    service = TestBed.inject(SyncBaselineService);
  });

  // Module-level signal, so it outlives the TestBed and would leak into the next spec.
  afterEach(() => IS_READ_ONLY_BOARD.set(false));

  it('publishes when history has grown past the threshold', async () => {
    expect(await service.shouldPublish()).toBe(true);
  });

  it('does not publish when the history is short', async () => {
    opLogStore.getOpsAfterSeq.and.resolveTo(tailOps(SYNC_BASELINE_THRESHOLD) as never);
    expect(await service.shouldPublish()).toBe(false);
  });

  it('does not publish outside a container-managed deployment', async () => {
    containerAuthority.isContainerManaged.and.resolveTo(false);
    expect(await service.shouldPublish()).toBe(false);
  });

  it('does not publish onto a board it may only read', async () => {
    // The token served for a shared board is read-scoped, so this upload would 403 and wedge sync behind a full-state op that can never land.
    IS_READ_ONLY_BOARD.set(true);
    expect(await service.shouldPublish()).toBe(false);
  });

  it('does not publish while local ops are unsynced', async () => {
    // A baseline claims to be the whole truth, so unsynced work would be published as though it never happened.
    opLogStore.getUnsynced.and.resolveTo([{ seq: 99 }] as never);
    expect(await service.shouldPublish()).toBe(false);
  });

  it('counts from the start when no full-state op exists', async () => {
    opLogStore.getLatestFullStateOpEntry.and.resolveTo(undefined);
    expect(await service.shouldPublish()).toBe(true);
    expect(opLogStore.getOpsAfterSeq).toHaveBeenCalledWith(0);
  });

  it('counts only ops after the newest full-state op', async () => {
    await service.shouldPublish();
    expect(opLogStore.getOpsAfterSeq).toHaveBeenCalledWith(8);
  });

  it('publishes at most once per session', async () => {
    expect(await service.shouldPublish()).toBe(true);
    service.markPublished();
    expect(await service.shouldPublish()).toBe(false);
  });

  it('checks the session latch before touching the store', async () => {
    service.markPublished();
    await service.shouldPublish();
    expect(opLogStore.getUnsynced).not.toHaveBeenCalled();
    expect(containerAuthority.isContainerManaged).not.toHaveBeenCalled();
  });
});
