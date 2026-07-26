/**
 * Deleting an account purges its board too - every task, project and op it ever
 * synced, with no undo. So this asks for the username to be typed rather than
 * offering a button that a mis-click can reach.
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
import { MatFormField, MatLabel } from '@angular/material/form-field';
import { MatInput } from '@angular/material/input';
import { MatIcon } from '@angular/material/icon';
import { TranslatePipe } from '@ngx-translate/core';
import { T } from '../../../t.const';

@Component({
  selector: 'dialog-confirm-delete-account',
  templateUrl: './dialog-confirm-delete-account.component.html',
  styleUrls: ['./dialog-confirm-delete-account.component.scss'],
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [
    FormsModule,
    MatDialogTitle,
    MatDialogContent,
    MatDialogActions,
    MatButton,
    MatFormField,
    MatLabel,
    MatInput,
    MatIcon,
    TranslatePipe,
  ],
})
export class DialogConfirmDeleteAccountComponent {
  private readonly _dialogRef =
    inject<MatDialogRef<DialogConfirmDeleteAccountComponent>>(MatDialogRef);
  readonly data = inject<{ username: string }>(MAT_DIALOG_DATA);

  readonly T = T;
  readonly typed = signal('');

  get isConfirmed(): boolean {
    return this.typed().trim() === this.data.username;
  }

  close(): void {
    this._dialogRef.close(false);
  }

  confirm(): void {
    if (this.isConfirmed) {
      this._dialogRef.close(true);
    }
  }
}
