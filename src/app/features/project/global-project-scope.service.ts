import { Injectable, computed, signal } from '@angular/core';
import { LS } from '../../core/persistence/storage-keys.const';

/**
 * The project the app is currently scoped to, or '' for "All Projects"
 * (unassigned), the same sentinel the boards use.
 *
 * Deliberately NOT NgRx: nothing here belongs in synced *state*. The value is a
 * UI preference, so it rides the `SyncedUiPrefsService` interception instead —
 * `LS.GLOBAL_PROJECT_SCOPE` is listed in `SYNCED_KEYS`, and that service wraps
 * localStorage's mutators, so a plain `setItem` here persists to the account's
 * config without this service knowing anything about sync.
 *
 * Like most preferences in this app the value is read once at construction, so
 * a change made on another device applies on the next reload rather than
 * instantly. See the KNOWN LIMITATION note in `synced-ui-prefs.service.ts`.
 */
@Injectable({ providedIn: 'root' })
export class GlobalProjectScopeService {
  private readonly _scope = signal<string>(readPersistedScope());

  /** Project id, or '' for All Projects. */
  readonly scope = this._scope.asReadonly();
  readonly isAll = computed(() => this._scope() === '');

  setScope(projectId: string): void {
    const next = projectId || '';
    this._scope.set(next);
    try {
      localStorage.setItem(LS.GLOBAL_PROJECT_SCOPE, next);
    } catch {
      // Private mode or a storage quota error: the in-memory signal still holds
      // for this session, which beats failing the click.
    }
  }
}

const readPersistedScope = (): string => {
  try {
    return localStorage.getItem(LS.GLOBAL_PROJECT_SCOPE) || '';
  } catch {
    return '';
  }
};
