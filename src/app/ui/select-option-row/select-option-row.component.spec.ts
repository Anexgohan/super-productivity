import { Component, ViewChild } from '@angular/core';
import { ComponentFixture, TestBed } from '@angular/core/testing';
import { MatMenuItem, MatMenuModule } from '@angular/material/menu';

import { SelectOptionRowComponent } from './select-option-row.component';

@Component({
  imports: [MatMenuModule, SelectOptionRowComponent],
  template: `
    <button
      #emojiItem="matMenuItem"
      mat-menu-item
    >
      <select-option-row
        title="Emoji Project"
        icon="🎨"
        defaultIcon="folder"
      ></select-option-row>
    </button>
  `,
})
class SelectOptionRowMenuHostComponent {
  @ViewChild('emojiItem') emojiItem?: MatMenuItem;
}

describe('SelectOptionRowComponent', () => {
  let fixture: ComponentFixture<SelectOptionRowMenuHostComponent>;

  beforeEach(async () => {
    await TestBed.configureTestingModule({
      imports: [SelectOptionRowMenuHostComponent],
    }).compileComponents();

    fixture = TestBed.createComponent(SelectOptionRowMenuHostComponent);
    fixture.detectChanges();
  });

  it('keeps emoji icons out of Angular Material menu typeahead labels', () => {
    const button = fixture.nativeElement.querySelector('button') as HTMLButtonElement;

    expect(button.textContent).toContain('🎨');
    expect(fixture.componentInstance.emojiItem?.getLabel()).toBe('Emoji Project');
  });
});

describe('SelectOptionRowComponent selection icon', () => {
  const iconFor = (selectionStyle: 'checkbox' | 'radio', isSelected: boolean): string => {
    const fixture = TestBed.createComponent(SelectOptionRowComponent);
    fixture.componentRef.setInput('title', 'Row');
    fixture.componentRef.setInput('showCheckbox', true);
    fixture.componentRef.setInput('selectionStyle', selectionStyle);
    fixture.componentRef.setInput('isSelected', isSelected);
    fixture.detectChanges();
    return (fixture.nativeElement as HTMLElement)
      .querySelector('.check-ico')!
      .textContent!.trim();
  };

  it('defaults to checkboxes', () => {
    const fixture = TestBed.createComponent(SelectOptionRowComponent);
    fixture.componentRef.setInput('title', 'Row');
    fixture.componentRef.setInput('showCheckbox', true);
    fixture.detectChanges();
    expect(
      (fixture.nativeElement as HTMLElement)
        .querySelector('.check-ico')!
        .textContent!.trim(),
    ).toBe('check_box_outline_blank');
  });

  it('shows radio buttons for a pick-one list', () => {
    expect(iconFor('radio', true)).toBe('radio_button_checked');
    expect(iconFor('radio', false)).toBe('radio_button_unchecked');
  });

  it('keeps checkboxes for a pick-many list', () => {
    expect(iconFor('checkbox', true)).toBe('check_box');
  });
});
