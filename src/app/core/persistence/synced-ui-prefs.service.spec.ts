import { TestBed } from '@angular/core/testing';
import { signal } from '@angular/core';
import { of } from 'rxjs';
import { decidePrefsOwnership, SyncedUiPrefsService } from './synced-ui-prefs.service';
import { GlobalConfigService } from '../../features/config/global-config.service';
import { LS } from './storage-keys.const';
import {
  IS_READ_ONLY_BOARD,
  SERVED_BOARD_IDENTITY,
} from '../../imex/sync/container-authority.service';

const ME = 'inst-1:5';
const OTHER = 'inst-1:9';

describe('decidePrefsOwnership', () => {
  it('leaves an ungated deployment alone', () => {
    expect(decidePrefsOwnership(ME, null, false)).toBe('ungated');
    expect(decidePrefsOwnership(null, null, false)).toBe('ungated');
  });

  it('takes nothing from a shared board being read, whoever the stamp names', () => {
    expect(decidePrefsOwnership(ME, OTHER, true)).toBe('read-only');
    expect(decidePrefsOwnership(null, OTHER, true)).toBe('read-only');
  });

  it('keeps preferences stamped with this account', () => {
    expect(decidePrefsOwnership(ME, ME, false)).toBe('matched');
  });

  it('adopts unstamped preferences from before stamping', () => {
    expect(decidePrefsOwnership(null, ME, false)).toBe('adopted');
  });

  it('resets preferences stamped with another account', () => {
    expect(decidePrefsOwnership(OTHER, ME, false)).toBe('reset');
  });
});

describe('SyncedUiPrefsService ownership', () => {
  let service: SyncedUiPrefsService;
  let updateSection: jasmine.Spy;
  let accountPrefs: Record<string, string>;

  beforeEach(() => {
    localStorage.removeItem(LS.CUSTOM_THEME);
    localStorage.removeItem(LS.NOTE_COLORS);
    localStorage.removeItem(LS.UI_PREFS_OWNER);
    accountPrefs = {};
    updateSection = jasmine.createSpy('updateSection');
    TestBed.configureTestingModule({
      providers: [
        SyncedUiPrefsService,
        {
          provide: GlobalConfigService,
          useValue: {
            misc: signal({ uiPrefs: accountPrefs }),
            misc$: of({ uiPrefs: accountPrefs }),
            updateSection,
          },
        },
      ],
    });
    service = TestBed.inject(SyncedUiPrefsService);
  });

  afterEach(() => {
    SERVED_BOARD_IDENTITY.set(null);
    IS_READ_ONLY_BOARD.set(false);
    localStorage.removeItem(LS.CUSTOM_THEME);
    localStorage.removeItem(LS.NOTE_COLORS);
    localStorage.removeItem(LS.UI_PREFS_OWNER);
  });

  it("drops another account's preferences and stamps this one, without writing to any account", () => {
    localStorage.setItem(LS.UI_PREFS_OWNER, OTHER);
    localStorage.setItem(LS.NOTE_COLORS, '{"x":{"bg":"#000000"}}');
    SERVED_BOARD_IDENTITY.set(ME);

    expect(service.claimForCurrentIdentity()).toBe('reset');

    expect(localStorage.getItem(LS.NOTE_COLORS)).toBeNull();
    expect(localStorage.getItem(LS.UI_PREFS_OWNER)).toBe(ME);
    expect(service.seedMissingFromLocal()).toBe(0);
    expect(updateSection).not.toHaveBeenCalled();
  });

  it('keeps and seeds preferences that are already this account’s', () => {
    localStorage.setItem(LS.UI_PREFS_OWNER, ME);
    localStorage.setItem(LS.CUSTOM_THEME, 'builtin:zen');
    SERVED_BOARD_IDENTITY.set(ME);

    expect(service.claimForCurrentIdentity()).toBe('matched');
    // Other specs may leave synced keys in the shared Karma localStorage, so only this one is asserted.
    expect(service.seedMissingFromLocal()).toBeGreaterThanOrEqual(1);
    expect(updateSection).toHaveBeenCalledWith(
      'misc',
      { uiPrefs: jasmine.objectContaining({ [LS.CUSTOM_THEME]: 'builtin:zen' }) },
      true,
    );
  });

  it("neither loads nor seeds while someone else's shared board is open", () => {
    localStorage.setItem(LS.UI_PREFS_OWNER, ME);
    localStorage.setItem(LS.CUSTOM_THEME, 'builtin:zen');
    accountPrefs[LS.NOTE_COLORS] = '{"owner":{"bg":"#ffffff"}}';
    SERVED_BOARD_IDENTITY.set(OTHER);
    IS_READ_ONLY_BOARD.set(true);

    expect(service.claimForCurrentIdentity()).toBe('read-only');
    expect(service.hydrateNow()).toBe(0);
    expect(service.seedMissingFromLocal()).toBe(0);

    expect(localStorage.getItem(LS.NOTE_COLORS)).toBeNull();
    expect(localStorage.getItem(LS.CUSTOM_THEME)).toBe('builtin:zen');
    expect(localStorage.getItem(LS.UI_PREFS_OWNER)).toBe(ME);
    expect(updateSection).not.toHaveBeenCalled();
  });

  it('forgetLocal clears the browser copy and the stamp only', () => {
    localStorage.setItem(LS.UI_PREFS_OWNER, ME);
    localStorage.setItem(LS.CUSTOM_THEME, 'builtin:zen');

    service.forgetLocal();

    expect(localStorage.getItem(LS.CUSTOM_THEME)).toBeNull();
    expect(localStorage.getItem(LS.UI_PREFS_OWNER)).toBeNull();
    expect(updateSection).not.toHaveBeenCalled();
  });
});
