/**
 * Edit for one account: username, email, role and a password change. The only place any account is edited, own or someone else's.
 *
 * Renaming is safe: the board is keyed to the account id, never the name or email (see packages/sp-bridge/src/auth/sync-identity.ts).
 *
 * Editing yourself asks for the current password first. A session proves the browser holds a cookie, not that the owner is at the keyboard.
 * An admin resetting someone else's password is exercising authority rather than proving identity, so it does not apply there.
 */
import { ChangeDetectionStrategy, Component, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import {
  MAT_DIALOG_DATA,
  MatDialogRef,
  MatDialogActions,
  MatDialogContent,
  MatDialogTitle,
} from '@angular/material/dialog';
import { MatButton } from '@angular/material/button';
import { MatFormField, MatHint, MatLabel } from '@angular/material/form-field';
import { MatInput } from '@angular/material/input';
import { MatSelect } from '@angular/material/select';
import { MatOption } from '@angular/material/core';
import { TranslatePipe } from '@ngx-translate/core';
import { T } from '../../../t.const';
import type { Role, UserChanges, UserRow } from '../user-accounts.service';

const MIN_PASSWORD_LENGTH = 8;

export interface EditAccountData {
  user: UserRow;
  /** Blocks demotion when this is the only admin, matching the server's rule. */
  isLastAdmin: boolean;
  /** The caller is editing their own account. */
  isSelf: boolean;
  /** Username and role are the admin's to change; a non-admin edits neither. */
  canEditIdentity: boolean;
}

/** Everything the dialog collected. currentPassword only when editing yourself. */
export interface EditAccountResult extends UserChanges {
  currentPassword?: string;
}

@Component({
  selector: 'dialog-edit-account',
  templateUrl: './dialog-edit-account.component.html',
  styleUrls: ['./dialog-edit-account.component.scss'],
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [
    FormsModule,
    MatDialogTitle,
    MatDialogContent,
    MatDialogActions,
    MatButton,
    MatFormField,
    MatLabel,
    MatHint,
    MatInput,
    MatSelect,
    MatOption,
    TranslatePipe,
  ],
})
export class DialogEditAccountComponent {
  private readonly _dialogRef =
    inject<MatDialogRef<DialogEditAccountComponent>>(MatDialogRef);
  readonly data = inject<EditAccountData>(MAT_DIALOG_DATA);

  readonly T = T;
  readonly ROLES: Role[] = ['admin', 'operator', 'viewer'];
  readonly MIN_PASSWORD_LENGTH = MIN_PASSWORD_LENGTH;

  readonly username = signal(this.data.user.username);
  readonly email = signal(this.data.user.email ?? '');
  readonly role = signal<Role>(this.data.user.role);
  readonly password = signal('');
  readonly currentPassword = signal('');

  get isValid(): boolean {
    const name = this.username().trim();
    const pw = this.password();
    if (name.length < 3) return false;
    if (!pw) return true;
    if (pw.length < MIN_PASSWORD_LENGTH) return false;
    return !this.data.isSelf || !!this.currentPassword();
  }

  close(): void {
    this._dialogRef.close();
  }

  /** Only what actually changed, so an untouched field is never sent. */
  save(): void {
    if (!this.isValid) return;
    const user = this.data.user;
    const changes: EditAccountResult = {};

    if (this.data.canEditIdentity) {
      const name = this.username().trim();
      if (name !== user.username) changes.username = name;
      if (!this.data.isLastAdmin && this.role() !== user.role) {
        changes.role = this.role();
      }
    }

    const mail = this.email().trim() || null;
    if (mail !== (user.email ?? null)) changes.email = mail;

    if (this.password()) {
      changes.password = this.password();
      if (this.data.isSelf) changes.currentPassword = this.currentPassword();
    }

    this._dialogRef.close(Object.keys(changes).length ? changes : undefined);
  }
}
