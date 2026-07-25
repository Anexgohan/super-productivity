/**
 * Toolbar account menu (anex/container-parity).
 *
 * Occupies the slot upstream's profile switcher used to hold. That feature is
 * hidden under container authority — it keeps identity in the browser, where
 * this deployment keeps it on the server — so the avatar would otherwise just
 * be missing. Same affordance, backed by the account you actually signed in as.
 */
import {
  ChangeDetectionStrategy,
  Component,
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

  async ngOnInit(): Promise<void> {
    try {
      this.me.set(await this._api.me());
    } catch (err) {
      // No session, or auth disabled. The button still works as a way into
      // settings; only the identity line goes missing.
      Log.err('AccountMenu: could not load current user', err);
    }
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
    // only once someone signs in — this closes the window in between. The cost
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
