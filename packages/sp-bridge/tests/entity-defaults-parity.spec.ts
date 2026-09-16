import { describe, expect, it } from 'vitest';
import {
  DEFAULT_PROJECT,
  DEFAULT_TAG,
  DEFAULT_TASK,
  PRESET_COLORS,
} from '@sp/shared-schema';
import { buildProjectEntity, buildTagEntity, buildTaskEntity } from '../src/op-factory';

// API-created entities must carry the same fields a browser writes, or receiving clients see different shapes for the same kind of thing.
const keysOf = (o: object): string[] => Object.keys(o).sort();

describe('buildTaskEntity', () => {
  it('has every default task field', () => {
    const t = buildTaskEntity({ title: 'x' });
    for (const k of keysOf(DEFAULT_TASK)) expect(t).toHaveProperty(k);
    expect(t.projectId).toBe('INBOX_PROJECT');
  });

  it('writes notes only when given, as the app does', () => {
    expect('notes' in buildTaskEntity({ title: 'x' })).toBe(false);
    expect(buildTaskEntity({ title: 'x', notes: 'n' }).notes).toBe('n');
  });

  it('gives a subtask no tags of its own', () => {
    expect(buildTaskEntity({ title: 'x', parentId: 'p', tagIds: ['a'] }).tagIds).toEqual(
      [],
    );
  });
});

describe('buildTagEntity', () => {
  it('has every default tag field and a fresh id', () => {
    const t = buildTagEntity({ title: 'x' });
    for (const k of keysOf(DEFAULT_TAG)) expect(t).toHaveProperty(k);
    expect(t.id).toBeTruthy();
    expect(t.taskIds).toEqual([]);
  });

  it('picks a preset colour when none is given and keeps an explicit one', () => {
    expect(PRESET_COLORS).toContain(buildTagEntity({ title: 'x' }).color);
    expect(buildTagEntity({ title: 'x', color: '#123456' }).color).toBe('#123456');
  });

  it('keeps an explicit icon', () => {
    expect(buildTagEntity({ title: 'x' }).icon).toBeNull();
    expect(buildTagEntity({ title: 'x', icon: 'star' }).icon).toBe('star');
  });
});

describe('buildProjectEntity', () => {
  it('has every default project field, including icon', () => {
    const p = buildProjectEntity({ title: 'x' });
    for (const k of keysOf(DEFAULT_PROJECT)) expect(p).toHaveProperty(k);
    expect(p.icon).toBeNull();
  });

  it('uses the given colour as the theme primary, else a preset', () => {
    expect(
      (buildProjectEntity({ title: 'x', color: '#123456' }).theme as { primary: string })
        .primary,
    ).toBe('#123456');
    expect(PRESET_COLORS).toContain(
      (buildProjectEntity({ title: 'x' }).theme as { primary: string }).primary,
    );
  });

  it('does not share array instances with the defaults', () => {
    const p = buildProjectEntity({ title: 'x' });
    expect(p.taskIds).not.toBe(DEFAULT_PROJECT.taskIds);
    expect(p.backlogTaskIds).not.toBe(DEFAULT_PROJECT.backlogTaskIds);
  });
});
