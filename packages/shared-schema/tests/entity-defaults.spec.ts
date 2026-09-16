import { describe, expect, it } from 'vitest';
import { DEFAULT_TAG, PRESET_COLORS, createTagObject } from '../src';

describe('createTagObject', () => {
  let n = 0;
  const newId = (): string => `id-${++n}`;

  it('fills defaults and a random preset colour', () => {
    const t = createTagObject({ title: 'work' }, newId);
    expect(t.title).toBe('work');
    expect(t.id).toMatch(/^id-/);
    expect(t.taskIds).toEqual([]);
    expect(t.icon).toBeNull();
    expect(PRESET_COLORS).toContain(t.color);
    expect(t.theme).toEqual(DEFAULT_TAG.theme);
  });

  it('keeps caller fields, including id and colour', () => {
    const t = createTagObject({ id: 'fixed', title: 'x', color: '#000000' }, newId);
    expect(t.id).toBe('fixed');
    expect(t.color).toBe('#000000');
  });

  it('names an untitled tag EMPTY', () => {
    expect(createTagObject({}, newId).title).toBe('EMPTY');
  });
});
