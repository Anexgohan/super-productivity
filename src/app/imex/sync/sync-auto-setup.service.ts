import { Injectable, inject } from '@angular/core';
import { firstValueFrom } from 'rxjs';
import { filter, first } from 'rxjs/operators';
import { IS_ELECTRON } from '../../app.constants';
import { DataInitStateService } from '../../core/data-init/data-init-state.service';
import { GlobalConfigService } from '../../features/config/global-config.service';
import { DEFAULT_GLOBAL_CONFIG } from '../../features/config/default-global-config.const';
import { SyncConfig, SuperSyncConfig } from '../../features/config/global-config.model';
import { SyncProviderId } from '../../op-log/sync-providers/provider.const';
import { SyncConfigService } from './sync-config.service';
import { ContainerAuthorityService } from './container-authority.service';
import { SyncLog } from '../../core/log';

/**
 * Container zero-setup sync activation (anex/container-parity).
 *
 * When the served frontend ships a fully-specified SuperSync configuration in
 * /assets/sync-config-default-override.json (written by the Docker entrypoint
 * from env vars — baseUrl + accessToken at minimum), the container is treated
 * as the AUTHORITY for how to reach the sync server:
 *
 *  - fresh client  → activate sync outright (open the URL, get your data)
 *  - configured    → reconcile the CONNECTION fields on every boot
 *
 * Why reconcile rather than "set once": the access token is reissued whenever
 * the stack restarts, so a client that only ever adopted the first token it saw
 * drifts out of sync permanently and fails *silently* — it keeps polling with a
 * dead token and simply never receives data again. Adopting the container's
 * current values on each boot makes that class of drift structurally
 * impossible, and reduces rotating any secret to editing .env and restarting.
 *
 * Deliberately scoped:
 *  - web-only (containers serve browsers; Electron keeps its manual flow)
 *  - no-ops unless the override specifies SuperSync WITH baseUrl + accessToken,
 *    so a deployment that ships no override keeps the stock manual flow — that
 *    absence is the opt-out
 *  - only baseUrl / accessToken / encryptKey are container-owned; every other
 *    sync preference (interval, compression, manual-only, …) stays the user's
 *
 * Reuses the exact save path a manual Settings→Sync form submit takes
 * (updateSettingsFromForm), so public/private config splitting, encryption
 * propagation, and op capture behave identically to a user-driven setup.
 */
@Injectable({ providedIn: 'root' })
export class SyncAutoSetupService {
  private _dataInitStateService = inject(DataInitStateService);
  private _syncConfigService = inject(SyncConfigService);
  private _containerAuthority = inject(ContainerAuthorityService);
  private _globalConfigService = inject(GlobalConfigService);

  async init(): Promise<void> {
    if (IS_ELECTRON) {
      return;
    }

    await firstValueFrom(
      this._dataInitStateService.isAllDataLoadedInitially$.pipe(
        filter((v) => !!v),
        first(),
      ),
    );

    await this.reconcileFromContainer();
  }

  /**
   * Re-reads the container's override and adopts its connection config if it
   * differs from what this client holds. Returns true when something changed.
   *
   * Also called on repeated auth failure (see SyncWrapperService): a rejected
   * token usually means the stack reissued one, so re-reading the container is
   * the correct first recovery step — and it resolves silently, without asking
   * the user to reconfigure something the admin already owns.
   */
  async reconcileFromContainer(): Promise<boolean> {
    if (IS_ELECTRON) {
      return false;
    }

    const override = await this._containerAuthority.loadOverride();
    if (!override?.superSync) {
      return false;
    }
    const wanted = override.superSync;

    // This browser's own stored setup. Not syncSettingsForm$: that blends the container override in, so it names a provider for a fresh client.
    const stored = await firstValueFrom(this._globalConfigService.sync$);

    if (!stored?.syncProvider) {
      SyncLog.log('SyncAutoSetup: activating pre-configured SuperSync from override');
      await this._save(this._buildActivation(override, wanted));
      return true;
    }

    // syncSettingsForm$ merges the stored public config with the active
    // provider's private config, so this is the client's *effective* setup
    // (including the credentials the public config deliberately never holds).
    const current = await firstValueFrom(this._syncConfigService.syncSettingsForm$);

    const drift = this._connectionDrift(current, wanted);
    if (!drift.length) {
      return false;
    }
    SyncLog.log(
      `SyncAutoSetup: adopting container connection config (changed: ${drift.join(', ')})`,
    );
    await this._save(this._buildReconciliation(current, wanted));
    return true;
  }

  /** Which container-owned connection fields differ from what the client holds. */
  private _connectionDrift(current: SyncConfig, wanted: SuperSyncConfig): string[] {
    const cur = current.superSync ?? {};
    const drift: string[] = [];
    if (current.syncProvider !== SyncProviderId.SuperSync) {
      drift.push('syncProvider');
    }
    if (wanted.baseUrl && cur.baseUrl !== wanted.baseUrl) {
      drift.push('baseUrl');
    }
    if (wanted.accessToken && cur.accessToken !== wanted.accessToken) {
      drift.push('accessToken');
    }
    // encryptKey surfaces top-level on the form model (derived from private cfg).
    if (
      wanted.encryptKey &&
      (cur.encryptKey ?? current.encryptKey) !== wanted.encryptKey
    ) {
      drift.push('encryptKey');
    }
    return drift;
  }

  /** Fresh client: adopt the override wholesale and switch sync on. */
  private _buildActivation(
    override: Partial<SyncConfig>,
    wanted: SuperSyncConfig,
  ): SyncConfig {
    return {
      ...DEFAULT_GLOBAL_CONFIG.sync,
      ...override,
      isEnabled: true,
      superSync: {
        ...DEFAULT_GLOBAL_CONFIG.sync.superSync,
        ...wanted,
        // Encryption is mandatory for SuperSync; when the passphrase is also
        // shipped, mark it enabled so no setup dialog appears at all.
        ...(wanted.encryptKey ? { isEncryptionEnabled: true } : {}),
      },
    };
  }

  /**
   * Configured client: keep every user-chosen setting, replace only the
   * container-owned connection fields.
   */
  private _buildReconciliation(current: SyncConfig, wanted: SuperSyncConfig): SyncConfig {
    return {
      ...current,
      syncProvider: SyncProviderId.SuperSync,
      superSync: {
        ...DEFAULT_GLOBAL_CONFIG.sync.superSync,
        ...current.superSync,
        baseUrl: wanted.baseUrl,
        accessToken: wanted.accessToken,
        ...(wanted.encryptKey
          ? { encryptKey: wanted.encryptKey, isEncryptionEnabled: true }
          : {}),
      },
      ...(wanted.encryptKey
        ? { encryptKey: wanted.encryptKey, isEncryptionEnabled: true }
        : {}),
    };
  }

  private async _save(settings: SyncConfig): Promise<void> {
    await this._syncConfigService.updateSettingsFromForm(settings, true);
  }
}
