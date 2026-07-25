import { inject, Injectable } from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { DestroyRef } from '@angular/core';
import { debounceTime, distinctUntilChanged, map } from 'rxjs/operators';
import { Subject } from 'rxjs';
import { GlobalConfigService } from '../../features/config/global-config.service';
import { LS } from './storage-keys.const';
import { Log } from '../log';

/**
 * Makes user PREFERENCES follow the account instead of the browser profile
 * (anex/container-parity).
 *
 * Upstream keeps these in localStorage, which makes them per-profile: a new
 * browser, a private window, or cleared site data silently reverts them, and
 * they never travel between devices. That is the same split-authority problem
 * the container work exists to remove — the backend should own user state, and
 * the client should be a view of it.
 *
 * Implemented as ONE interception point rather than edits in ~19 services:
 *  - the same three-line change repeated across upstream files would conflict
 *    on every merge, and upstream is actively moving MORE settings into
 *    localStorage (see CustomThemeService's migration away from
 *    globalConfig.misc.customTheme), so that list will keep growing
 *  - adding a newly-discovered preference here is one array entry
 *
 * Deliberately NOT synced (see SYNCED_KEYS): window geometry and sidebar
 * expansion. Those depend on the screen in front of you — pushing a desktop's
 * sidebar width onto a laptop makes the experience worse, not more consistent.
 * Caches, debug logs, per-install counters and per-build dismissals stay local
 * for the same reason: they describe the device, not the user.
 *
 * Three things have to be true for this to actually work, and only the first
 * was true originally:
 *  1. writes are captured — `_interceptLocalWrites`
 *  2. the interception is installed before anything writes. It used to run from
 *     startup's DEFERRED block, a second in, so an early write vanished
 *  3. values that predate the interception are adopted, not ignored —
 *     `seedMissingFromLocal`. Capture-on-write alone means a preference already
 *     sitting in localStorage syncs NOWHERE, ever, and dies with that browser's
 *     storage. That is how a user's chosen theme was lost while
 *     `misc.uiPrefs` sat empty on the server for days.
 *
 * KNOWN LIMITATION: most consumers read their localStorage value once at
 * construction, so a preference changed on ANOTHER device applies here on the
 * next reload rather than instantly. A fresh browser is handled by
 * `hydrateNow()`, called from StartupService before the theme is applied.
 * Settings that need to react live (dark mode) do so in their own service.
 */

/** Preferences that describe the USER and should follow the account. */
const SYNCED_KEYS: readonly string[] = [
  LS.CUSTOM_THEME,
  LS.IS_ADD_TO_BOTTOM,
  LS.TASK_VIEW_CUSTOMIZER_BY_CONTEXT,
  LS.DONE_TASKS_HIDDEN,
  LS.LATER_TODAY_TASKS_HIDDEN,
  LS.OVERDUE_TASKS_HIDDEN,
  LS.REPEAT_CFGS_HIDDEN,
  LS.SELECTED_TIME_VIEW,
  LS.SCHEDULE_WEEK_ROW_HEIGHT,
  LS.SELECTED_BOARD,
  LS.FOCUS_MODE_MODE,
  LS.LAST_COUNTDOWN_DURATION,
  LS.LAST_IDLE_DIALOG_MODE,
  LS.LAST_FULLSCREEN_EDIT_VIEW_MODE,
  LS.HIDDEN_CALENDAR_EVENT_IDS,
  LS.HIDDEN_CALENDAR_PROVIDER_IDS,
  // Onboarding: having already done the tour is a fact about the user, not the
  // device — a new browser should not re-run it.
  LS.IS_SKIP_TOUR,
  LS.ONBOARDING_PRESET_DONE,
  LS.ONBOARDING_HINTS_DONE,
];

/** Coalesce bursts (e.g. dragging a row-height control) into one sync op. */
const PERSIST_DEBOUNCE_MS = 400;

@Injectable({ providedIn: 'root' })
export class SyncedUiPrefsService {
  private _globalConfigService = inject(GlobalConfigService);
  private _destroyRef = inject(DestroyRef);

  private readonly _adopted$ = new Subject<string[]>();

  /** Keys just written from the account. They arrive after data-init on a cleared browser, so consumers must react rather than read once. */
  readonly adopted$ = this._adopted$.asObservable();

  /** Set while writing values received FROM the server, to avoid echoing them back. */
  private _isApplyingRemote = false;
  private _isInstalled = false;
  private _pending: Record<string, string | null> = {};
  private _flushTimer: ReturnType<typeof setTimeout> | null = null;

  init(): void {
    if (this._isInstalled) {
      return;
    }
    this._isInstalled = true;
    this._interceptLocalWrites();
    this._adoptRemoteChanges();
  }

  /**
   * Wraps localStorage's mutators so every existing call site keeps working
   * unchanged while tracked keys additionally persist to the synced config.
   * Scoped strictly to SYNCED_KEYS — untracked keys pass straight through.
   */
  private _interceptLocalWrites(): void {
    const setItem = localStorage.setItem.bind(localStorage);
    const removeItem = localStorage.removeItem.bind(localStorage);

    localStorage.setItem = (key: string, value: string): void => {
      setItem(key, value);
      if (!this._isApplyingRemote && SYNCED_KEYS.includes(key)) {
        this._queue(key, value);
      }
    };
    localStorage.removeItem = (key: string): void => {
      removeItem(key);
      if (!this._isApplyingRemote && SYNCED_KEYS.includes(key)) {
        this._queue(key, null);
      }
    };
  }

  private _queue(key: string, value: string | null): void {
    this._pending[key] = value;
    if (this._flushTimer) {
      clearTimeout(this._flushTimer);
    }
    this._flushTimer = setTimeout(() => {
      this._flushTimer = null;
      this._flush();
    }, PERSIST_DEBOUNCE_MS);
  }

  private _flush(): void {
    const pending = this._pending;
    this._pending = {};
    if (!Object.keys(pending).length) {
      return;
    }
    try {
      const current = this._globalConfigService.misc()?.uiPrefs ?? {};
      const next: Record<string, string> = { ...current };
      for (const [key, value] of Object.entries(pending)) {
        if (value === null) {
          delete next[key];
        } else {
          next[key] = value;
        }
      }
      // Nothing actually changed (e.g. a re-write of the same value) — skip the
      // op so we don't churn the sync log.
      if (JSON.stringify(next) === JSON.stringify(current)) {
        return;
      }
      this._globalConfigService.updateSection('misc', { uiPrefs: next }, true);
    } catch (err) {
      Log.err({ stage: 'synced-ui-prefs-flush', error: (err as Error).message });
    }
  }

  /**
   * Writes the account's stored preferences into localStorage right now.
   *
   * Needed because most consumers read localStorage once, at construction or
   * even at module load, so the subscription in `_adoptRemoteChanges` lands too
   * late for them on a fresh browser: the value arrives after the theme has
   * already been applied and the work-view signals already initialised, so the
   * account's settings only appeared on the *next* reload.
   *
   * Call before anything reads a preference — see StartupService.init().
   * Returns the number of keys written, for logging.
   */
  hydrateNow(): number {
    const prefs = this._globalConfigService.misc()?.uiPrefs;
    if (!prefs) {
      return 0;
    }
    let written = 0;
    this._isApplyingRemote = true;
    try {
      for (const key of SYNCED_KEYS) {
        const remote = prefs[key];
        if (remote === undefined || localStorage.getItem(key) === remote) {
          continue;
        }
        localStorage.setItem(key, remote);
        written++;
      }
    } finally {
      this._isApplyingRemote = false;
    }
    return written;
  }

  /**
   * Pushes preferences this browser holds but the account does not know about.
   *
   * Interception only ever captured writes as they happened, so a value already
   * sitting in localStorage — set before this feature existed, or before the
   * interception was installed on that visit — was invisible to it forever. It
   * synced nowhere and was lost the moment that browser's storage was cleared.
   * That is not a hypothetical: `misc.uiPrefs` was absent entirely on a stack
   * whose owner had been using a chosen theme for days.
   *
   * Deliberately additive. A key the account already has is left alone, so this
   * can never overwrite a preference set on another device with whatever this
   * browser happens to hold — the server stays authoritative, and this only
   * fills gaps.
   *
   * Returns the number of keys seeded, for logging.
   */
  seedMissingFromLocal(): number {
    const current = this._globalConfigService.misc()?.uiPrefs ?? {};
    const next: Record<string, string> = { ...current };
    let seeded = 0;
    for (const key of SYNCED_KEYS) {
      if (next[key] !== undefined) {
        continue;
      }
      const local = localStorage.getItem(key);
      if (local === null) {
        continue;
      }
      next[key] = local;
      seeded++;
    }
    if (seeded === 0) {
      return 0;
    }
    this._globalConfigService.updateSection('misc', { uiPrefs: next }, true);
    return seeded;
  }

  /** Applies preferences coming from the server into this browser. */
  private _adoptRemoteChanges(): void {
    this._globalConfigService.misc$
      .pipe(
        map((misc) => misc?.uiPrefs),
        // Prefs arrive as a whole map; compare serialized so an unchanged map
        // (re-emitted on any other misc change) does no work.
        distinctUntilChanged((a, b) => JSON.stringify(a) === JSON.stringify(b)),
        debounceTime(0),
        takeUntilDestroyed(this._destroyRef),
      )
      .subscribe((prefs) => {
        if (!prefs) {
          return;
        }
        const changed: string[] = [];
        this._isApplyingRemote = true;
        try {
          for (const key of SYNCED_KEYS) {
            const remote = prefs[key];
            if (remote === undefined) {
              continue;
            }
            if (localStorage.getItem(key) !== remote) {
              localStorage.setItem(key, remote);
              changed.push(key);
            }
          }
        } finally {
          this._isApplyingRemote = false;
        }
        if (changed.length) {
          this._adopted$.next(changed);
        }
      });
  }
}
