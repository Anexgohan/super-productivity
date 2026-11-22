import { TestBed } from '@angular/core/testing';
import { provideMockStore } from '@ngrx/store/testing';
import { BoardSearchService, isBoardsUrl } from './board-search.service';
import { selectAllTasksInActiveProjects } from '../tasks/store/task.selectors';
import { TaskCopy } from '../tasks/task.model';

describe('BoardSearchService', () => {
  const tasks = [
    { id: 'a', title: 'Buy groceries' },
    { id: 'b', title: 'Write the quarterly report' },
    { id: 'c', title: 'Call the plumber' },
    { id: 'd', title: 'Plumbr invoice' },
  ] as TaskCopy[];

  let service: BoardSearchService;

  beforeEach(() => {
    TestBed.configureTestingModule({
      providers: [
        provideMockStore({
          selectors: [{ selector: selectAllTasksInActiveProjects, value: tasks }],
        }),
      ],
    });
    service = TestBed.inject(BoardSearchService);
  });

  it('shows every card while the box is empty', () => {
    expect(service.isFiltering()).toBeFalse();
    expect(service.matchingIds()).toBeNull();
  });

  it('keeps only the cards whose title matches, even with a typo', async () => {
    await service.setQuery('grocries');

    expect(service.isFiltering()).toBeTrue();
    expect([...(service.matchingIds() ?? [])]).toEqual(['a']);
  });

  it('shows every card again once the box is cleared', async () => {
    await service.setQuery('plumber');
    await service.setQuery('');

    expect(service.isFiltering()).toBeFalse();
    expect(service.matchingIds()).toBeNull();
  });

  it('splits each matching title into plain and matched runs', async () => {
    await service.setQuery('plumber');

    expect(service.titleSegments()['c']).toEqual([
      { text: 'Call the ', isMatch: false },
      { text: 'plumber', isMatch: true },
    ]);
    expect(service.titleSegments()['a']).toBeUndefined();
  });

  it('scores an exact match better than a typo', async () => {
    await service.setQuery('plumber');
    const scores = service.matchScores();

    expect(scores?.get('c') ?? 1).toBeLessThan(scores?.get('d') ?? 0);
    expect(scores?.has('a')).toBeFalse();
  });

  it('has no runs or scores while the box is empty', () => {
    expect(service.titleSegments()).toEqual({});
    expect(service.matchScores()).toBeNull();
  });

  it('treats a query of spaces as no filter', async () => {
    await service.setQuery('   ');

    expect(service.isFiltering()).toBeFalse();
    expect(service.matchingIds()).toBeNull();
  });
});

describe('isBoardsUrl', () => {
  it('is true for the Boards page with or without a query or hash', () => {
    expect(isBoardsUrl('/boards')).toBeTrue();
    expect(isBoardsUrl('/boards?x=1')).toBeTrue();
    expect(isBoardsUrl('/boards#top')).toBeTrue();
  });

  it('is false for other pages and for no url', () => {
    expect(isBoardsUrl('/boards-archive')).toBeFalse();
    expect(isBoardsUrl('/search')).toBeFalse();
    expect(isBoardsUrl(undefined)).toBeFalse();
  });
});
