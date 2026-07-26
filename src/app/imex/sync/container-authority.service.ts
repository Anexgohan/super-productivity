import { Injectable, signal } from '@angular/core';
import { setDeploymentEncryptSalt, setKeyCacheStore } from '@sp/sync-core';
import { IS_ELECTRON } from '../../app.constants';
import { SyncConfig } from '../../features/config/global-config.model';

/** Local rather than imported: this service is deliberately a leaf, and a base64 decode is not worth a dependency. */
const base64ToBytes = (b64: string): Uint8Array =>
  Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));

const KEY_CACHE_STORAGE_KEY = 'SUP_sync_key_cache';

/**
 * Carries derived encryption keys across reloads.
 *
 * Deriving a key is deliberately expensive (Argon2id, ~200ms), and an op is decrypted with a key derived from its own salt.
 * A board spanning many salts pays that cost once per salt on EVERY cold load, recomputing bytes it already had.
 * Keeping them makes the second load, and every load after it, free.
 *
 * Installed only under container authority, where the deployment already hands this browser the encryption password itself.
 * The stored keys are less sensitive than that credential, so this adds no exposure that did not exist a line earlier.
 */
const installKeyCacheStore = (): void => {
  setKeyCacheStore({
    load: () => localStorage.getItem(KEY_CACHE_STORAGE_KEY),
    save: (serialized) => localStorage.setItem(KEY_CACHE_STORAGE_KEY, serialized),
  });
};

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

    // Deployment-wide Argon2 salt, applied here because this is where the container's config arrives, and it must precede the first decrypt.
    // Without it every session invents its own salt, so ops written on different days each cost a separate ~200ms derivation on read.
    //
    // Stripped afterwards: it is not part of SyncConfig, and leaving it would carry an unknown field into the synced config model.
    const withSalt = override.superSync as typeof override.superSync & {
      encryptSalt?: unknown;
    };
    if (typeof withSalt.encryptSalt === 'string' && withSalt.encryptSalt) {
      try {
        setDeploymentEncryptSalt(base64ToBytes(withSalt.encryptSalt));
      } catch {
        // Ignored on purpose: a malformed salt must not stop the app booting, and falling back to a per-session salt is slow, not broken.
      }
    }
    delete withSalt.encryptSalt;

    // Installed before the first decrypt, for the same reason the salt is: a store arriving later would miss the one load that needed it.
    installKeyCacheStore();

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
