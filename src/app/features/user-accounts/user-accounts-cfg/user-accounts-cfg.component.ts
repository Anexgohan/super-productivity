/**
 * The Accounts settings section (anex/container-parity).
 *
 * Layout follows pankha's AccountsTab: "Your account" for every rank, with user
 * management and the self-registration toggle rendering for admins only.
 */
import {
  ChangeDetectionStrategy,
  ChangeDetectorRef,
  Component,
  inject,
  Input,
  OnInit,
  signal,
} from '@angular/core';
import { FormsModule } from '@angular/forms';
import { MatButton, MatIconButton } from '@angular/material/button';
import { MatIcon } from '@angular/material/icon';
import { MatFormField, MatLabel, MatHint } from '@angular/material/form-field';
import { MatInput } from '@angular/material/input';
import { MatSelect } from '@angular/material/select';
import { MatOption } from '@angular/material/core';
import { MatSlideToggle } from '@angular/material/slide-toggle';
import { MatTooltip } from '@angular/material/tooltip';
import { MatDialog } from '@angular/material/dialog';
import { TranslatePipe, TranslateService } from '@ngx-translate/core';
import { T } from '../../../t.const';
import { ConfigFormSection } from '../../config/global-config.model';
import { SnackService } from '../../../core/snack/snack.service';
import { Log } from '../../../core/log';
import {
  UserAccountsService,
  type CurrentUser,
  type Role,
  type UserChanges,
  type UserRow,
} from '../user-accounts.service';
import { DialogConfirmDeleteAccountComponent } from '../dialog-confirm-delete-account/dialog-confirm-delete-account.component';
import { DialogEditAccountComponent } from '../dialog-edit-account/dialog-edit-account.component';

const MIN_PASSWORD_LENGTH = 8;

@Component({
  selector: 'user-accounts-cfg',
  templateUrl: './user-accounts-cfg.component.html',
  styleUrls: ['./user-accounts-cfg.component.scss'],
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [
    FormsModule,
    MatButton,
    MatIconButton,
    MatIcon,
    MatFormField,
    MatLabel,
    MatHint,
    MatInput,
    MatSelect,
    MatOption,
    MatSlideToggle,
    MatTooltip,
    TranslatePipe,
  ],
})
export class UserAccountsCfgComponent implements OnInit {
  private readonly _api = inject(UserAccountsService);
  private readonly _snack = inject(SnackService);
  private readonly _translate = inject(TranslateService);
  private readonly _matDialog = inject(MatDialog);
  private readonly _cd = inject(ChangeDetectorRef);

  // Set by ConfigSectionComponent when it instantiates us; unused here, but the
  // host assigns them unconditionally.
  @Input() cfg?: unknown;
  @Input() section?: ConfigFormSection<unknown>;

  readonly T = T;
  readonly ROLES: Role[] = ['admin', 'operator', 'viewer'];
  readonly MIN_PASSWORD_LENGTH = MIN_PASSWORD_LENGTH;

  readonly me = signal<CurrentUser | null>(null);
  readonly users = signal<UserRow[]>([]);
  readonly isRegistrationEnabled = signal(false);
  readonly isBusy = signal(false);
  readonly isAddFormOpen = signal(false);

  email = '';
  currentPassword = '';
  newPassword = '';
  confirmPassword = '';

  newUsername = '';
  newUserPassword = '';
  newUserEmail = '';
  newUserRole: Role = 'operator';

  get isAdmin(): boolean {
    return this.me()?.role === 'admin';
  }

  /** Guards the UI against actions the server would refuse anyway. */
  get adminCount(): number {
    return this.users().filter((u) => u.role === 'admin').length;
  }

  async ngOnInit(): Promise<void> {
    try {
      const me = await this._api.me();
      this.me.set(me);
      this.email = me.email ?? '';
    } catch (err) {
      Log.err('UserAccountsCfg: failed to load current user', err);
      return;
    }
    if (this.isAdmin) {
      await this._reloadUsers();
      try {
        this.isRegistrationEnabled.set((await this._api.getRegistration()).isEnabled);
      } catch (err) {
        Log.err('UserAccountsCfg: failed to load registration setting', err);
      }
    }
    this._cd.markForCheck();
  }

  private async _reloadUsers(): Promise<void> {
    try {
      this.users.set(await this._api.listUsers());
    } catch (err) {
      this._fail(err);
    }
    this._cd.markForCheck();
  }

  private _fail(err: unknown): void {
    this._snack.open({
      type: 'ERROR',
      msg: err instanceof Error ? err.message : 'Request failed',
    });
  }

  private _ok(key: string, params?: Record<string, unknown>): void {
    this._snack.open({ type: 'SUCCESS', msg: this._translate.instant(key, params) });
  }

  // ── Your account ──────────────────────────────────────────────────────────
  async saveEmail(): Promise<void> {
    this.isBusy.set(true);
    try {
      const trimmed = this.email.trim();
      await this._api.updateOwnEmail(trimmed || null);
      this.me.update((m) => (m ? { ...m, email: trimmed || null } : m));
      this._ok(T.GCF.ACCOUNTS.EMAIL_SAVED);
    } catch (err) {
      this._fail(err);
    } finally {
      this.isBusy.set(false);
      this._cd.markForCheck();
    }
  }

  async changePassword(): Promise<void> {
    if (this.newPassword !== this.confirmPassword) {
      this._snack.open({
        type: 'ERROR',
        msg: this._translate.instant(T.GCF.ACCOUNTS.PASSWORDS_DO_NOT_MATCH),
      });
      return;
    }
    this.isBusy.set(true);
    try {
      await this._api.changeOwnPassword(this.currentPassword, this.newPassword);
      this.currentPassword = '';
      this.newPassword = '';
      this.confirmPassword = '';
      this._ok(T.GCF.ACCOUNTS.PASSWORD_CHANGED);
    } catch (err) {
      this._fail(err);
    } finally {
      this.isBusy.set(false);
      this._cd.markForCheck();
    }
  }

  // ── Manage users (admin) ──────────────────────────────────────────────────
  async createUser(): Promise<void> {
    this.isBusy.set(true);
    try {
      await this._api.createUser({
        username: this.newUsername.trim(),
        password: this.newUserPassword,
        role: this.newUserRole,
        email: this.newUserEmail.trim() || null,
      });
      this.newUsername = '';
      this.newUserPassword = '';
      this.newUserEmail = '';
      this.newUserRole = 'operator';
      this.isAddFormOpen.set(false);
      this._ok(T.GCF.ACCOUNTS.USER_CREATED);
      await this._reloadUsers();
    } catch (err) {
      this._fail(err);
    } finally {
      this.isBusy.set(false);
      this._cd.markForCheck();
    }
  }

  /** Username, email, role and password in one dialog — see the dialog's docs. */
  editUser(user: UserRow): void {
    this._matDialog
      .open(DialogEditAccountComponent, {
        data: { user, isLastAdmin: this.isLastAdmin(user) },
      })
      .afterClosed()
      .subscribe(async (changes?: UserChanges) => {
        if (!changes) return;
        try {
          await this._api.updateUser(user.id, changes);
          this._ok(T.GCF.ACCOUNTS.USER_UPDATED);
          await this._reloadUsers();
        } catch (err) {
          this._fail(err);
        }
      });
  }

  /**
   * Reorders locally first so the row moves under the pointer, then persists
   * the whole list. A failed save reloads, snapping back to what the server
   * actually holds rather than leaving the two disagreeing.
   */
  async move(user: UserRow, delta: number): Promise<void> {
    const list = [...this.users()];
    const i = list.findIndex((u) => u.id === user.id);
    const j = i + delta;
    if (i < 0 || j < 0 || j >= list.length) return;
    [list[i], list[j]] = [list[j], list[i]];
    this.users.set(list);
    this._cd.markForCheck();

    try {
      await this._api.setOrder(list.map((u) => u.id));
    } catch (err) {
      this._fail(err);
      await this._reloadUsers();
    }
  }

  /** Purges the account and everything it has ever synced, so it asks twice. */
  deleteUser(user: UserRow): void {
    this._matDialog
      .open(DialogConfirmDeleteAccountComponent, { data: { username: user.username } })
      .afterClosed()
      .subscribe(async (isConfirmed: boolean) => {
        if (!isConfirmed) return;
        try {
          await this._api.deleteUser(user.id);
          this._ok(T.GCF.ACCOUNTS.USER_DELETED);
          await this._reloadUsers();
        } catch (err) {
          this._fail(err);
        }
      });
  }

  async toggleRegistration(isEnabled: boolean): Promise<void> {
    try {
      const result = await this._api.setRegistration(isEnabled);
      this.isRegistrationEnabled.set(result.isEnabled);
    } catch (err) {
      this._fail(err);
      this.isRegistrationEnabled.set(!isEnabled);
    }
    this._cd.markForCheck();
  }

  /** The last admin cannot be demoted or deleted — the server refuses too. */
  isLastAdmin(user: UserRow): boolean {
    return user.role === 'admin' && this.adminCount <= 1;
  }

  isSelf(user: UserRow): boolean {
    return user.username === this.me()?.username;
  }

  trackById(_i: number, user: UserRow): number {
    return user.id;
  }
}
