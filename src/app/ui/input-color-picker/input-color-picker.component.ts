import {
  ChangeDetectionStrategy,
  Component,
  computed,
  ElementRef,
  HostListener,
  input,
  output,
  signal,
  viewChild,
} from '@angular/core';
import { PRESET_COLORS } from '../../features/work-context/work-context-color';
import { MatIcon } from '@angular/material/icon';
import { TranslatePipe } from '@ngx-translate/core';
import { T } from '../../t.const';
import { LS } from '../../core/persistence/storage-keys.const';
import {
  Hsv,
  hexToHsv,
  hsvToHex,
  normalizeHex,
  pushRecentColor,
  splitAlpha,
  withAlpha,
} from './color-picker.util';

interface EyeDropperResult {
  sRGBHex: string;
}
type EyeDropperCtor = new () => { open(): Promise<EyeDropperResult> };

const PANEL_WIDTH = 236;
const PANEL_HEIGHT = 404;
const PANEL_GAP = 4;

const readRecent = (): string[] => {
  try {
    const parsed: unknown = JSON.parse(localStorage.getItem(LS.RECENT_COLORS) || '[]');
    return Array.isArray(parsed)
      ? parsed.map((c) => normalizeHex(String(c), true)).filter((c): c is string => !!c)
      : [];
  } catch {
    return [];
  }
};

/**
 * The app's one colour picker, used for tags, project and theme colours and note colours.
 * Everything happens in its own panel (a shade square, a hue strip, a hex field, presets and recent colours).
 * The browser's own colour dialog never opens; on Linux that was the GTK chooser.
 * Dragging only previews; the colour is sent on release, so one pick is one change rather than one per pixel.
 * With `allowDefault`, an empty value means "use the default", shown as `defaultColor` with a dashed ring and offered as the panel's first choice.
 * With `allowAlpha`, an opacity strip is added and colours may be `#rrggbbaa`, for tints over whatever lies behind.
 * Only for colours drawn as plain backgrounds or text.
 * Theme, project and tag colours feed Material's palette and contrast maths, which assume a solid colour.
 */
@Component({
  selector: 'input-color-picker',
  templateUrl: './input-color-picker.component.html',
  styleUrls: ['./input-color-picker.component.scss'],
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [MatIcon, TranslatePipe],
})
export class InputColorPickerComponent {
  readonly value = input<string>('#000000');
  readonly label = input<string>('');
  readonly presets = input<readonly string[]>(PRESET_COLORS);
  readonly allowDefault = input<boolean>(false);
  readonly allowAlpha = input<boolean>(false);
  /** What the trigger shows while the value is empty: any CSS colour, e.g. a theme variable. */
  readonly defaultColor = input<string>('transparent');
  readonly valueChange = output<string>();

  readonly T = T;
  readonly trigger = viewChild<ElementRef<HTMLButtonElement>>('trigger');
  readonly svSquare = viewChild<ElementRef<HTMLElement>>('svSquare');
  readonly isOpen = signal(false);
  readonly draft = signal<Hsv>({ h: 0, s: 0, v: 0 });
  readonly hexText = signal('');
  readonly alpha = signal(1);
  /** Every recent colour in this browser, shared by all pickers. */
  private readonly _allRecent = signal<string[]>([]);
  /** The ones this picker can produce: a solid-only picker hides colours with opacity. */
  readonly recent = computed(() =>
    this._allRecent().filter((c) => normalizeHex(c, this.allowAlpha()) === c),
  );
  readonly hasEyeDropper = 'EyeDropper' in window;

  readonly isDefault = computed(
    () => this.allowDefault() && !normalizeHex(this.value() || ''),
  );
  /** The draft without its opacity: what the shade square and its handle show. */
  readonly draftRgb = computed(() => hsvToHex(this.draft()));
  readonly draftHex = computed(() =>
    this.allowAlpha() ? withAlpha(this.draftRgb(), this.alpha()) : this.draftRgb(),
  );
  readonly hueColor = computed(() => hsvToHex({ h: this.draft().h, s: 1, v: 1 }));

  panelTop = '';
  panelLeft = '';

  @HostListener('document:keydown.escape')
  onEscape(): void {
    if (this.isOpen()) {
      this.isOpen.set(false);
    }
  }

  toggle(): void {
    if (this.isOpen()) {
      this.isOpen.set(false);
      return;
    }
    const current = normalizeHex(this.value() || '', this.allowAlpha()) ?? '#808080';
    this._setDraft(current);
    this._allRecent.set(readRecent());
    this._updatePanelPosition();
    this.isOpen.set(true);
  }

  /** A preset, a recent colour or "default": sent at once and the panel closes. */
  selectColor(color: string): void {
    this._emit(color);
    this.isOpen.set(false);
  }

  onSvPointerDown(ev: PointerEvent): void {
    const el = this.svSquare()?.nativeElement;
    if (!el) return;
    ev.preventDefault();
    el.setPointerCapture(ev.pointerId);
    this._moveSv(ev, el);
    const move = (e: PointerEvent): void => this._moveSv(e, el);
    const up = (): void => {
      el.removeEventListener('pointermove', move);
      el.removeEventListener('pointerup', up);
      el.removeEventListener('pointercancel', up);
      this._commitDraft();
    };
    el.addEventListener('pointermove', move);
    el.addEventListener('pointerup', up);
    el.addEventListener('pointercancel', up);
  }

  onHueInput(ev: Event): void {
    this.draft.update((d) => ({ ...d, h: +(ev.target as HTMLInputElement).value }));
    this.hexText.set(this.draftHex());
  }

  onHueChange(): void {
    this._commitDraft();
  }

  onAlphaInput(ev: Event): void {
    this.alpha.set(+(ev.target as HTMLInputElement).value / 100);
    this.hexText.set(this.draftHex());
  }

  onAlphaChange(): void {
    this._commitDraft();
  }

  onHexInput(ev: Event): void {
    const text = (ev.target as HTMLInputElement).value;
    this.hexText.set(text);
    const hex = normalizeHex(text, this.allowAlpha());
    if (hex) {
      this.draft.set(hexToHsv(hex));
      this.alpha.set(splitAlpha(hex).alpha);
    }
  }

  onHexCommit(): void {
    const hex = normalizeHex(this.hexText(), this.allowAlpha());
    if (hex) {
      this._emit(hex);
    } else {
      this.hexText.set(this.draftHex());
    }
  }

  async pickFromScreen(): Promise<void> {
    const ctor = (window as unknown as { EyeDropper?: EyeDropperCtor }).EyeDropper;
    if (!ctor) return;
    try {
      const { sRGBHex } = await new ctor().open();
      const picked = normalizeHex(sRGBHex);
      if (picked) {
        // The screen gives a solid colour; any opacity already set is kept.
        const hex = this.allowAlpha() ? withAlpha(picked, this.alpha()) : picked;
        this._setDraft(hex);
        this._emit(hex);
      }
    } catch {
      // The user pressed Escape while sampling.
    }
  }

  private _moveSv(ev: PointerEvent, el: HTMLElement): void {
    const rect = el.getBoundingClientRect();
    const s = Math.min(1, Math.max(0, (ev.clientX - rect.left) / rect.width));
    const v = 1 - Math.min(1, Math.max(0, (ev.clientY - rect.top) / rect.height));
    this.draft.update((d) => ({ ...d, s, v }));
    this.hexText.set(this.draftHex());
  }

  private _setDraft(hex: string): void {
    this.draft.set(hexToHsv(hex));
    this.alpha.set(splitAlpha(hex).alpha);
    this.hexText.set(hex);
  }

  private _commitDraft(): void {
    this._emit(this.draftHex());
  }

  private _emit(color: string): void {
    const hex = normalizeHex(color, this.allowAlpha());
    if (hex && !this.presets().includes(hex)) {
      const next = pushRecentColor(readRecent(), hex);
      this._allRecent.set(next);
      try {
        localStorage.setItem(LS.RECENT_COLORS, JSON.stringify(next));
      } catch {
        // Storage full or blocked: recent colours are a convenience only.
      }
    }
    this.valueChange.emit(hex ?? '');
  }

  private _updatePanelPosition(): void {
    const rect = this.trigger()?.nativeElement.getBoundingClientRect();
    if (!rect) return;
    const left =
      window.innerWidth - rect.left >= PANEL_WIDTH
        ? rect.left
        : Math.max(8, window.innerWidth - PANEL_WIDTH - 8);
    const top =
      window.innerHeight - rect.bottom >= PANEL_HEIGHT + PANEL_GAP
        ? rect.bottom + PANEL_GAP
        : Math.max(8, rect.top - PANEL_HEIGHT - PANEL_GAP);
    this.panelTop = `${top}px`;
    this.panelLeft = `${left}px`;
  }
}
