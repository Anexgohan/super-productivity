import { Injectable, signal } from '@angular/core';
import { IS_ELECTRON } from '../../app.constants';
import { SyncConfig } from '../../features/config/global-config.model';

/**
 * The same answer as `ContainerAuthorityService.isContainerManaged()`, readable
 * without injecting anything.
 *
 * It exists for the settings form consts, which are plain data evaluated
 * outside any injection context and so cannot ask the service. Kept beside the
 * service that owns the latch rather than in a shared const file, so there is
 * still exactly one place the answer is decided.
 *
 * Settled during startup, before any settings page can be opened.
 */
export const IS_CONTAINER_MANAGED = signal(false);

/**
 * Whether the served container is the AUTHORITY for this client
 * (anex/container-parity).
 *
 * The signal is the presence of a complete connection override at
 * /assets/sync-config-default-override.json: a deployment that ships one is
 * telling the browser where to sync and with what credentials, which only a
 * container that owns the data does. A build served without it keeps the stock
 * manual flow, and that absence is the opt-out.
 *
 * Two consumers need this answer for different reasons, which is why it lives
 * apart from either:
 *  - SyncAutoSetupService, to adopt the container's connection config
 *  - ServerMigrationService, to stop asking the user to arbitrate between
 *    client and server data — under container authority the server always
 *    wins, so the prompt offers a choice that has no second option
 *
 * Deliberately dependency-free. ServerMigrationService lives in op-log and
 * SyncAutoSetupService in imex/sync; routing the flag through either would put
 * a heavy service on the other's injection path (SyncAutoSetup → SyncConfig →
 * SyncWrapper is already a cycle we work around by dynamic import). A leaf
 * holder cannot participate in a cycle at all.
 */
@Injectable({ providedIn: 'root' })
export class ContainerAuthorityService {
  /**
   * Latched rather than cached. Once a deployment has identified itself as
   * container-managed it stays that way for the session, but a NEGATIVE answer
   * is never remembered — `loadOverride()` doubles as the re-read used to
   * recover from a rotated credential, and memoizing a miss would break it.
   */
  private _isContainerManaged = false;

  /**
   * Fetches the container's connection override, or undefined when this
   * deployment ships none.
   *
   * Partial overrides still work as form defaults via SyncConfigService; only a
   * complete config is authoritative enough to apply unattended, so anything
   * less is treated as absent here.
   */
  async loadOverride(): Promise<Partial<SyncConfig> | undefined> {
    if (IS_ELECTRON) {
      return undefined;
    }
    let override: Partial<SyncConfig> | undefined;
    try {
      const res = await fetch('/assets/sync-config-default-override.json');
      if (!res.ok) {
        return undefined;
      }
      override = await res.json();
    } catch {
      return undefined;
    }
    if (
      override?.syncProvider !== 'SuperSync' ||
      !override.superSync?.baseUrl ||
      !override.superSync?.accessToken
    ) {
      return undefined;
    }

    // A root-relative baseUrl (e.g. "/sync") means the container fronts sync on this origin; made absolute because WebSocket rejects relative URLs.
    if (override.superSync.baseUrl.startsWith('/')) {
      override = {
        ...override,
        superSync: {
          ...override.superSync,
          baseUrl: `${window.location.origin}${override.superSync.baseUrl.replace(/\/+$/, '')}`,
        },
      };
    }

    this._isContainerManaged = true;
    IS_CONTAINER_MANAGED.set(true);
    return override;
  }

  /**
   * Whether the container owns this client's data.
   *
   * Answers from the latch when startup has already established it; otherwise
   * looks, because sync can run before SyncAutoSetupService's boot pass (a
   * manual trigger, for instance) and a wrong `false` there would put the
   * migration prompt back in front of the user.
   */
  async isContainerManaged(): Promise<boolean> {
    if (this._isContainerManaged) {
      return true;
    }
    await this.loadOverride();
    return this._isContainerManaged;
  }
}
