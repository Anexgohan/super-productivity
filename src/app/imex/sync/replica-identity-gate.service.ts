import { inject, Injectable } from '@angular/core';
import { OperationLogStoreService } from '../../op-log/persistence/operation-log-store.service';
import { SyncLog } from '../../core/log';

/** What the container says this browser is entitled to hold. */
interface ServedIdentity {
  instanceId: string;
  userId: number;
  /** False on a stack whose data was wiped — see the unstamped case below. */
  serverHasData: boolean;
}

/** Outcome of the check, for logging and tests. */
export type ReplicaIdentityOutcome =
  /** No identity served — legacy or non-container deployment. Nothing to enforce. */
  | 'ungated'
  /** Could not reach the container. Unverifiable, so deliberately left alone. */
  | 'unverified'
  /** Container is there but no valid session; the app is being sent to /login. */
  | 'unauthenticated'
  /** Replica had no stamp; it now carries the current one. */
  | 'adopted'
  /** Stamp matches the signed-in identity. */
  | 'matched'
  /** Stamp belonged to someone else, or to a stack that no longer holds data. */
  | 'purged';

/**
 * Gate that keeps a browser from holding data it has no claim to.
 *
 * Upstream SP is peer-to-peer: every client is a full replica with an equal
 * claim on the data, and the local copy is anonymous — it belongs to no one in
 * particular, so whoever opens the tab next inherits it. Under container
 * authority that is wrong twice over. A second user signing in on a shared
 * machine would hydrate the first user's board, and a stack whose database was
 * wiped would be repopulated from a stale tab that still considered itself a
 * peer with history (see ServerMigrationService's empty-server path).
 *
 * Stamping the replica with `(instanceId, userId)` demotes it from a peer to a
 * cache with provenance. It still holds everything, so offline use and the
 * local-first feel are untouched — it just can no longer claim that data as its
 * own when the identity behind it changes.
 *
 * Runs before the store hydrates (see DataInitService.reInit), because the
 * point is that the wrong user's data is never rendered, never merged and never
 * uploaded — not that it is cleaned up afterwards.
 */
@Injectable({ providedIn: 'root' })
export class ReplicaIdentityGateService {
  private _opLogStore = inject(OperationLogStoreService);

  /**
   * Compares the served identity against the replica's stamp and purges on a
   * mismatch.
   *
   * Never throws: this sits in front of app startup, and a browser that cannot
   * boot is worse than one holding a stale cache. Any failure resolves to
   * leaving the replica alone.
   */
  async enforce(): Promise<ReplicaIdentityOutcome> {
    try {
      const probe = await this._probeContainer();
      if (probe === 'unauthenticated') {
        // The container is serving this path but will not name us, so the app
        // is about to render someone's data with no idea whose. Send the
        // browser to sign in instead. Without this, a cleared cookie booted the
        // app straight past container authority into upstream's manual sync UI.
        SyncLog.log('ReplicaIdentityGate: no session for this container — to /login');
        window.location.href = '/login';
        return 'unauthenticated';
      }
      const served = probe;
      if (!served) {
        return 'ungated';
      }

      const stamp = await this._opLogStore.getReplicaIdentity();

      if (!stamp) {
        // Nothing to compare against: a fresh browser, or one that predates
        // stamping. Which it is turns on whether the stack still holds data.
        //
        // Server has data: adopt. The replica is almost certainly this user's
        // own and the server is authoritative anyway, so keeping it costs a
        // re-download rather than correctness.
        //
        // Server is empty: purge. An unstamped replica facing an empty stack is
        // the resurrection case — left alone it would upload itself back and
        // undo the wipe. The cost is a genuine fresh-deploy recovery, where the
        // browser held the only copy; that is deliberately traded away, because
        // "I wiped the stack" must mean the data is gone.
        if (!served.serverHasData) {
          SyncLog.log(
            'ReplicaIdentityGate: unstamped replica on an empty stack — purging ' +
              'rather than letting it re-seed the server.',
          );
          await this._opLogStore.purgeForIdentityMismatch();
          await this._opLogStore.setReplicaIdentity(served);
          return 'purged';
        }
        await this._opLogStore.setReplicaIdentity(served);
        return 'adopted';
      }

      if (stamp.instanceId === served.instanceId && stamp.userId === served.userId) {
        return 'matched';
      }

      SyncLog.log(
        `ReplicaIdentityGate: replica belongs to instance ${stamp.instanceId}/user ${stamp.userId}, ` +
          `session is ${served.instanceId}/user ${served.userId} — purging local replica.`,
      );
      await this._opLogStore.purgeForIdentityMismatch();
      // Re-stamp after the purge, not before: purging clears META too, so a
      // stamp written first would be wiped and the next start would see an
      // unstamped replica and silently adopt it.
      await this._opLogStore.setReplicaIdentity(served);
      return 'purged';
    } catch (err) {
      SyncLog.err('ReplicaIdentityGate: check failed, leaving replica untouched', err);
      return 'unverified';
    }
  }

  /**
   * Asks the container who this browser is.
   *
   * Its own request rather than reusing ContainerAuthorityService.loadOverride:
   * that call also latches IS_CONTAINER_MANAGED, and moving when the latch
   * settles is a behaviour change this gate has no business making.
   *
   * Three distinguishable answers, and the distinction is the point:
   *  - `'unauthenticated'` (401/403) — a container IS serving this path, it just
   *    will not say who we are. Only reachable with auth enabled, because the
   *    route is not registered otherwise.
   *  - `undefined` — nothing to enforce: a deployment serving the baked
   *    single-account file (200, no identity), no such file (404), or an
   *    unreachable bridge.
   *  - an identity — proceed.
   *
   * Collapsing the first two, as this used to, is what let a cleared cookie
   * look like "not container-managed" and fall through to stock upstream sync.
   */
  private async _probeContainer(): Promise<
    ServedIdentity | undefined | 'unauthenticated'
  > {
    const res = await fetch('/assets/sync-config-default-override.json', {
      cache: 'no-store',
    });
    if (res.status === 401 || res.status === 403) {
      return 'unauthenticated';
    }
    if (!res.ok) {
      return undefined;
    }
    const body = (await res.json()) as { identity?: unknown };
    const identity = body?.identity as ServedIdentity | undefined;
    if (
      !identity ||
      typeof identity.instanceId !== 'string' ||
      typeof identity.userId !== 'number'
    ) {
      return undefined;
    }
    // Older bridges served an identity without this flag. Treating a missing
    // value as "has data" keeps them on the non-destructive branch.
    return { ...identity, serverHasData: identity.serverHasData !== false };
  }
}
