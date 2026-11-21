import { signal, WritableSignal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { HttpClient } from '@angular/common/http';
import { MatIconRegistry } from '@angular/material/icon';
import { DomSanitizer } from '@angular/platform-browser';
import { Router } from '@angular/router';
import { MaterialCssVarsService } from 'angular-material-css-vars';
import { BehaviorSubject, NEVER } from 'rxjs';
import { type WorkContextThemeCfg } from '../../features/work-context/work-context.model';
import { WorkContextService } from '../../features/work-context/work-context.service';
import { GlobalConfigService } from '../../features/config/global-config.service';
import { MiscConfig } from '../../features/config/global-config.model';
import { LayoutService } from '../../core-ui/layout/layout.service';
import { ChromeExtensionInterfaceService } from '../chrome-extension-interface/chrome-extension-interface.service';
import { ImexViewService } from '../../imex/imex-meta/imex-view.service';
import { CapacitorPlatformService } from '../platform/capacitor-platform.service';
import { InputIntentService } from '../input-intent/input-intent.service';
import { LS } from '../persistence/storage-keys.const';
import {
  DarkModeCfg,
  GlobalThemeService,
  GlobalWallpaperCfg,
  resolveBackground,
} from './global-theme.service';

describe('resolveBackground()', () => {
  const contextTheme: WorkContextThemeCfg = {
    backgroundImageDark: 'ctx-dark.jpg',
    backgroundImageLight: 'ctx-light.jpg',
    backgroundOverlayOpacity: 50,
    backgroundImageBlur: 8,
  };
  const contextThemeWithoutImage: WorkContextThemeCfg = {
    backgroundImageDark: null,
    backgroundImageLight: null,
    backgroundOverlayOpacity: 50,
    backgroundImageBlur: 8,
  };
  const globalCfg: GlobalWallpaperCfg = {
    backgroundImageDark: 'global-dark.jpg',
    backgroundImageLight: 'global-light.jpg',
    backgroundOverlayOpacity: 30,
    backgroundImageBlur: 4,
  };
  const globalCfgEmpty: GlobalWallpaperCfg = {
    backgroundImageDark: null,
    backgroundImageLight: null,
  };

  describe('before initial navigation resolves (empty url)', () => {
    it('shows no background when no global wallpaper is set', () => {
      expect(
        resolveBackground(contextTheme, globalCfgEmpty, false, '').imageUrl,
      ).toBeNull();
    });

    it('shows the global wallpaper when set (never the sticky context image)', () => {
      const res = resolveBackground(contextTheme, globalCfg, false, '');
      expect(res.imageUrl).toBe('global-light.jpg');
      // global styling, not the sticky context's
      expect(res.overlayOpacity).toBe(0.3);
      expect(res.blur).toBe(4);
    });
  });

  ['/planner', '/schedule', '/boards', '/config'].forEach((url) => {
    it(`never uses the active context image on non-context route ${url}`, () => {
      expect(
        resolveBackground(contextTheme, globalCfgEmpty, false, url).imageUrl,
      ).toBeNull();
    });

    it(`shows the global wallpaper + global styling on ${url}`, () => {
      const light = resolveBackground(contextTheme, globalCfg, false, url);
      expect(light.imageUrl).toBe('global-light.jpg');
      expect(light.overlayOpacity).toBe(0.3);
      expect(light.blur).toBe(4);

      const dark = resolveBackground(contextTheme, globalCfg, true, url);
      expect(dark.imageUrl).toBe('global-dark.jpg');
    });
  });

  ['/tag/TODAY/tasks', '/project/project-1/tasks'].forEach((url) => {
    it(`uses the context image + context styling on ${url}`, () => {
      const res = resolveBackground(contextTheme, globalCfg, false, url);
      expect(res.imageUrl).toBe('ctx-light.jpg');
      // styling must come from the context that owns the image
      expect(res.overlayOpacity).toBe(0.5);
      expect(res.blur).toBe(8);
    });

    it(`falls back to the global wallpaper + global styling on ${url} when the context has no image`, () => {
      const res = resolveBackground(contextThemeWithoutImage, globalCfg, false, url);
      expect(res.imageUrl).toBe('global-light.jpg');
      expect(res.overlayOpacity).toBe(0.3);
      expect(res.blur).toBe(4);
    });

    it(`treats a cleared (empty-string) context image as unset and falls back to global on ${url}`, () => {
      const cleared: WorkContextThemeCfg = {
        backgroundImageLight: '   ',
        backgroundImageDark: '',
      };
      expect(resolveBackground(cleared, globalCfg, false, url).imageUrl).toBe(
        'global-light.jpg',
      );
    });
  });

  it('does not misclassify a non-context route that mentions /tag/ in its query', () => {
    // regex is anchored to the path start
    expect(
      resolveBackground(contextTheme, globalCfgEmpty, false, '/planner?ref=/tag/TODAY')
        .imageUrl,
    ).toBeNull();
  });

  it('uses the dark context image in dark mode', () => {
    expect(
      resolveBackground(contextTheme, globalCfgEmpty, true, '/tag/TODAY/tasks').imageUrl,
    ).toBe('ctx-dark.jpg');
  });

  describe('overlay-opacity + blur math (migrated from app.component helpers)', () => {
    it('defaults to 20% overlay / 0 blur when the winning source sets neither', () => {
      const res = resolveBackground(
        {},
        { backgroundImageLight: 'g.jpg' },
        false,
        '/planner',
      );
      expect(res.overlayOpacity).toBe(0.2);
      expect(res.blur).toBe(0);
    });

    it('converts overlay opacity to a CSS alpha and clamps blur', () => {
      const highOpacity = resolveBackground(
        { backgroundImageLight: 'c.jpg', backgroundOverlayOpacity: 65 },
        globalCfgEmpty,
        false,
        '/tag/TODAY/tasks',
      );
      expect(highOpacity.overlayOpacity).toBe(0.65);

      const negativeBlur = resolveBackground(
        { backgroundImageLight: 'c.jpg', backgroundImageBlur: -5 },
        globalCfgEmpty,
        false,
        '/tag/TODAY/tasks',
      );
      expect(negativeBlur.blur).toBe(0);
    });
  });
});

describe('GlobalThemeService dark mode persistence', () => {
  const baseMisc = { isDisableAnimations: false } as MiscConfig;
  let misc$: BehaviorSubject<MiscConfig>;
  let misc: WritableSignal<MiscConfig>;
  let updateSection: jasmine.Spy;
  let storedDarkMode: string | null;

  const emitMisc = (value: MiscConfig): void => {
    misc.set(value);
    misc$.next(value);
  };

  const setup = (cached: DarkModeCfg, initialMisc: MiscConfig): GlobalThemeService => {
    localStorage.setItem(LS.DARK_MODE, cached);
    misc$ = new BehaviorSubject(initialMisc);
    misc = signal(initialMisc);
    updateSection = jasmine.createSpy('updateSection');
    TestBed.configureTestingModule({
      providers: [
        GlobalThemeService,
        { provide: GlobalConfigService, useValue: { misc$, misc, updateSection } },
        { provide: WorkContextService, useValue: { currentTheme$: NEVER } },
        { provide: Router, useValue: { events: NEVER, url: '' } },
        { provide: LayoutService, useValue: {} },
        { provide: MaterialCssVarsService, useValue: {} },
        { provide: MatIconRegistry, useValue: {} },
        { provide: DomSanitizer, useValue: {} },
        { provide: ChromeExtensionInterfaceService, useValue: {} },
        { provide: ImexViewService, useValue: {} },
        { provide: HttpClient, useValue: {} },
        { provide: CapacitorPlatformService, useValue: {} },
        { provide: InputIntentService, useValue: {} },
      ],
    });
    const service = TestBed.inject(GlobalThemeService);
    TestBed.runInInjectionContext(() => service['_initDarkModePersistence']());
    TestBed.flushEffects();
    return service;
  };

  beforeEach(() => {
    storedDarkMode = localStorage.getItem(LS.DARK_MODE);
  });

  afterEach(() => {
    if (storedDarkMode === null) {
      localStorage.removeItem(LS.DARK_MODE);
    } else {
      localStorage.setItem(LS.DARK_MODE, storedDarkMode);
    }
  });

  it('saves nothing on a reload, before or after the config hydrates', () => {
    setup('dark', baseMisc);
    expect(updateSection).not.toHaveBeenCalled();

    emitMisc({ ...baseMisc, darkMode: 'dark' });
    TestBed.flushEffects();
    expect(updateSection).not.toHaveBeenCalled();
  });

  it('saves a change made by the user once', () => {
    const service = setup('dark', { ...baseMisc, darkMode: 'dark' });

    service.darkMode.set('light');
    TestBed.flushEffects();
    emitMisc({ ...baseMisc, darkMode: 'light' });
    TestBed.flushEffects();

    expect(updateSection).toHaveBeenCalledOnceWith('misc', { darkMode: 'light' }, true);
  });

  it('adopts a value synced from another browser without saving it back', () => {
    const service = setup('dark', { ...baseMisc, darkMode: 'dark' });

    emitMisc({ ...baseMisc, darkMode: 'light' });
    TestBed.flushEffects();

    expect(service.darkMode()).toBe('light');
    expect(localStorage.getItem(LS.DARK_MODE)).toBe('light');
    expect(updateSection).not.toHaveBeenCalled();
  });
});
