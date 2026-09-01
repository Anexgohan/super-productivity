import {
  ChangeDetectionStrategy,
  Component,
  computed,
  effect,
  ElementRef,
  inject,
  signal,
} from '@angular/core';
import { MatTab, MatTabContent, MatTabGroup, MatTabLabel } from '@angular/material/tabs';
import { Store } from '@ngrx/store';
import { T } from '../../t.const';
import { MatIcon } from '@angular/material/icon';
import { MatMenuModule } from '@angular/material/menu';
import { nanoid } from 'nanoid';
import { BoardComponent } from './board/board.component';
import { CdkScrollable } from '@angular/cdk/overlay';
import {
  CdkDrag,
  CdkDragDrop,
  CdkDropList,
  CdkDropListGroup,
} from '@angular/cdk/drag-drop';
import { toSignal } from '@angular/core/rxjs-interop';
import { selectAllBoards } from './store/boards.selectors';
import { selectUnarchivedVisibleProjects } from '../project/store/project.selectors';
import { GlobalProjectScopeService } from '../project/global-project-scope.service';
import {
  buildBoardProjectAssignment,
  buildDuplicatedBoard,
  filterBoardsByProjectScope,
  remapVisibleOrderToFullOrder,
} from './boards.util';
import { LS } from '../../core/persistence/storage-keys.const';
import { setSelectedTask } from '../tasks/store/task.actions';
import { TranslatePipe, TranslateService } from '@ngx-translate/core';
import { BoardEditComponent } from './board-edit/board-edit.component';
import { DEFAULT_BOARD_CFG } from './boards.const';
import { BoardsActions } from './store/boards.actions';
import { BoardCfg } from './boards.model';
import { MatDialog } from '@angular/material/dialog';
import { DialogBoardEditComponent } from './dialog-board-edit/dialog-board-edit.component';
import { DialogConfirmComponent } from '../../ui/dialog-confirm/dialog-confirm.component';
import { Log } from 'src/app/core/log';
import { SnackService } from '../../core/snack/snack.service';

@Component({
  selector: 'boards',
  standalone: true,
  imports: [
    MatMenuModule,
    MatTabGroup,
    MatTab,
    MatIcon,
    MatTabContent,
    MatTabLabel,
    BoardComponent,
    CdkScrollable,
    CdkDropListGroup,
    CdkDropList,
    CdkDrag,
    TranslatePipe,
    BoardEditComponent,
  ],
  templateUrl: './boards.component.html',
  styleUrl: './boards.component.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class BoardsComponent {
  private _matDialog = inject(MatDialog);
  store = inject(Store);
  elementRef = inject(ElementRef);
  selectedTabIndex = signal(localStorage.getItem(LS.SELECTED_BOARD) || 0);
  readonly dragStartDelay = { touch: 300, mouse: 0 };

  private _globalProjectScope = inject(GlobalProjectScopeService);
  private _translateService = inject(TranslateService);
  private _snackService = inject(SnackService);

  /** Every board, in stored order — the order `sortBoards` operates on. */
  private _allBoards = toSignal(this.store.select(selectAllBoards));
  /** Also the target list for "Duplicate to". */
  projects = toSignal(this.store.select(selectUnarchivedVisibleProjects), {
    initialValue: [],
  });

  /** Boards shown as tabs for the active project scope. */
  boards = computed(() => {
    const allBoards = this._allBoards() ?? [];
    const liveProjectIds = new Set(this.projects().map((p) => p.id));
    return filterBoardsByProjectScope(
      allBoards,
      this._globalProjectScope.scope(),
      liveProjectIds,
    );
  });

  protected readonly T = T;

  /**
   * Template for the "add board" tab. A board created while the app is scoped
   * to a project is born assigned to it — otherwise it would default to
   * unassigned and disappear from the strip the moment it was created.
   */
  newBoardCfg = computed(() => {
    const scope = this._globalProjectScope.scope();
    return scope ? { ...DEFAULT_BOARD_CFG, projectIds: [scope] } : DEFAULT_BOARD_CFG;
  });

  constructor() {
    effect(() => {
      localStorage.setItem(LS.SELECTED_BOARD, this.selectedTabIndex().toString());
    });

    // The remembered tab index was stored against the unfiltered strip, so
    // narrowing the project scope can leave it pointing past the last board —
    // which selects nothing and looks like the page failed to load. Clamp onto
    // the last real board; the trailing "+" tab is not a board, so it is not a
    // valid resting place.
    effect(() => {
      const lastIndex = this.boards().length - 1;
      if (lastIndex < 0) {
        return;
      }
      if (Number(this.selectedTabIndex()) > lastIndex) {
        this.selectedTabIndex.set(lastIndex);
      }
    });
  }

  goToLastIndex(): void {
    // NOTE: since the index number does not change (the add tab index is at the same index as the newly added tab) we need to do this in two steps
    const newIndex = (this.boards()?.length || 1) - 1;
    setTimeout(() => {
      this.selectedTabIndex.set(newIndex + 1);
      setTimeout(() => {
        this.selectedTabIndex.set(newIndex);
      }, 10);
    });
  }

  // Tab change happens before the click event gets to the callback.
  // We need to delay updating the selected tab index until the click event has completed
  // propagation.
  onTabChange(index: number): void {
    setTimeout(() => this.selectedTabIndex.set(index));
    this.store.dispatch(setSelectedTask({ id: null }));
  }

  drop(ev: CdkDragDrop<string[]>): void {
    const visible = this.boards();
    const allBoards = this._allBoards();
    if (!visible || !allBoards || ev.previousIndex === ev.currentIndex) {
      return;
    }
    const ids = remapVisibleOrderToFullOrder(
      allBoards,
      visible,
      ev.previousIndex,
      ev.currentIndex,
    );
    this.store.dispatch(BoardsActions.sortBoards({ ids }));
  }

  get componentElement(): HTMLElement {
    return this.elementRef.nativeElement;
  }

  /**
   * Copy a board, optionally into another project. `targetProjectId` of '' is
   * the unassigned sentinel ("All Projects"); omitting it keeps the source's
   * own scope. See `buildDuplicatedBoard` for what is and is not carried over.
   *
   * `instant()` is correct here, unlike for a rendered label: it runs on a
   * click, long after the language file has loaded, and its result is written
   * to data rather than displayed.
   */
  /**
   * Reassign a board to a project. A MOVE: same board, same id, same columns —
   * it just lives under a different project now. `projectId` of '' unassigns.
   *
   * This is the one people want most of the time, and it is deliberately
   * separate from the two copy actions so "put this board in Work" never
   * silently leaves a second board behind.
   */
  moveBoardToProject(board: BoardCfg, projectId: string): void {
    if (!board) {
      Log.warn('No board selected to move');
      return;
    }
    this.store.dispatch(
      BoardsActions.updateBoard({
        id: board.id,
        updates: buildBoardProjectAssignment(projectId),
      }),
    );

    const project = this.projects().find((p) => p.id === projectId);
    this._snackService.open({
      type: 'SUCCESS',
      msg: project
        ? this._translateService.instant(T.F.BOARDS.V.MOVED_TO_PROJECT, {
            project: project.title,
          })
        : this._translateService.instant(T.F.BOARDS.V.MOVED_UNASSIGNED),
    });
  }

  /**
   * Copy a board into a project. `isTemplate` additionally clears each column's
   * tag filters, so the structure carries over but the columns start empty.
   *
   * `instant()` is correct here, unlike for a rendered label: it runs on a
   * click, long after the language file has loaded, and its result is written
   * to data rather than displayed.
   */
  duplicateBoard(
    boardToDuplicate: BoardCfg,
    targetProjectId?: string,
    isTemplate = false,
  ): void {
    if (!boardToDuplicate) {
      Log.warn('No board selected to duplicate');
      return;
    }
    const copy = buildDuplicatedBoard(
      boardToDuplicate,
      targetProjectId === undefined ? undefined : [targetProjectId],
      (title) => this._translateService.instant(title),
      this._translateService.instant(T.GLOBAL.COPY_SUFFIX),
      nanoid,
      isTemplate,
    );
    this.store.dispatch(BoardsActions.addBoard({ board: copy }));

    // A copy made into a project other than the one currently in scope is
    // filtered straight back out of the tab strip, so without this the click
    // looks like it did nothing at all. Focus the copy when it is visible;
    // say where it went when it is not.
    setTimeout(() => {
      const index = this.boards().findIndex((b) => b.id === copy.id);
      if (index > -1) {
        this.selectedTabIndex.set(index);
        return;
      }
      const project = this.projects().find((p) => p.id === targetProjectId);
      this._snackService.open(
        project
          ? this._translateService.instant(T.F.BOARDS.V.COPIED_TO_PROJECT, {
              project: project.title,
            })
          : this._translateService.instant(T.F.BOARDS.V.COPIED_UNASSIGNED),
      );
    });
  }

  editBoard(board: BoardCfg): void {
    if (!board) {
      Log.warn('No board selected to edit');
      return;
    }
    this._matDialog.open(DialogBoardEditComponent, {
      data: {
        board: board,
      },
    });
  }

  removeBoard(board: BoardCfg): void {
    if (!board) {
      Log.warn('No board selected to remove');
      return;
    }
    this._matDialog
      .open(DialogConfirmComponent, {
        restoreFocus: true,
        data: {
          cancelTxt: T.G.CANCEL,
          okTxt: T.G.DELETE,
          message: T.F.BOARDS.V.CONFIRM_DELETE,
        },
      })
      .afterClosed()
      .subscribe((isConfirm: boolean) => {
        if (isConfirm) {
          this.store.dispatch(BoardsActions.removeBoard({ id: board.id }));
        }
      });
  }
}
