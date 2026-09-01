import { ChangeDetectionStrategy, Component, computed, inject } from '@angular/core';
import { Store } from '@ngrx/store';
import { toSignal } from '@angular/core/rxjs-interop';
import { MatButton } from '@angular/material/button';
import { MatIcon } from '@angular/material/icon';
import { MatMenu, MatMenuItem, MatMenuTrigger } from '@angular/material/menu';
import { MatTooltip } from '@angular/material/tooltip';
import { TranslatePipe } from '@ngx-translate/core';
import { T } from '../../../t.const';
import { selectUnarchivedVisibleProjects } from '../../../features/project/store/project.selectors';
import { GlobalProjectScopeService } from '../../../features/project/global-project-scope.service';

/**
 * Global project scope: which project the app is limited to, or All Projects.
 *
 * It lives in the header rather than on the page it currently affects because a
 * filter that hides things has to stay visible while it is on — a scoped view
 * with the control off screen is indistinguishable from missing data.
 */
@Component({
  selector: 'project-scope-select',
  standalone: true,
  imports: [
    MatButton,
    MatIcon,
    MatMenu,
    MatMenuItem,
    MatMenuTrigger,
    MatTooltip,
    TranslatePipe,
  ],
  templateUrl: './project-scope-select.component.html',
  styleUrl: './project-scope-select.component.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class ProjectScopeSelectComponent {
  private _store = inject(Store);
  protected readonly scopeService = inject(GlobalProjectScopeService);
  protected readonly T = T;

  projects = toSignal(this._store.select(selectUnarchivedVisibleProjects), {
    initialValue: [],
  });

  /**
   * The scoped project, or undefined for All Projects. Also undefined when the
   * stored id names a project that no longer exists, which reads as All rather
   * than as a broken label.
   */
  activeProject = computed(() => {
    const scope = this.scopeService.scope();
    return scope ? this.projects().find((p) => p.id === scope) : undefined;
  });

  /**
   * The scoped project's title, or null for All Projects — the template then
   * renders the translated fallback.
   *
   * NOT `TranslateService.instant()`: the header is built during startup, and
   * `instant` returns the raw key when the language file has not landed yet.
   * A computed has no dependency on that load, so the key would stick forever.
   * The `| translate` pipe in the template is reactive and cannot go stale.
   */
  label = computed(() => this.activeProject()?.title ?? null);

  isScoped = computed(() => !!this.activeProject());

  setScope(projectId: string): void {
    this.scopeService.setScope(projectId);
  }
}
