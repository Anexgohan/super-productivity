import { ChangeDetectionStrategy, Component, computed, input } from '@angular/core';
import { isSingleEmoji } from '../../util/extract-first-emoji';
import { MatIcon } from '@angular/material/icon';

@Component({
  selector: 'select-option-row',
  standalone: true,
  imports: [MatIcon],
  templateUrl: './select-option-row.component.html',
  styleUrl: './select-option-row.component.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class SelectOptionRowComponent {
  title = input.required<string>();
  icon = input<string | undefined>();
  defaultIcon = input<string | undefined>();
  color = input<string | undefined>();
  folderPath = input<string | null | undefined>(null);
  isSelected = input<boolean>(false);
  showCheckbox = input<boolean>(false);
  /** `radio` for a pick-one list, where a checkbox would read as pick-many. */
  selectionStyle = input<'checkbox' | 'radio'>('checkbox');

  checkIcon = computed(() => {
    const isOn = this.isSelected();
    if (this.selectionStyle() === 'radio') {
      return isOn ? 'radio_button_checked' : 'radio_button_unchecked';
    }
    return isOn ? 'check_box' : 'check_box_outline_blank';
  });

  effectiveIcon = computed(() => this.icon() || this.defaultIcon());

  isEmoji = computed(() => {
    const icon = this.effectiveIcon();
    return !!icon && isSingleEmoji(icon);
  });
}
