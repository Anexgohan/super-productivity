import { Injectable, inject } from '@angular/core';
import { firstValueFrom } from 'rxjs';
import { filter, first } from 'rxjs/operators';
import { IS_ELECTRON } from '../../app.constants';
import { DataInitStateService } from '../../core/data-init/data-init-state.service';
import { GlobalConfigService } from '../../features/config/global-config.service';
import { DEFAULT_GLOBAL_CONFIG } from '../../features/config/default-global-config.const';
import { SyncConfig } from '../../features/config/global-config.model';
import { SyncConfigService } from './sync-config.service';
import { SyncLog } from '../../core/log';

/**
 * Container zero-setup sync activation (anex/container-parity).
 *
 * When the served frontend ships a fully-specified SuperSync configuration in
 * /assets/sync-config-default-override.json (written by the Docker entrypoint
 * from env vars — baseUrl + accessToken at minimum), a fresh client activates
 * sync automatically on first boot: open the URL, get your data. No manual
 * provider selection, token paste, or server URL entry.
 *
 * Deliberately conservative:
 *  - web-only (containers serve browsers; Electron keeps its manual flow)
 *  - runs once after initial hydration
 *  - no-ops unless the override specifies SuperSync WITH baseUrl + accessToken
 *  - never touches an instance where a sync provider is already configured
 *
 * Reuses the exact save path a manual Settings→Sync form submit takes
 * (updateSettingsFromForm), so public/private config splitting, encryption
 * propagation, and op capture behave identically to a user-driven setup.
 */
@Injectable({ providedIn: 'root' })
export class SyncAutoSetupService {
  private _dataInitStateService = inject(DataInitStateService);
  private _globalConfigService = inject(GlobalConfigService);
  private _syncConfigService = inject(SyncConfigService);

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

    const currentSyncCfg = await firstValueFrom(this._globalConfigService.sync$);
    if (currentSyncCfg?.syncProvider) {
      return;
    }

    let override: Partial<SyncConfig> | undefined;
    try {
      const res = await fetch('/assets/sync-config-default-override.json');
      if (!res.ok) {
        return;
      }
      override = await res.json();
    } catch (e) {
      return;
    }

    const superSync = override?.superSync;
    if (
      override?.syncProvider !== 'SuperSync' ||
      !superSync?.baseUrl ||
      !superSync?.accessToken
    ) {
      // Partial overrides still work as form defaults via SyncConfigService;
      // only a complete config activates without user interaction.
      return;
    }

    const newSettings: SyncConfig = {
      ...DEFAULT_GLOBAL_CONFIG.sync,
      ...override,
      isEnabled: true,
      superSync: {
        ...DEFAULT_GLOBAL_CONFIG.sync.superSync,
        ...superSync,
        // Encryption is mandatory for SuperSync; when the passphrase is also
        // shipped, mark it enabled so no setup dialog appears at all.
        ...(superSync.encryptKey ? { isEncryptionEnabled: true } : {}),
      },
    };

    SyncLog.log('SyncAutoSetup: activating pre-configured SuperSync from override');
    await this._syncConfigService.updateSettingsFromForm(newSettings, true);
  }
}
