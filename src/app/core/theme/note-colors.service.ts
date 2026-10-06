import { computed, effect, inject, Injectable, signal } from '@angular/core';
import { DOCUMENT } from '@angular/common';
import { LS } from '../persistence/storage-keys.const';
import { CustomThemeService } from './custom-theme.service';
import { GlobalThemeService } from './global-theme.service';
import {
  NOTE_COLOR_CSS,
  NOTE_COLOR_FIELDS,
  NoteColorField,
  NoteColors,
  NoteColorsByTheme,
  noteColorsThemeKey,
  parseNoteColors,
  clearNoteColor,
  resetNoteColors,
  setNoteColor,
} from './note-colors.util';

/**
 * Applies the note colour overrides for the active theme as CSS custom properties and switch classes on the document root.
 * Writes go through localStorage so `SyncedUiPrefsService` carries them to the account.
 * Reset writes the smaller map rather than removing the key, because a removed key never reaches other devices.
 */
@Injectable({ providedIn: 'root' })
export class NoteColorsService {
  private readonly _document = inject(DOCUMENT);
  private readonly _customThemeService = inject(CustomThemeService);
  private readonly _globalThemeService = inject(GlobalThemeService);

  private readonly _all = signal<NoteColorsByTheme>(
    parseNoteColors(localStorage.getItem(LS.NOTE_COLORS)),
  );

  private readonly _themeKey = computed(() => {
    const ref = this._customThemeService.activeRef();
    return noteColorsThemeKey(
      `${ref.kind}:${ref.id}`,
      this._globalThemeService.isDarkTheme(),
    );
  });

  /** The overrides for the theme and light/dark variant on screen now. */
  readonly current = computed<NoteColors>(() => this._all()[this._themeKey()] ?? {});

  constructor() {
    effect(() => {
      const colors = this.current();
      const root = this._document.documentElement;
      for (const field of NOTE_COLOR_FIELDS) {
        const { cssVar, rootClass } = NOTE_COLOR_CSS[field];
        const value = colors[field];
        if (value) {
          root.style.setProperty(cssVar, value);
        } else {
          root.style.removeProperty(cssVar);
        }
        root.classList.toggle(rootClass, !!value);
      }
    });
  }

  /** Re-reads storage, for when the account's preferences arrive after this service was built. */
  reloadFromStorage(): void {
    this._all.set(parseNoteColors(localStorage.getItem(LS.NOTE_COLORS)));
  }

  /** An empty value is the picker's "theme default" and clears that one colour. */
  setColor(field: NoteColorField, value: string): void {
    this._save(
      value
        ? setNoteColor(this._all(), this._themeKey(), field, value)
        : clearNoteColor(this._all(), this._themeKey(), field),
    );
  }

  resetCurrentTheme(): void {
    this._save(resetNoteColors(this._all(), this._themeKey()));
  }

  private _save(next: NoteColorsByTheme): void {
    if (next === this._all()) return;
    this._all.set(next);
    localStorage.setItem(LS.NOTE_COLORS, JSON.stringify(next));
  }
}
