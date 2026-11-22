import {
  ChangeDetectionStrategy,
  Component,
  ElementRef,
  inject,
  viewChild,
} from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { MatIcon } from '@angular/material/icon';
import { MatIconButton } from '@angular/material/button';
import { TranslatePipe } from '@ngx-translate/core';
import { T } from '../../../t.const';
import { BoardSearchService } from '../board-search.service';

/** The Boards title filter as a compact box for the main header. */
@Component({
  selector: 'board-filter-input',
  standalone: true,
  imports: [MatIcon, MatIconButton, TranslatePipe],
  templateUrl: './board-filter-input.component.html',
  styleUrl: './board-filter-input.component.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class BoardFilterInputComponent {
  readonly boardSearch = inject(BoardSearchService);
  readonly T = T;
  private _input = viewChild.required<ElementRef<HTMLInputElement>>('filterInput');

  constructor() {
    this.boardSearch.focusRequests$
      .pipe(takeUntilDestroyed())
      .subscribe(() => this._input().nativeElement.focus());
  }

  clear(): void {
    this.boardSearch.setQuery('');
    this._input().nativeElement.focus();
  }
}
