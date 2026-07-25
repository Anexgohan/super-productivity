/**
 * Admin edit for one account: username, email, role and a password reset in a
 * single dialog.
 *
 * One dialog rather than an icon per action, because the row would otherwise
 * need four controls beside the reorder arrows. Renaming is safe here — the
 * user's board is keyed to their account id, never their name or email (see
 * packages/sp-bridge/src/auth/sync-identity.ts), so nothing they own moves.
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

  get isValid(): boolean {
    const name = this.username().trim();
    const pw = this.password();
    return name.length >= 3 && (!pw || pw.length >= MIN_PASSWORD_LENGTH);
  }

  close(): void {
    this._dialogRef.close();
  }

  /** Only what actually changed, so an untouched field is never sent. */
  save(): void {
    if (!this.isValid) return;
    const user = this.data.user;
    const changes: UserChanges = {};

    const name = this.username().trim();
    if (name !== user.username) changes.username = name;

    const mail = this.email().trim() || null;
    if (mail !== (user.email ?? null)) changes.email = mail;

    if (!this.data.isLastAdmin && this.role() !== user.role) changes.role = this.role();
    if (this.password()) changes.password = this.password();

    this._dialogRef.close(Object.keys(changes).length ? changes : undefined);
  }
}
