import { TestBed } from '@angular/core/testing';
import {
  ContainerAuthorityService,
  IS_CONTAINER_MANAGED,
  IS_READ_ONLY_BOARD,
} from './container-authority.service';

/**
 * Covers the read-only flag only. It is the half of the shared-board feature the client was missing: the bridge has always served `isReadOnly` and
 * nothing read it, so the app kept uploading to a board it holds a read-scoped token for until its own sync wedged behind a rejected full-state op.
 */
describe('ContainerAuthorityService: read-only board', () => {
  let service: ContainerAuthorityService;

  /** A complete override, which is the only shape treated as authoritative. */
  const override = (extra: Record<string, unknown> = {}): Record<string, unknown> => ({
    syncProvider: 'SuperSync',
    superSync: { baseUrl: 'https://sync.example', accessToken: 'tok' },
    ...extra,
  });

  const respondWith = (body: unknown, ok = true): void => {
    spyOn(window, 'fetch').and.resolveTo({
      ok,
      status: ok ? 200 : 404,
      json: () => Promise.resolve(body),
    } as Response);
  };

  beforeEach(() => {
    TestBed.configureTestingModule({ providers: [ContainerAuthorityService] });
    service = TestBed.inject(ContainerAuthorityService);
    IS_READ_ONLY_BOARD.set(false);
  });

  // Both are module-level signals that outlive the TestBed.
  afterEach(() => {
    IS_READ_ONLY_BOARD.set(false);
    IS_CONTAINER_MANAGED.set(false);
  });

  it('is set when the container says the board is read-only', async () => {
    respondWith(override({ isReadOnly: true }));
    await service.loadOverride();
    expect(IS_READ_ONLY_BOARD()).toBe(true);
  });

  it('is not set for your own board', async () => {
    respondWith(override({ isReadOnly: false }));
    await service.loadOverride();
    expect(IS_READ_ONLY_BOARD()).toBe(false);
  });

  it('is not set when the field is absent, so an older bridge stays writable', async () => {
    respondWith(override());
    await service.loadOverride();
    expect(IS_READ_ONLY_BOARD()).toBe(false);
  });

  it('clears on a later load, so switching back to your own board can write again', async () => {
    // The one that matters in practice: unlike IS_CONTAINER_MANAGED this must never latch, or a
    // stale true would follow the user home and silently stop their own board syncing.
    IS_READ_ONLY_BOARD.set(true);
    respondWith(override({ isReadOnly: false }));
    await service.loadOverride();
    expect(IS_READ_ONLY_BOARD()).toBe(false);
  });

  it('only trusts a literal true', async () => {
    respondWith(override({ isReadOnly: 'yes' }));
    await service.loadOverride();
    expect(IS_READ_ONLY_BOARD()).toBe(false);
  });

  it('leaves the flag alone when there is no override to read', async () => {
    IS_READ_ONLY_BOARD.set(true);
    respondWith(undefined, false);
    await service.loadOverride();
    // Deliberately untouched rather than reset: no container answered, so this deployment has nothing to say about the board either way.
    expect(IS_READ_ONLY_BOARD()).toBe(true);
  });

  it('leaves the flag alone for an incomplete override', async () => {
    IS_READ_ONLY_BOARD.set(true);
    respondWith({ syncProvider: 'SuperSync', isReadOnly: false });
    await service.loadOverride();
    expect(IS_READ_ONLY_BOARD()).toBe(true);
  });
});
