import { inject, Injectable } from '@angular/core';
import { OperationLogStoreService } from '../../op-log/persistence/operation-log-store.service';
import { SyncLog } from '../../core/log';

/** What the container says this browser is entitled to hold. */
interface ServedIdentity {
  instanceId: string;
  userId: number;
}

/** Outcome of the check, for logging and tests. */
export type ReplicaIdentityOutcome =
  /** No identity served — legacy or non-container deployment. Nothing to enforce. */
  | 'ungated'
  /** Could not reach the container. Unverifiable, so deliberately left alone. */
  | 'unverified'
  /** Replica had no stamp; it now carries the current one. */
  | 'adopted'
  /** Stamp matches the signed-in identity. */
  | 'matched'
  /** Stamp belonged to someone else; the replica was destroyed. */
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
      const served = await this._fetchServedIdentity();
      if (!served) {
        return 'ungated';
      }

      const stamp = await this._opLogStore.getReplicaIdentity();

      if (!stamp) {
        // Either a fresh browser or one that predates stamping. Adopting is the
        // only non-destructive read: an unstamped replica on an upgraded stack
        // is almost always the signed-in user's own, and purging every existing
        // browser once on rollout would be a worse trade than the narrow case
        // it protects against.
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
   * Reads the identity the container serves for this session.
   *
   * Its own request rather than reusing ContainerAuthorityService.loadOverride:
   * that call also latches IS_CONTAINER_MANAGED, and moving when the latch
   * settles is a behaviour change this gate has no business making.
   *
   * Returns undefined for every "cannot tell" case — no session, a deployment
   * serving the baked single-account file, an unreachable bridge — because the
   * only safe reading of an unknown identity is to enforce nothing.
   */
  private async _fetchServedIdentity(): Promise<ServedIdentity | undefined> {
    const res = await fetch('/assets/sync-config-default-override.json', {
      cache: 'no-store',
    });
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
    return identity;
  }
}
