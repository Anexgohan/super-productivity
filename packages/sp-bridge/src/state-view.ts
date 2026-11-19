/**
 * The API's view of a board (anex/app-rules): the app rules' full state in the flat shape every route reads.
 *
 * The app rules hand over their state in the shape a browser uploads in a full import (AppDataComplete). The routes read
 * `state.TASK[id]`, `state.BOARD.boardCfgs` and so on; this turns one into the other. It is the same conversion the bridge
 * has always applied to a full import, so every route keeps working unchanged.
 */
import { normalizeLoadedBoards, repairLoadedBoards } from '@sp/shared-schema';

export type EntityMap = Record<string, Record<string, unknown>>;

/**
 * Maps AppDataComplete section keys (lowercase, as they appear inside a
 * full-state SYNC_IMPORT/BACKUP_IMPORT payload) to the canonical UPPER_SNAKE
 * entityType that incremental ops use. Almost all are camelCase→UPPER_SNAKE;
 * the two irregulars are `boards`→BOARD and `reminders`→REMINDER (the section
 * key is pluralized). Derived from src/app/op-log/core/entity-registry.ts.
 */
const SECTION_TO_ENTITY_TYPE: Record<string, string> = {
  task: 'TASK',
  project: 'PROJECT',
  tag: 'TAG',
  note: 'NOTE',
  simpleCounter: 'SIMPLE_COUNTER',
  taskRepeatCfg: 'TASK_REPEAT_CFG',
  metric: 'METRIC',
  issueProvider: 'ISSUE_PROVIDER',
  section: 'SECTION',
  globalConfig: 'GLOBAL_CONFIG',
  timeTracking: 'TIME_TRACKING',
  menuTree: 'MENU_TREE',
  planner: 'PLANNER',
  boards: 'BOARD',
  reminders: 'REMINDER',
  pluginUserData: 'PLUGIN_USER_DATA',
  pluginMetadata: 'PLUGIN_METADATA',
  archiveYoung: 'ARCHIVE_YOUNG',
  archiveOld: 'ARCHIVE_OLD',
};

const isUnsafeKey = (key: string): boolean =>
  key === '__proto__' || key === 'constructor' || key === 'prototype';

/**
 * Normalizes a full-state AppDataComplete object into the flat, UPPER_SNAKE
 * representation the rest of the bridge uses. NgRx entity-collection sections
 * ({ ids, entities }) collapse to their `entities` map (so reads are
 * `state.TASK[id]`, identical to how incremental ops build state); singleton
 * sections (globalConfig, boards, planner, menuTree, …) are stored whole.
 */
export const normalizeFullState = (fullState: Record<string, unknown>): EntityMap => {
  const out: EntityMap = {};
  for (const [sectionKey, value] of Object.entries(fullState)) {
    if (isUnsafeKey(sectionKey)) continue;
    const canonical = SECTION_TO_ENTITY_TYPE[sectionKey] ?? sectionKey.toUpperCase();
    if (
      value &&
      typeof value === 'object' &&
      'entities' in (value as Record<string, unknown>) &&
      'ids' in (value as Record<string, unknown>)
    ) {
      out[canonical] = {
        ...(value as { entities: Record<string, unknown> }).entities,
      };
    } else if (canonical === 'BOARD' && value && typeof value === 'object') {
      // Same load repairs a browser applies to boards it reads whole.
      const boards = value as Record<string, unknown>;
      out[canonical] = {
        ...boards,
        boardCfgs: repairLoadedBoards(normalizeLoadedBoards(boards.boardCfgs)),
      };
    } else if (value && typeof value === 'object') {
      out[canonical] = value as Record<string, unknown>;
    }
  }
  return out;
};
