/**
 * Board-level `projectIds` over the API.
 *
 * The reason this file exists: the UI can assign a board to a project, so an
 * API that silently drops the field would leave the two able to see different
 * boards — the container/API asymmetry this bridge exists to prevent. Dropping
 * a field is a 200, not an error, so nothing downstream would notice.
 */
import { describe, expect, it } from 'vitest';
import { buildBoardEntity } from '../src/op-factory';

describe('buildBoardEntity projectIds', () => {
  it('defaults to unassigned when not supplied', () => {
    const board = buildBoardEntity({ title: 'Board' });
    expect(board.projectIds).toEqual(['']);
  });

  it('keeps an explicit project assignment', () => {
    const board = buildBoardEntity({ title: 'Work', projectIds: ['p1'] });
    expect(board.projectIds).toEqual(['p1']);
  });

  it('keeps a multi-project assignment', () => {
    const board = buildBoardEntity({ title: 'Both', projectIds: ['p1', 'p2'] });
    expect(board.projectIds).toEqual(['p1', 'p2']);
  });

  it('carries the explicit unassigned sentinel through unchanged', () => {
    const board = buildBoardEntity({ title: 'All', projectIds: [''] });
    expect(board.projectIds).toEqual(['']);
  });
});
