import { ComponentFixture, TestBed } from '@angular/core/testing';
import { MAT_DIALOG_DATA, MatDialogRef } from '@angular/material/dialog';
import { TranslateModule, TranslateService } from '@ngx-translate/core';
import { provideNoopAnimations } from '@angular/platform-browser/animations';
import { DateTimeFormatService } from '../../../core/date-time-format/date-time-format.service';
import {
  DialogSyncImportConflictComponent,
  SyncImportConflictData,
} from './dialog-sync-import-conflict.component';

describe('DialogSyncImportConflictComponent', () => {
  let closeSpy: jasmine.Spy;
  // window.confirm is installed as a global spy in src/test.ts — reuse it.
  let confirmSpy: jasmine.Spy;

  const setup = (
    data: Partial<SyncImportConflictData>,
  ): ComponentFixture<DialogSyncImportConflictComponent> => {
    closeSpy = jasmine.createSpy('close');
    const dialogRefMock = {
      close: closeSpy,
      disableClose: false,
    } as unknown as MatDialogRef<DialogSyncImportConflictComponent>;

    TestBed.configureTestingModule({
      imports: [DialogSyncImportConflictComponent],
      providers: [
        { provide: MatDialogRef, useValue: dialogRefMock },
        {
          provide: MAT_DIALOG_DATA,
          useValue: {
            filteredOpCount: 4,
            localImportTimestamp: 0,
            scenario: 'INCOMING_IMPORT',
            ...data,
          } as SyncImportConflictData,
        },
        {
          provide: TranslateService,
          useValue: { instant: (key: string) => key },
        },
        {
          provide: DateTimeFormatService,
          useValue: { currentLocale: () => 'en-US', formatTime: () => '00:00' },
        },
      ],
    });
    // Avoid rendering the template (translate pipes etc.) — we only test close() logic.
    TestBed.overrideComponent(DialogSyncImportConflictComponent, {
      set: { template: '' },
    });
    return TestBed.createComponent(DialogSyncImportConflictComponent);
  };

  beforeEach(() => {
    confirmSpy = window.confirm as jasmine.Spy;
    confirmSpy.calls.reset();
    confirmSpy.and.returnValue(true);
  });

  describe('first-sync USE_LOCAL guard', () => {
    it('requires confirmation before USE_LOCAL when isNeverSynced is true', () => {
      confirmSpy.and.returnValue(true);
      const cmp = setup({ isNeverSynced: true }).componentInstance;

      cmp.close('USE_LOCAL');

      expect(confirmSpy).toHaveBeenCalledTimes(1);
      expect(closeSpy).toHaveBeenCalledOnceWith('USE_LOCAL');
    });

    it('does NOT close when the user cancels the confirmation', () => {
      confirmSpy.and.returnValue(false);
      const cmp = setup({ isNeverSynced: true }).componentInstance;

      cmp.close('USE_LOCAL');

      expect(closeSpy).not.toHaveBeenCalled();
    });

    it('does NOT confirm USE_LOCAL for an established (already-synced) client', () => {
      const cmp = setup({ isNeverSynced: false }).componentInstance;

      cmp.close('USE_LOCAL');

      expect(confirmSpy).not.toHaveBeenCalled();
      expect(closeSpy).toHaveBeenCalledOnceWith('USE_LOCAL');
    });
  });

  describe('USE_REMOTE guard (#8107)', () => {
    it('requires confirmation before USE_REMOTE discards local changes', () => {
      confirmSpy.and.returnValue(true);
      const cmp = setup({
        scenario: 'INCOMING_IMPORT',
        filteredOpCount: 4,
      }).componentInstance;

      cmp.close('USE_REMOTE');

      expect(confirmSpy).toHaveBeenCalledTimes(1);
      expect(closeSpy).toHaveBeenCalledOnceWith('USE_REMOTE');
    });

    it('does NOT close when the user cancels the USE_REMOTE confirmation', () => {
      confirmSpy.and.returnValue(false);
      const cmp = setup({
        scenario: 'INCOMING_IMPORT',
        filteredOpCount: 4,
      }).componentInstance;

      cmp.close('USE_REMOTE');

      expect(closeSpy).not.toHaveBeenCalled();
    });

    it('does NOT confirm USE_REMOTE when there are no local changes to lose', () => {
      const cmp = setup({
        scenario: 'INCOMING_IMPORT',
        filteredOpCount: 0,
      }).componentInstance;

      cmp.close('USE_REMOTE');

      expect(confirmSpy).not.toHaveBeenCalled();
      expect(closeSpy).toHaveBeenCalledOnceWith('USE_REMOTE');
    });

    it('does NOT confirm USE_REMOTE outside the incoming-import scenario', () => {
      const cmp = setup({
        scenario: 'LOCAL_IMPORT_FILTERS_REMOTE',
        filteredOpCount: 4,
      }).componentInstance;

      cmp.close('USE_REMOTE');

      expect(confirmSpy).not.toHaveBeenCalled();
      expect(closeSpy).toHaveBeenCalledOnceWith('USE_REMOTE');
    });
  });

  describe("this browser's own import against the server", () => {
    const ownImport: Partial<SyncImportConflictData> = {
      scenario: 'INCOMING_IMPORT',
      filteredOpCount: 1,
      isNeverSynced: true,
      localImport: { timestamp: 5000, summary: [{ label: 'tasks', count: 3 }] },
    };

    it('recommends no side and does not call the browser never-synced', () => {
      const cmp = setup(ownImport).componentInstance;

      expect(cmp.isOwnImport).toBeTrue();
      expect(cmp.isServerRecommended).toBeFalse();
      expect(cmp.isNeverSynced).toBeFalse();
      expect(cmp.messageKey).toBe('F.SYNC.D_SYNC_IMPORT_CONFLICT.MSG_OWN_IMPORT');
    });

    it('confirms USE_LOCAL in words about the import', () => {
      const cmp = setup(ownImport).componentInstance;

      cmp.close('USE_LOCAL');

      expect(confirmSpy).toHaveBeenCalledOnceWith(
        'F.SYNC.D_SYNC_IMPORT_CONFLICT.OWN_IMPORT_USE_LOCAL_CONFIRM',
      );
      expect(closeSpy).toHaveBeenCalledOnceWith('USE_LOCAL');
    });

    it('confirms USE_REMOTE as discarding the import, and stays open on cancel', () => {
      confirmSpy.and.returnValue(false);
      const cmp = setup(ownImport).componentInstance;

      cmp.close('USE_REMOTE');

      expect(confirmSpy).toHaveBeenCalledOnceWith(
        'F.SYNC.D_SYNC_IMPORT_CONFLICT.OWN_IMPORT_USE_REMOTE_CONFIRM',
      );
      expect(closeSpy).not.toHaveBeenCalled();
    });

    it('renders both sides with their times, and no recommendation or initial focus', () => {
      TestBed.configureTestingModule({
        imports: [DialogSyncImportConflictComponent, TranslateModule.forRoot()],
        providers: [
          provideNoopAnimations(),
          { provide: MatDialogRef, useValue: { close: () => {}, disableClose: false } },
          {
            provide: MAT_DIALOG_DATA,
            useValue: {
              ...ownImport,
              localImportTimestamp: 1000,
              remoteSummary: [{ label: 'tasks', count: 2 }],
              localSummary: [{ label: 'all', count: 1 }],
              remoteLaterChanges: { count: 170, latestTimestamp: 3000 },
            } as SyncImportConflictData,
          },
          {
            provide: DateTimeFormatService,
            useValue: { currentLocale: () => 'en-US', formatTime: () => '00:00' },
          },
        ],
      });
      const fixture = TestBed.createComponent(DialogSyncImportConflictComponent);
      fixture.detectChanges();
      const text = (fixture.nativeElement as HTMLElement).textContent ?? '';

      // Without loaded translations the pipe renders keys, so the keys show which lines are on screen.
      expect(text).toContain('SIDE_SERVER_DATA');
      expect(text).toContain('STAMP_FULL_STATE_SAVED');
      expect(text).toContain('STAMP_LATER_CHANGES');
      expect(text).toContain('SIDE_OWN_IMPORT');
      expect(text).toContain('STAMP_IMPORTED');
      expect(text).not.toContain('RECOMMEND_SERVER');
      expect(text).not.toContain('FIRST_SYNC_WARNING');
      expect(text).not.toContain('REASON_');
      expect(text).not.toContain('AT_RISK');
      expect(
        (fixture.nativeElement as HTMLElement).querySelectorAll('[cdkFocusInitial]')
          .length,
      ).toBe(0);
    });
  });

  describe('initial focus (cdkFocusInitial) follows the safe/primary button per scenario', () => {
    // Renders the real template so we assert which button the Material focus trap
    // will actually focus (it queries `[cdkFocusInitial]`). Regression guard: a
    // fixed focus on USE_REMOTE would, in the LOCAL_IMPORT_FILTERS_REMOTE scenario,
    // make the keyboard default discard the user's just-made local import.
    const renderWithScenario = (
      scenario: SyncImportConflictData['scenario'],
    ): HTMLElement => {
      TestBed.configureTestingModule({
        imports: [DialogSyncImportConflictComponent, TranslateModule.forRoot()],
        providers: [
          provideNoopAnimations(),
          { provide: MatDialogRef, useValue: { close: () => {}, disableClose: false } },
          {
            provide: MAT_DIALOG_DATA,
            useValue: {
              filteredOpCount: 1,
              localImportTimestamp: 0,
              scenario,
            } as SyncImportConflictData,
          },
          {
            provide: DateTimeFormatService,
            useValue: { currentLocale: () => 'en-US', formatTime: () => '00:00' },
          },
        ],
      });
      const fixture = TestBed.createComponent(DialogSyncImportConflictComponent);
      fixture.detectChanges();
      return fixture.nativeElement as HTMLElement;
    };

    it('focuses USE_REMOTE for an INCOMING_IMPORT (USE_LOCAL would overwrite the server)', () => {
      const el = renderWithScenario('INCOMING_IMPORT');

      const focused = el.querySelectorAll('[cdkFocusInitial]');
      expect(focused.length).toBe(1);
      // USE_REMOTE carries the cloud_download icon.
      expect(focused[0].textContent).toContain('cloud_download');
    });

    it('focuses USE_LOCAL for LOCAL_IMPORT_FILTERS_REMOTE (USE_REMOTE would discard the local import)', () => {
      const el = renderWithScenario('LOCAL_IMPORT_FILTERS_REMOTE');

      const focused = el.querySelectorAll('[cdkFocusInitial]');
      expect(focused.length).toBe(1);
      // USE_LOCAL carries the cloud_upload icon.
      expect(focused[0].textContent).toContain('cloud_upload');
    });
  });
});
