/**
 * Toolbar account menu (anex/container-parity).
 *
 * Occupies the slot upstream's profile switcher used to hold. That feature is
 * hidden under container authority - it keeps identity in the browser, where
 * this deployment keeps it on the server - so the avatar would otherwise just
 * be missing. Same affordance, backed by the account you actually signed in as.
 */
import {
  ChangeDetectionStrategy,
  Component,
  computed,
  inject,
  OnInit,
  signal,
} from '@angular/core';
import { Router } from '@angular/router';
import { MatIconButton } from '@angular/material/button';
import { MatIcon } from '@angular/material/icon';
import { MatMenu, MatMenuItem, MatMenuTrigger } from '@angular/material/menu';
import { MatTooltip } from '@angular/material/tooltip';
import { MatDivider } from '@angular/material/divider';
import { TranslatePipe } from '@ngx-translate/core';
import { T } from '../../../t.const';
import { Log } from '../../../core/log';
import { UserAccountsService, type CurrentUser } from '../user-accounts.service';
import { OperationLogStoreService } from '../../../op-log/persistence/operation-log-store.service';

@Component({
  selector: 'account-menu',
  templateUrl: './account-menu.component.html',
  styleUrls: ['./account-menu.component.scss'],
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [
    MatIconButton,
    MatIcon,
    MatMenu,
    MatMenuItem,
    MatMenuTrigger,
    MatTooltip,
    MatDivider,
    TranslatePipe,
  ],
})
export class AccountMenuComponent implements OnInit {
  private readonly _api = inject(UserAccountsService);
  private readonly _router = inject(Router);
  private readonly _opLogStore = inject(OperationLogStoreService);

  readonly T = T;
  readonly me = signal<CurrentUser | null>(null);

  /** Boards other people have shared. Empty for most deployments, which is why the whole section is hidden when it is. */
  readonly sharedBoards = signal<{ id: number; username: string }[]>([]);
  /** Whose board is on screen, or null for your own. */
  readonly viewing = signal<number | null>(null);

  readonly viewingName = computed(() => {
    const id = this.viewing();
    return id === null
      ? null
      : (this.sharedBoards().find((b) => b.id === id)?.username ?? null);
  });

  async ngOnInit(): Promise<void> {
    try {
      this.me.set(await this._api.me());
    } catch (err) {
      // No session, or auth disabled. The button still works as a way into
      // settings; only the identity line goes missing.
      Log.err('AccountMenu: could not load current user', err);
      return;
    }
    try {
      const { viewing, boards } = await this._api.publicBoards();
      this.sharedBoards.set(boards);
      this.viewing.set(viewing);
    } catch (err) {
      // Nothing shared, or an older bridge. The menu just omits the section.
      Log.err('AccountMenu: could not load shared boards', err);
    }
  }

  /**
   * Opens somebody else's shared board, or returns to your own.
   *
   * Reloads rather than swapping in place: sync credentials are read once at startup, so the app has to boot against the new board.
   * The replica is stamped with the board it holds, so the mismatch clears the old copy on the way in. That is what stops the two mixing.
   */
  async view(userId: number | null): Promise<void> {
    if (userId === this.viewing()) return;
    try {
      await this._api.setViewing(userId);
    } catch (err) {
      Log.err('AccountMenu: could not switch board', err);
      return;
    }
    window.location.reload();
  }

  openSettings(): void {
    this._router.navigate(['/config']);
  }

  async logout(): Promise<void> {
    try {
      await this._api.logout();
    } catch (err) {
      Log.err('AccountMenu: logout request failed', err);
    }
    // Destroy the local replica on the way out. The reload below only clears
    // the in-memory copy; IndexedDB survives reloads by design, which is what
    // used to leave a signed-out user's whole board on a shared machine.
    //
    // ReplicaIdentityGateService would catch it at the next sign-in anyway, but
    // only once someone signs in - this closes the window in between. The cost
    // is a full re-download when the same user returns, which is the right
    // trade on a machine where "log out" has to mean something.
    try {
      await this._opLogStore.purgeForIdentityMismatch();
    } catch (err) {
      Log.err('AccountMenu: could not purge local replica on logout', err);
    }
    // Full reload rather than a route change: drops the in-memory replica and
    // every service holding a reference to it.
    window.location.href = '/login';
  }
}
