import { TestBed } from '@angular/core/testing';
import { ShortcutService } from './shortcut.service';
import { GlobalConfigService } from '../../features/config/global-config.service';
import { Router } from '@angular/router';
import { LayoutService } from '../layout/layout.service';
import { MatDialog } from '@angular/material/dialog';
import { TaskService } from '../../features/tasks/task.service';
import { WorkContextService } from '../../features/work-context/work-context.service';
import { ActivatedRoute } from '@angular/router';
import { UiHelperService } from '../../features/ui-helper/ui-helper.service';
import { SyncWrapperService } from '../../imex/sync/sync-wrapper.service';
import { Store } from '@ngrx/store';
import { PluginBridgeService } from '../../plugins/plugin-bridge.service';
import { TaskShortcutService } from '../../features/tasks/task-shortcut.service';
import { OverlayContainer } from '@angular/cdk/overlay';
import { signal } from '@angular/core';
import { of, Subject } from 'rxjs';
import { BoardSearchService } from '../../features/boards/board-search.service';

describe('ShortcutService', () => {
  let service: ShortcutService;
  let mockTaskShortcutService: any;
  let mockRouter: any;
  let mockConfigService: any;
  let focusRequests$: Subject<void>;

  beforeEach(() => {
    mockTaskShortcutService = {
      handleTaskShortcuts: jasmine
        .createSpy('handleTaskShortcuts')
        .and.returnValue(false),
      handleTogglePlayFallback: jasmine
        .createSpy('handleTogglePlayFallback')
        .and.returnValue(false),
    };
    mockRouter = {
      navigate: jasmine.createSpy('navigate'),
      url: '/',
    };
    mockConfigService = {
      cfg: signal({
        keyboard: {
          goToScheduledView: 'Shift+S',
          showSearchBar: 'Shift+F',
        },
      }),
      appFeatures: signal({
        isFocusModeEnabled: true,
      }),
    };

    focusRequests$ = new Subject<void>();

    TestBed.configureTestingModule({
      providers: [
        ShortcutService,
        { provide: BoardSearchService, useValue: { focusRequests$ } },
        { provide: TaskShortcutService, useValue: mockTaskShortcutService },
        { provide: Router, useValue: mockRouter },
        { provide: GlobalConfigService, useValue: mockConfigService },
        { provide: LayoutService, useValue: { isNavOpen: signal(false) } },
        { provide: MatDialog, useValue: { openDialogs: [] } },
        { provide: TaskService, useValue: { currentTaskId: signal(null) } },
        { provide: WorkContextService, useValue: { activeWorkContext$: signal({}) } },
        { provide: ActivatedRoute, useValue: { queryParams: of({}) } },
        { provide: UiHelperService, useValue: {} },
        { provide: SyncWrapperService, useValue: {} },
        { provide: Store, useValue: { dispatch: jasmine.createSpy('dispatch') } },
        { provide: PluginBridgeService, useValue: { shortcuts: signal([]) } },
        {
          provide: OverlayContainer,
          useValue: {
            getContainerElement: () => ({
              querySelector: () => null,
              children: [],
            }),
          },
        },
      ],
    });

    service = TestBed.inject(ShortcutService);
  });

  describe('handleKeyDown', () => {
    it('should NOT navigate to schedule if TaskShortcutService handled Shift+S', () => {
      mockTaskShortcutService.handleTaskShortcuts.and.returnValue(true);
      const ev = new KeyboardEvent('keydown', {
        code: 'KeyS',
        shiftKey: true,
      });
      Object.defineProperty(ev, 'target', { value: document.body });

      service.handleKeyDown(ev);

      expect(mockTaskShortcutService.handleTaskShortcuts).toHaveBeenCalledWith(ev);
      expect(mockRouter.navigate).not.toHaveBeenCalled();
    });

    it('should navigate to schedule if TaskShortcutService did NOT handle Shift+S', () => {
      mockTaskShortcutService.handleTaskShortcuts.and.returnValue(false);
      const ev = new KeyboardEvent('keydown', {
        code: 'KeyS',
        shiftKey: true,
      });
      Object.defineProperty(ev, 'target', { value: document.body });

      service.handleKeyDown(ev);

      expect(mockTaskShortcutService.handleTaskShortcuts).toHaveBeenCalledWith(ev);
      expect(mockRouter.navigate).toHaveBeenCalledWith(['/schedule']);
    });

    const pressSearch = (): void => {
      const ev = new KeyboardEvent('keydown', { code: 'KeyF', shiftKey: true });
      Object.defineProperty(ev, 'target', { value: document.body });
      service.handleKeyDown(ev);
    };

    it('focuses the board filter instead of opening search on the Boards page', () => {
      mockRouter.url = '/boards';
      const focusSpy = jasmine.createSpy('focus');
      focusRequests$.subscribe(focusSpy);

      pressSearch();

      expect(focusSpy).toHaveBeenCalledTimes(1);
      expect(mockRouter.navigate).not.toHaveBeenCalled();
    });

    it('opens the search page from any other page', () => {
      mockRouter.url = '/tag/TODAY/tasks';

      pressSearch();

      expect(mockRouter.navigate).toHaveBeenCalledWith(['/search']);
    });
  });
});
