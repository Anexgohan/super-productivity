/**
 * The Accounts settings section (anex/container-parity).
 *
 * One table for every rank: an admin sees every account, everyone else sees the single row they own.
 * Editing any account, your own included, goes through the row's dialog, so an account has one place to change it rather than two.
 */
import {
  ChangeDetectionStrategy,
  ChangeDetectorRef,
  Component,
  computed,
  inject,
  Input,
  OnInit,
  signal,
} from '@angular/core';
import { NgTemplateOutlet } from '@angular/common';
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
import { ShareService } from '../../../core/share/share.service';
import {
  UserAccountsService,
  type ApiKeyRow,
  type CurrentUser,
  type Role,
  type UserChanges,
  type UserRow,
} from '../user-accounts.service';
import { DialogConfirmDeleteAccountComponent } from '../dialog-confirm-delete-account/dialog-confirm-delete-account.component';
import {
  DialogEditAccountComponent,
  type EditAccountResult,
} from '../dialog-edit-account/dialog-edit-account.component';

const MIN_PASSWORD_LENGTH = 8;

@Component({
  selector: 'user-accounts-cfg',
  templateUrl: './user-accounts-cfg.component.html',
  styleUrls: ['./user-accounts-cfg.component.scss'],
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [
    NgTemplateOutlet,
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
  private readonly _share = inject(ShareService);

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

  /** Keys render as sub-rows under their owner, so several lists can be open at once and each user's rows are held against their own id. */
  readonly openKeyUserIds = signal<ReadonlySet<number>>(new Set());
  readonly keysByUser = signal<ReadonlyMap<number, ApiKeyRow[]>>(new Map());
  readonly revealedKeyIds = signal<ReadonlySet<number>>(new Set());
  /** Per user: the add-key field belongs to whichever list is expanded. */
  newKeyLabels: Record<number, string> = {};

  newUsername = '';
  newUserPassword = '';
  newUserEmail = '';
  newUserRole: Role = 'operator';

  get isAdmin(): boolean {
    return this.me()?.role === 'admin';
  }

  /**
   * What the table lists. Admins get every account, everyone else gets the one row the server would let them act on.
   * The table is therefore the same table with a shorter list, not a second layout.
   */
  readonly rows = computed<UserRow[]>(() => {
    if (this.isAdmin) return this.users();
    const me = this.me();
    return me ? [{ ...me, email: me.email ?? null, isPublic: me.isPublic ?? false }] : [];
  });

  /** Guards the UI against actions the server would refuse anyway. */
  get adminCount(): number {
    return this.users().filter((u) => u.role === 'admin').length;
  }

  async ngOnInit(): Promise<void> {
    try {
      this.me.set(await this._api.me());
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

  // ── Sharing a board ───────────────────────────────────────────────────────
  /**
   * Shares this account's board read-only, or stops sharing it.
   *
   * Whole-board, because the server holds encrypted operations it cannot read and so cannot share only part of one.
   * Readers get a token that the sync server refuses on every route that changes data, so sharing never grants a way to edit.
   */
  async togglePublic(u: UserRow, isPublic: boolean): Promise<void> {
    this.isBusy.set(true);
    try {
      await this._api.setPublic(u.id, isPublic);
      if (this.isAdmin) {
        await this._reloadUsers();
      } else {
        this.me.set({ ...this.me()!, isPublic });
      }
      this._ok(isPublic ? T.GCF.ACCOUNTS.S_SHARED : T.GCF.ACCOUNTS.S_UNSHARED, {
        username: u.username,
      });
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

  /** The one place an account is edited, own or someone else's. See the dialog's own docs for what each rank may change. */
  editUser(user: UserRow): void {
    const isSelf = this.isSelf(user);
    this._matDialog
      .open(DialogEditAccountComponent, {
        data: {
          user,
          isLastAdmin: this.isLastAdmin(user),
          isSelf,
          canEditIdentity: this.isAdmin,
        },
      })
      .afterClosed()
      .subscribe(async (changes?: EditAccountResult) => {
        if (!changes) return;
        try {
          await (isSelf ? this._saveOwn(changes) : this._saveOther(user.id, changes));
          this._ok(T.GCF.ACCOUNTS.USER_UPDATED);
          if (this.isAdmin) await this._reloadUsers();
          this.me.set(await this._api.me());
        } catch (err) {
          this._fail(err);
        }
        this._cd.markForCheck();
      });
  }

  /** Your own account goes through the self routes, never the admin one: only they take the current password. */
  private async _saveOwn(changes: EditAccountResult): Promise<void> {
    if (changes.password) {
      await this._api.changeOwnPassword(changes.currentPassword ?? '', changes.password);
    }
    if (changes.email !== undefined) await this._api.updateOwnEmail(changes.email);
    // Renaming and role stay the admin route's, and the dialog only offers them to an admin.
    const { username, role } = changes;
    if (username !== undefined || role !== undefined) {
      await this._api.updateUser(this.me()!.id, { username, role });
    }
  }

  private async _saveOther(id: number, changes: EditAccountResult): Promise<void> {
    // The admin route has no currentPassword: an admin resets a password by authority, not by proving the target's identity.
    const adminChanges: UserChanges = { ...changes };
    delete (adminChanges as EditAccountResult).currentPassword;
    await this._api.updateUser(id, adminChanges);
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

  /** The last admin cannot be demoted or deleted - the server refuses too. */
  isLastAdmin(user: UserRow): boolean {
    return user.role === 'admin' && this.adminCount <= 1;
  }

  /** By id, never by name: this decides whether an edit takes the self routes, which are the only ones that ask for the current password. */
  isSelf(user: UserRow): boolean {
    return user.id === this.me()?.id;
  }

  trackById(_i: number, user: UserRow): number {
    return user.id;
  }

  // ── API keys ──────────────────────────────────────────────────────────────

  isKeysOpen(userId: number): boolean {
    return this.openKeyUserIds().has(userId);
  }

  keysOf(userId: number): ApiKeyRow[] {
    return this.keysByUser().get(userId) ?? [];
  }

  /** Only live keys are counted: the badge answers "how many work right now". */
  liveKeyCount(userId: number): number {
    return this.keysOf(userId).filter((k) => !k.revokedAt).length;
  }

  /**
   * Opens a user's key list, or closes it if it is already open.
   *
   * Keys are fetched on demand rather than with the user list: most visits never look at them, and the response carries live credentials.
   */
  async toggleKeys(userId: number): Promise<void> {
    const isClosing = this.isKeysOpen(userId);
    this.openKeyUserIds.update((ids) => {
      const next = new Set(ids);
      if (isClosing) next.delete(userId);
      else next.add(userId);
      return next;
    });
    if (isClosing) {
      this._cd.markForCheck();
      return;
    }
    // Revealing is per-visit: reopening a list shows everything masked again.
    this.revealedKeyIds.set(new Set());
    this.newKeyLabels[userId] = '';
    await this._reloadKeys(userId);
  }

  private async _reloadKeys(userId: number): Promise<void> {
    try {
      const { keys } = await this._api.listApiKeys(userId);
      this.keysByUser.update((byUser) => new Map(byUser).set(userId, keys));
    } catch (err) {
      this._fail(err);
    }
    this._cd.markForCheck();
  }

  async createKey(userId: number): Promise<void> {
    this.isBusy.set(true);
    try {
      const label = (this.newKeyLabels[userId] ?? '').trim();
      const created = await this._api.createApiKey(userId, label);
      this.newKeyLabels[userId] = '';
      // Show a key the moment it is made; nothing was learned by hiding it.
      this.revealedKeyIds.update((ids) => new Set(ids).add(created.id));
      await this._reloadKeys(userId);
      this._ok(T.GCF.ACCOUNTS.API_KEY_CREATED);
    } catch (err) {
      this._fail(err);
    }
    this.isBusy.set(false);
    this._cd.markForCheck();
  }

  async revokeKey(userId: number, key: ApiKeyRow): Promise<void> {
    this.isBusy.set(true);
    try {
      await this._api.revokeApiKey(userId, key.id);
      await this._reloadKeys(userId);
      this._ok(T.GCF.ACCOUNTS.API_KEY_REVOKED);
    } catch (err) {
      this._fail(err);
    }
    this.isBusy.set(false);
    this._cd.markForCheck();
  }

  /** Offered only once a key is dead, so this drops a record and nothing live. */
  async deleteKey(userId: number, key: ApiKeyRow): Promise<void> {
    this.isBusy.set(true);
    try {
      await this._api.deleteApiKey(userId, key.id);
      await this._reloadKeys(userId);
      this._ok(T.GCF.ACCOUNTS.API_KEY_DELETED);
    } catch (err) {
      this._fail(err);
    }
    this.isBusy.set(false);
    this._cd.markForCheck();
  }

  /** Masked but not anonymous: the `spk_<id>_` prefix carries no secret and lets someone match a row against a key already pasted into a script. */
  maskedKey(key: ApiKeyRow): string {
    if (!key.key) return '';
    return key.key.slice(0, key.key.indexOf('_', 4) + 1) + '•'.repeat(16);
  }

  lastUsedAt(key: ApiKeyRow): string {
    return key.lastUsedAt ? new Date(key.lastUsedAt).toLocaleString() : '';
  }

  isKeyRevealed(key: ApiKeyRow): boolean {
    return this.revealedKeyIds().has(key.id);
  }

  toggleReveal(key: ApiKeyRow): void {
    this.revealedKeyIds.update((ids) => {
      const next = new Set(ids);
      if (!next.delete(key.id)) next.add(key.id);
      return next;
    });
  }

  /** ShareService, not navigator.clipboard: the Clipboard API is absent on an insecure origin, and this stack is served over plain HTTP. */
  async copyKey(key: ApiKeyRow): Promise<void> {
    if (!key.key) return;
    const result = await this._share.copyToClipboard(key.key, 'Key');
    if (!result.success) this._fail(new Error(result.error ?? 'Copy failed'));
  }

  trackKeyById(_i: number, key: ApiKeyRow): number {
    return key.id;
  }
}
