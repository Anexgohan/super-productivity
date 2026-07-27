import { inject, Injectable } from '@angular/core';
import { OperationLogStoreService } from '../../op-log/persistence/operation-log-store.service';
import { ContainerAuthorityService } from './container-authority.service';
import { SyncLog } from '../../core/log';

/**
 * Ops allowed to accumulate after the newest full-state op before a fresh baseline is published.
 *
 * This bounds download and replay size, not key derivations.
 * With a deployment-wide salt every op shares one key, so a long history is slow to replay but no longer expensive to decrypt.
 * A generous value is therefore fine, and each publish costs a full-state upload.
 */
export const SYNC_BASELINE_THRESHOLD = 50;

/**
 * Decides when this client should publish a fresh full-state baseline.
 *
 * A cold client asks for everything and is fast-forwarded to the newest full-state op, replaying only what came after it.
 * When nothing has superseded a long history that skip saves nothing, and the client replays the lot.
 * A 113-op board took 13.7s to show data, ~9.5s of it deriving one key per salt the history had accumulated.
 * Publishing a new full-state op gives the server something recent to skip to.
 *
 * NOT the same thing as OperationLogCompactionService, despite the overlap in spirit.
 * That one prunes the LOCAL IndexedDB log and never writes to the server, so it does nothing for what a new client downloads.
 * This publishes a server-side baseline and leaves local storage alone.
 *
 * Deliberately decides only, and does not act.
 * The upload lives in SyncWrapperService, and injecting that here would close a DI cycle, so the caller owns the doing.
 */
@Injectable({ providedIn: 'root' })
export class SyncBaselineService {
  private _opLogStore = inject(OperationLogStoreService);
  private _containerAuthority = inject(ContainerAuthorityService);

  /**
   * Latched for the tab's lifetime.
   *
   * Publishing rewrites the log so the next check is false by itself, but only once the write has landed and been read back.
   * The latch covers the gap in between, where a second sync could otherwise start a duplicate full-state upload.
   */
  private _hasPublishedThisSession = false;

  /** Records that a baseline went out, so this session does not publish a second one. */
  markPublished(): void {
    this._hasPublishedThisSession = true;
  }

  /**
   * Whether a fresh baseline is worth publishing right now.
   *
   * Every guard here is a reason NOT to write full state, and the order is cheapest-first.
   */
  async shouldPublish(): Promise<boolean> {
    if (this._hasPublishedThisSession) {
      return false;
    }

    // Container-managed only. Elsewhere the user owns their sync config, and silently rewriting their remote history is not ours to decide.
    if (!(await this._containerAuthority.isContainerManaged())) {
      return false;
    }

    // A baseline claims to be the whole truth, so anything not yet uploaded would be published as though it never happened.
    const unsynced = await this._opLogStore.getUnsynced();
    if (unsynced.length > 0) {
      return false;
    }

    const latestFullState = await this._opLogStore.getLatestFullStateOpEntry();
    // No full-state op at all means every cold client replays the entire history, which is the case this exists for.
    const sinceSeq = latestFullState?.seq ?? 0;
    const tailOps = await this._opLogStore.getOpsAfterSeq(sinceSeq);
    if (tailOps.length <= SYNC_BASELINE_THRESHOLD) {
      return false;
    }

    SyncLog.normal('SyncBaseline: history is long enough to republish', {
      opsSinceFullState: tailOps.length,
      threshold: SYNC_BASELINE_THRESHOLD,
    });
    return true;
  }
}
