import { TestBed } from '@angular/core/testing';
import { provideMockStore } from '@ngrx/store/testing';
import { BoardSearchService } from './board-search.service';
import { selectAllTasksInActiveProjects } from '../tasks/store/task.selectors';
import { TaskCopy } from '../tasks/task.model';

describe('BoardSearchService', () => {
  const tasks = [
    { id: 'a', title: 'Buy groceries' },
    { id: 'b', title: 'Write the quarterly report' },
    { id: 'c', title: 'Call the plumber' },
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

  it('treats a query of spaces as no filter', async () => {
    await service.setQuery('   ');

    expect(service.isFiltering()).toBeFalse();
    expect(service.matchingIds()).toBeNull();
  });
});
