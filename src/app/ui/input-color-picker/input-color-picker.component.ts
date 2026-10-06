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
} from './color-picker.util';

interface EyeDropperResult {
  sRGBHex: string;
}
type EyeDropperCtor = new () => { open(): Promise<EyeDropperResult> };

const PANEL_WIDTH = 236;
const PANEL_HEIGHT = 380;
const PANEL_GAP = 4;

const readRecent = (): string[] => {
  try {
    const parsed: unknown = JSON.parse(localStorage.getItem(LS.RECENT_COLORS) || '[]');
    return Array.isArray(parsed)
      ? parsed.map((c) => normalizeHex(String(c))).filter((c): c is string => !!c)
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
  /** What the trigger shows while the value is empty: any CSS colour, e.g. a theme variable. */
  readonly defaultColor = input<string>('transparent');
  readonly valueChange = output<string>();

  readonly T = T;
  readonly trigger = viewChild<ElementRef<HTMLButtonElement>>('trigger');
  readonly svSquare = viewChild<ElementRef<HTMLElement>>('svSquare');
  readonly isOpen = signal(false);
  readonly draft = signal<Hsv>({ h: 0, s: 0, v: 0 });
  readonly hexText = signal('');
  readonly recent = signal<string[]>([]);
  readonly hasEyeDropper = 'EyeDropper' in window;

  readonly isDefault = computed(
    () => this.allowDefault() && !normalizeHex(this.value() || ''),
  );
  readonly draftHex = computed(() => hsvToHex(this.draft()));
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
    const current = normalizeHex(this.value() || '') ?? '#808080';
    this.draft.set(hexToHsv(current));
    this.hexText.set(current);
    this.recent.set(readRecent());
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

  onHexInput(ev: Event): void {
    const text = (ev.target as HTMLInputElement).value;
    this.hexText.set(text);
    const hex = normalizeHex(text);
    if (hex) this.draft.set(hexToHsv(hex));
  }

  onHexCommit(): void {
    const hex = normalizeHex(this.hexText());
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
      const hex = normalizeHex(sRGBHex);
      if (hex) {
        this.draft.set(hexToHsv(hex));
        this.hexText.set(hex);
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

  private _commitDraft(): void {
    this._emit(this.draftHex());
  }

  private _emit(color: string): void {
    const hex = normalizeHex(color);
    if (hex && !this.presets().includes(hex)) {
      const next = pushRecentColor(readRecent(), hex);
      this.recent.set(next);
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
