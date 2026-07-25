import { TestBed } from '@angular/core/testing';
import { ReplicaIdentityGateService } from './replica-identity-gate.service';
import { OperationLogStoreService } from '../../op-log/persistence/operation-log-store.service';

describe('ReplicaIdentityGateService', () => {
  let service: ReplicaIdentityGateService;
  let mockOpLogStore: jasmine.SpyObj<OperationLogStoreService>;

  const SERVED = { instanceId: 'inst-a', userId: 1 };

  /** Stands in for the container's per-session override response. */
  const respondWith = (body: unknown, ok = true): void => {
    spyOn(window, 'fetch').and.resolveTo({
      ok,
      json: () => Promise.resolve(body),
    } as Response);
  };

  beforeEach(() => {
    mockOpLogStore = jasmine.createSpyObj('OperationLogStoreService', [
      'getReplicaIdentity',
      'setReplicaIdentity',
      'purgeForIdentityMismatch',
    ]);
    mockOpLogStore.setReplicaIdentity.and.resolveTo(undefined);
    mockOpLogStore.purgeForIdentityMismatch.and.resolveTo(undefined);

    TestBed.configureTestingModule({
      providers: [
        ReplicaIdentityGateService,
        { provide: OperationLogStoreService, useValue: mockOpLogStore },
      ],
    });
    service = TestBed.inject(ReplicaIdentityGateService);
  });

  describe('when the deployment serves no identity', () => {
    it('is ungated for a response without an identity (baked fallback file)', async () => {
      respondWith({ syncProvider: 'SuperSync', superSync: {} });
      mockOpLogStore.getReplicaIdentity.and.resolveTo(undefined);

      expect(await service.enforce()).toBe('ungated');
      expect(mockOpLogStore.purgeForIdentityMismatch).not.toHaveBeenCalled();
      expect(mockOpLogStore.setReplicaIdentity).not.toHaveBeenCalled();
    });

    it('is ungated when there is no session (non-OK response)', async () => {
      respondWith({ error: 'Not signed in' }, false);

      expect(await service.enforce()).toBe('ungated');
      expect(mockOpLogStore.purgeForIdentityMismatch).not.toHaveBeenCalled();
    });

    it('is ungated when the identity is malformed', async () => {
      respondWith({ identity: { instanceId: 'inst-a', userId: 'not-a-number' } });

      expect(await service.enforce()).toBe('ungated');
      expect(mockOpLogStore.purgeForIdentityMismatch).not.toHaveBeenCalled();
    });
  });

  describe('when an identity is served', () => {
    it('adopts an unstamped replica rather than destroying it', async () => {
      respondWith({ identity: SERVED });
      mockOpLogStore.getReplicaIdentity.and.resolveTo(undefined);

      expect(await service.enforce()).toBe('adopted');
      expect(mockOpLogStore.setReplicaIdentity).toHaveBeenCalledWith(SERVED);
      expect(mockOpLogStore.purgeForIdentityMismatch).not.toHaveBeenCalled();
    });

    it('leaves a matching replica alone', async () => {
      respondWith({ identity: SERVED });
      mockOpLogStore.getReplicaIdentity.and.resolveTo({ ...SERVED });

      expect(await service.enforce()).toBe('matched');
      expect(mockOpLogStore.purgeForIdentityMismatch).not.toHaveBeenCalled();
      expect(mockOpLogStore.setReplicaIdentity).not.toHaveBeenCalled();
    });

    it('purges when another account is signed in on this browser', async () => {
      respondWith({ identity: SERVED });
      mockOpLogStore.getReplicaIdentity.and.resolveTo({
        instanceId: 'inst-a',
        userId: 2,
      });

      expect(await service.enforce()).toBe('purged');
      expect(mockOpLogStore.purgeForIdentityMismatch).toHaveBeenCalled();
    });

    it('purges when the stack has been wiped and reissued its id', async () => {
      respondWith({ identity: SERVED });
      mockOpLogStore.getReplicaIdentity.and.resolveTo({
        instanceId: 'inst-before-the-wipe',
        userId: 1,
      });

      expect(await service.enforce()).toBe('purged');
      expect(mockOpLogStore.purgeForIdentityMismatch).toHaveBeenCalled();
    });

    it('re-stamps AFTER purging, since the purge clears META too', async () => {
      respondWith({ identity: SERVED });
      mockOpLogStore.getReplicaIdentity.and.resolveTo({
        instanceId: 'inst-old',
        userId: 9,
      });
      const callOrder: string[] = [];
      mockOpLogStore.purgeForIdentityMismatch.and.callFake(async () => {
        callOrder.push('purge');
      });
      mockOpLogStore.setReplicaIdentity.and.callFake(async () => {
        callOrder.push('stamp');
      });

      await service.enforce();

      expect(callOrder).toEqual(['purge', 'stamp']);
    });
  });

  describe('when the container cannot be reached', () => {
    it('leaves the replica untouched rather than purging on a network error', async () => {
      spyOn(window, 'fetch').and.rejectWith(new Error('offline'));
      mockOpLogStore.getReplicaIdentity.and.resolveTo({
        instanceId: 'inst-a',
        userId: 1,
      });

      expect(await service.enforce()).toBe('unverified');
      expect(mockOpLogStore.purgeForIdentityMismatch).not.toHaveBeenCalled();
    });

    it('does not let a store failure block startup', async () => {
      respondWith({ identity: SERVED });
      mockOpLogStore.getReplicaIdentity.and.rejectWith(new Error('idb closed'));

      expect(await service.enforce()).toBe('unverified');
    });
  });
});
