import { ChangeDetectionStrategy, Component, inject } from '@angular/core';
import {
  MAT_DIALOG_DATA,
  MatDialogActions,
  MatDialogContent,
  MatDialogRef,
  MatDialogTitle,
} from '@angular/material/dialog';
import { MatButton } from '@angular/material/button';
import { MatIcon } from '@angular/material/icon';
import { TranslatePipe, TranslateService } from '@ngx-translate/core';
import { T } from '../../../t.const';
import { LocaleDatePipe } from '../../../ui/pipes/locale-date.pipe';
import { ShortTimePipe } from '../../../ui/pipes/short-time.pipe';
import type { SyncImportReason } from '../../core/operation.types';
import { confirmDialog } from '../../../util/native-dialogs';
import { DateTimeFormatService } from '../../../core/date-time-format/date-time-format.service';

export interface SyncImportConflictData {
  filteredOpCount: number;
  localImportTimestamp: number;
  syncImportReason?: SyncImportReason;
  scenario: 'INCOMING_IMPORT' | 'LOCAL_IMPORT_FILTERS_REMOTE';
  /**
   * True when this client has never completed a sync. Its only local state is
   * pre-first-sync startup data (e.g. example tasks), so "USE_LOCAL" would overwrite
   * a populated remote with throwaway data — a destructive choice that warrants an
   * explicit extra confirmation. See the fresh-client first-sync data-loss-trap plan.
   */
  isNeverSynced?: boolean;
  /**
   * What each side actually holds, so the choice can be made on evidence
   * instead of on a bare count. `remoteSummary` is counted from the incoming
   * full-state payload; `localSummary` groups the pending ops that would be
   * discarded. Both optional — older callers and the
   * LOCAL_IMPORT_FILTERS_REMOTE path supply neither, and the template hides
   * the comparison when they are absent.
   */
  remoteSummary?: { label: string; count: number }[];
  localSummary?: { label: string; count: number }[];
  /** Server changes downloaded after its full state, so the server side is not shown as the old full state alone. */
  remoteLaterChanges?: { count: number; latestTimestamp: number | null };
  /**
   * Set when this browser holds an unsent full state of its own, usually a backup it just imported.
   * Then the server's full state is not news from another device, so the dialog names both sides with their times and recommends neither.
   */
  localImport?: { timestamp: number; summary: { label: string; count: number }[] };
}

export type SyncImportConflictResolution = 'USE_LOCAL' | 'USE_REMOTE' | 'CANCEL';

@Component({
  selector: 'dialog-sync-import-conflict',
  templateUrl: './dialog-sync-import-conflict.component.html',
  styleUrls: ['./dialog-sync-import-conflict.component.scss'],
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [
    MatDialogTitle,
    MatDialogContent,
    MatDialogActions,
    MatButton,
    MatIcon,
    TranslatePipe,
    LocaleDatePipe,
    ShortTimePipe,
  ],
})
export class DialogSyncImportConflictComponent {
  private _matDialogRef =
    inject<MatDialogRef<DialogSyncImportConflictComponent>>(MatDialogRef);
  private _translateService = inject(TranslateService);
  private _dateTimeFormatService = inject(DateTimeFormatService);
  data = inject<SyncImportConflictData>(MAT_DIALOG_DATA);

  // Exposed so the template can pass the reactive locale to the now-pure
  // `localeDate` pipe, preserving re-render on a locale change.
  readonly locale = this._dateTimeFormatService.currentLocale;

  T: typeof T = T;

  private static readonly _REASON_KEYS: Record<string, string> = {
    PASSWORD_CHANGED: T.F.SYNC.D_SYNC_IMPORT_CONFLICT.REASON_PASSWORD_CHANGED,
    FILE_IMPORT: T.F.SYNC.D_SYNC_IMPORT_CONFLICT.REASON_FILE_IMPORT,
    BACKUP_RESTORE: T.F.SYNC.D_SYNC_IMPORT_CONFLICT.REASON_BACKUP_RESTORE,
    FORCE_UPLOAD: T.F.SYNC.D_SYNC_IMPORT_CONFLICT.REASON_FORCE_UPLOAD,
    SERVER_MIGRATION: T.F.SYNC.D_SYNC_IMPORT_CONFLICT.REASON_SERVER_MIGRATION,
    REPAIR: T.F.SYNC.D_SYNC_IMPORT_CONFLICT.REASON_REPAIR,
  };

  get reasonKey(): string {
    const reason = this.data.syncImportReason;
    return (
      (reason && DialogSyncImportConflictComponent._REASON_KEYS[reason]) ||
      T.F.SYNC.D_SYNC_IMPORT_CONFLICT.REASON_UNKNOWN
    );
  }

  get messageKey(): string {
    if (this.isOwnImport) {
      return T.F.SYNC.D_SYNC_IMPORT_CONFLICT.MSG_OWN_IMPORT;
    }
    if (this.data.scenario === 'INCOMING_IMPORT') {
      return this.data.filteredOpCount > 0
        ? T.F.SYNC.D_SYNC_IMPORT_CONFLICT.MSG_INCOMING
        : T.F.SYNC.D_SYNC_IMPORT_CONFLICT.MSG_INCOMING_NO_OPS;
    }
    return T.F.SYNC.D_SYNC_IMPORT_CONFLICT.MSG_LOCAL_FILTERS;
  }

  get isIncomingImport(): boolean {
    return this.data.scenario === 'INCOMING_IMPORT';
  }

  /** This browser's own import against the server's data: no side is recommended. */
  get isOwnImport(): boolean {
    return this.isIncomingImport && !!this.data.localImport;
  }

  /** The server side and the buttons favour the server only when the incoming full state is news from another device. */
  get isServerRecommended(): boolean {
    return this.isIncomingImport && !this.isOwnImport;
  }

  /** An import replaces this browser's sync history, so "never synced" would be wrong after one. */
  get isNeverSynced(): boolean {
    return !!this.data.isNeverSynced && !this.isOwnImport;
  }

  /**
   * Only the incoming-import path can describe both sides. Without it the
   * dialog falls back to the old bare count rather than rendering two empty
   * columns, which would read as "both sides are empty".
   */
  get hasComparison(): boolean {
    return !!this.data.remoteSummary && !!this.data.localSummary;
  }

  constructor() {
    this._matDialogRef.disableClose = true;
  }

  close(result?: SyncImportConflictResolution): void {
    // Both choices lose one side for every device, so each is confirmed in words that name what goes.
    if (this.isOwnImport && (result === 'USE_LOCAL' || result === 'USE_REMOTE')) {
      const key =
        result === 'USE_LOCAL'
          ? T.F.SYNC.D_SYNC_IMPORT_CONFLICT.OWN_IMPORT_USE_LOCAL_CONFIRM
          : T.F.SYNC.D_SYNC_IMPORT_CONFLICT.OWN_IMPORT_USE_REMOTE_CONFIRM;
      if (!confirmDialog(this._translateService.instant(key))) {
        return;
      }
      this._matDialogRef.close(result);
      return;
    }
    // Guard the destructive choice on a never-synced client: USE_LOCAL here would
    // overwrite the populated remote with this device's throwaway startup data.
    // Require an explicit confirmation so it can't be triggered by a misclick.
    if (result === 'USE_LOCAL' && this.isNeverSynced) {
      const confirmed = confirmDialog(
        this._translateService.instant(
          T.F.SYNC.D_SYNC_IMPORT_CONFLICT.FIRST_SYNC_USE_LOCAL_CONFIRM,
        ),
      );
      if (!confirmed) {
        return;
      }
    }
    // Guard the destructive choice when it discards local work: accepting the
    // server import (USE_REMOTE) replaces this device's state and drops pending
    // local changes. The dialog frames the server as "recommended", so require
    // an explicit confirmation rather than letting a misclick silently wipe data
    // the user can't tell is newer than the server's. (#8107)
    if (
      result === 'USE_REMOTE' &&
      this.isIncomingImport &&
      this.data.filteredOpCount > 0
    ) {
      const confirmed = confirmDialog(
        this._translateService.instant(
          T.F.SYNC.D_SYNC_IMPORT_CONFLICT.USE_REMOTE_CONFIRM,
          { count: this.data.filteredOpCount },
        ),
      );
      if (!confirmed) {
        return;
      }
    }
    this._matDialogRef.close(result || 'CANCEL');
  }
}
