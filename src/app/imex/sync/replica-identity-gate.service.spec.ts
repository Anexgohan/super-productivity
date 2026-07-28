import { TestBed } from '@angular/core/testing';
import { ReplicaIdentityGateService } from './replica-identity-gate.service';
import { OperationLogStoreService } from '../../op-log/persistence/operation-log-store.service';
import { IS_READ_ONLY_BOARD } from './container-authority.service';

describe('ReplicaIdentityGateService', () => {
  let service: ReplicaIdentityGateService;
  let mockOpLogStore: jasmine.SpyObj<OperationLogStoreService>;
  let redirectSpy: jasmine.Spy;

  const SERVED = { instanceId: 'inst-a', userId: 1, serverHasData: true };

  /** Stands in for the container's per-session override response. */
  const respondWith = (body: unknown, ok = true, status = ok ? 200 : 500): void => {
    spyOn(window, 'fetch').and.resolveTo({
      ok,
      status,
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
    // Stubbed for EVERY test, not just the two that expect a redirect. Letting the real one run
    // navigates the Karma runner page away, and because Jasmine randomizes spec order that silently
    // truncates the whole suite at a different point each run.
    redirectSpy = spyOn(service as any, '_redirectToLogin');
  });

  describe('the read-only board flag', () => {
    // Set from this gate as well as ContainerAuthorityService because this is the earliest reader
    // of the document: it runs before the store hydrates, so before any sync can start. Set it only
    // in the other place and the first upload of a shared board goes out before anything knows.
    afterEach(() => IS_READ_ONLY_BOARD.set(false));

    it('is raised before the gate has decided anything', async () => {
      respondWith({ isReadOnly: true, identity: { ...SERVED } });
      mockOpLogStore.getReplicaIdentity.and.resolveTo({ ...SERVED });

      await service.enforce();

      expect(IS_READ_ONLY_BOARD()).toBe(true);
    });

    it('is cleared for your own board', async () => {
      IS_READ_ONLY_BOARD.set(true);
      respondWith({ isReadOnly: false, identity: { ...SERVED } });
      mockOpLogStore.getReplicaIdentity.and.resolveTo({ ...SERVED });

      await service.enforce();

      expect(IS_READ_ONLY_BOARD()).toBe(false);
    });

    it('is raised even when the identity is unusable, so an odd payload cannot open writes', async () => {
      respondWith({ isReadOnly: true, identity: { userId: 'nope' } });

      expect(await service.enforce()).toBe('ungated');
      expect(IS_READ_ONLY_BOARD()).toBe(true);
    });

    it('is left alone when the container cannot be reached', async () => {
      // Nothing answered, so nothing said the board became writable. Failing closed keeps a
      // read-only session read-only across a blip rather than letting one upload through.
      IS_READ_ONLY_BOARD.set(true);
      respondWith({ error: 'Service Unavailable' }, false, 503);

      await service.enforce();

      expect(IS_READ_ONLY_BOARD()).toBe(true);
    });
  });

  describe('when the deployment serves no identity', () => {
    it('is ungated for a response without an identity (baked fallback file)', async () => {
      respondWith({ syncProvider: 'SuperSync', superSync: {} });
      mockOpLogStore.getReplicaIdentity.and.resolveTo(undefined);

      expect(await service.enforce()).toBe('ungated');
      expect(mockOpLogStore.purgeForIdentityMismatch).not.toHaveBeenCalled();
      expect(mockOpLogStore.setReplicaIdentity).not.toHaveBeenCalled();
    });

    it('is ungated on a non-OK response that is not an auth failure', async () => {
      respondWith({ error: 'Service Unavailable' }, false, 503);

      expect(await service.enforce()).toBe('ungated');
      expect(mockOpLogStore.purgeForIdentityMismatch).not.toHaveBeenCalled();
    });

    it('is ungated when the identity is malformed', async () => {
      respondWith({ identity: { instanceId: 'inst-a', userId: 'not-a-number' } });

      expect(await service.enforce()).toBe('ungated');
      expect(mockOpLogStore.purgeForIdentityMismatch).not.toHaveBeenCalled();
    });
  });

  describe('when the container will not name us', () => {
    // The bypass these cover: a cleared cookie used to read as "not
    // container-managed", so the app booted into upstream's manual sync UI
    // holding the previous user's replica.
    for (const status of [401, 403]) {
      it(`redirects to /login on ${status} instead of falling through`, async () => {
        respondWith({ error: 'Not signed in' }, false, status);
        mockOpLogStore.getReplicaIdentity.and.resolveTo({ ...SERVED });

        expect(await service.enforce()).toBe('unauthenticated');
        expect(redirectSpy).toHaveBeenCalled();
        expect(mockOpLogStore.purgeForIdentityMismatch).not.toHaveBeenCalled();
        expect(mockOpLogStore.setReplicaIdentity).not.toHaveBeenCalled();
      });
    }
  });

  describe('when an identity is served', () => {
    it('adopts an unstamped replica when the stack still holds data', async () => {
      respondWith({ identity: SERVED });
      mockOpLogStore.getReplicaIdentity.and.resolveTo(undefined);

      expect(await service.enforce()).toBe('adopted');
      expect(mockOpLogStore.setReplicaIdentity).toHaveBeenCalledWith(SERVED);
      expect(mockOpLogStore.purgeForIdentityMismatch).not.toHaveBeenCalled();
    });

    it('purges an unstamped replica when the stack was wiped', async () => {
      respondWith({ identity: { ...SERVED, serverHasData: false } });
      mockOpLogStore.getReplicaIdentity.and.resolveTo(undefined);

      expect(await service.enforce()).toBe('purged');
      expect(mockOpLogStore.purgeForIdentityMismatch).toHaveBeenCalled();
    });

    it('adopts when an older bridge omits serverHasData', async () => {
      respondWith({ identity: { instanceId: 'inst-a', userId: 1 } });
      mockOpLogStore.getReplicaIdentity.and.resolveTo(undefined);

      expect(await service.enforce()).toBe('adopted');
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
