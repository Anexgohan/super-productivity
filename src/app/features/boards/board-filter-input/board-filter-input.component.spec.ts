import { ComponentFixture, TestBed } from '@angular/core/testing';
import { signal } from '@angular/core';
import { Subject } from 'rxjs';
import { TranslateModule } from '@ngx-translate/core';
import { BoardFilterInputComponent } from './board-filter-input.component';
import { BoardSearchService } from '../board-search.service';

describe('BoardFilterInputComponent', () => {
  let fixture: ComponentFixture<BoardFilterInputComponent>;
  let query: ReturnType<typeof signal<string>>;
  let focusRequests$: Subject<void>;
  let setQuery: jasmine.Spy;

  beforeEach(() => {
    query = signal('');
    focusRequests$ = new Subject<void>();
    setQuery = jasmine.createSpy('setQuery').and.callFake((q: string) => {
      query.set(q);
      return Promise.resolve();
    });
    TestBed.configureTestingModule({
      imports: [BoardFilterInputComponent, TranslateModule.forRoot()],
      providers: [
        { provide: BoardSearchService, useValue: { query, focusRequests$, setQuery } },
      ],
    });
    fixture = TestBed.createComponent(BoardFilterInputComponent);
    document.body.appendChild(fixture.nativeElement);
    fixture.detectChanges();
  });

  afterEach(() => (fixture.nativeElement as HTMLElement).remove());

  const input = (): HTMLInputElement =>
    (fixture.nativeElement as HTMLElement).querySelector('input') as HTMLInputElement;

  it('focuses the box when the search shortcut asks for it', () => {
    focusRequests$.next();

    expect(document.activeElement).toBe(input());
  });

  it('passes typing on as the query', () => {
    input().value = 'plumber';
    input().dispatchEvent(new Event('input'));

    expect(setQuery).toHaveBeenCalledWith('plumber');
  });

  it('shows the clear button only with a query, and clearing empties it', () => {
    const clearBtn = (): HTMLButtonElement | null =>
      (fixture.nativeElement as HTMLElement).querySelector('.clear-btn');
    expect(clearBtn()).toBeNull();

    query.set('plumber');
    fixture.detectChanges();
    clearBtn()?.click();

    expect(setQuery).toHaveBeenCalledWith('');
  });
});
