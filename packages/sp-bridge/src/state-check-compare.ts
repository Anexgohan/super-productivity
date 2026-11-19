/**
 * Compares the bridge's materialized state with the app rules' (anex/state-check).
 *
 * The app rules are the app's own reducers and archive code, so wherever the two differ, the app rules show what a browser would.
 * Each difference is sorted into a class: the gaps already known from the spike, or `new`, which is what the state check exists to find.
 * Pure functions over plain state, so all of this is tested without Angular or a worker.
 * Output holds section names, ids and field names only, never values: the log must not carry card content.
 */
import { BOARD_TAG_IDS } from '@sp/shared-schema';
import type { EntityMap } from './materializer';

export type DifferenceClass =
  /** The app strips the In Progress tag when a task is marked done; the bridge does not. */
  | 'in-progress-on-done'
  /** The app fills in `doneOn` on completion; the bridge does not. */
  | 'done-on'
  /** The app keeps tag task lists in step with task tags; the bridge does not. */
  | 'tag-task-lists'
  | 'menu-tree'
  /** The app merges settings field by field; the bridge replaces whole sections. */
  | 'settings'
  /** The bridge ignores archive actions, so archived tasks stay live there. */
  | 'archive'
  /** Touched by an op a browser would have dropped because a full import superseded it; the bridge applies those. */
  | 'import-filter'
  | 'new';

export type DifferenceKind = 'only-in-bridge' | 'only-in-app-rules' | 'differs';

export interface Difference {
  key: string;
  section: string;
  id?: string;
  field?: string;
  kind: DifferenceKind;
  cls: DifferenceClass;
}

export interface CompareContext {
  /** Entity ids touched by ops the app rules dropped as superseded by a full import. */
  filteredEntityIds: ReadonlySet<string>;
  /** The app rules have processed an archive action, so time tracking may have moved into the archive. */
  sawArchiveOp: boolean;
}

/** Sections that are id-keyed entity maps after normalization; every other section is a singleton record. */
const ENTITY_SECTIONS = new Set([
  'TASK',
  'PROJECT',
  'TAG',
  'NOTE',
  'SIMPLE_COUNTER',
  'TASK_REPEAT_CFG',
  'METRIC',
  'ISSUE_PROVIDER',
  'SECTION',
  'REMINDER',
]);

const ARCHIVE_SECTIONS = new Set(['ARCHIVE_YOUNG', 'ARCHIVE_OLD']);

/** Reducers stamp `modified` from the device clock, so it never matches across the two and says nothing about correctness. */
const IGNORED_ENTITY_FIELDS = new Set(['modified']);

/** Id lists that legitimately lose entries when a task is archived. */
const TASK_ID_LIST_FIELDS = new Set(['taskIds', 'backlogTaskIds', 'subTaskIds']);

const asRecord = (v: unknown): Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v)
    ? (v as Record<string, unknown>)
    : {};

/** JSON equality: key order does not matter, and an `undefined` property equals an absent one. */
export const sameValue = (a: unknown, b: unknown): boolean => {
  if (a === b) return true;
  if (a === null || b === null || typeof a !== 'object' || typeof b !== 'object') {
    return false;
  }
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  if (Array.isArray(a)) {
    const bArr = b as unknown[];
    return a.length === bArr.length && a.every((v, i) => sameValue(v, bArr[i]));
  }
  const ao = a as Record<string, unknown>;
  const bo = b as Record<string, unknown>;
  const keys = new Set([...Object.keys(ao), ...Object.keys(bo)]);
  for (const k of keys) {
    if (!sameValue(ao[k], bo[k])) return false;
  }
  return true;
};

const archivedTaskIds = (state: EntityMap): Set<string> => {
  const ids = new Set<string>();
  for (const section of ARCHIVE_SECTIONS) {
    for (const id of Object.keys(
      asRecord(asRecord(asRecord(state[section]).task).entities),
    )) {
      ids.add(id);
    }
  }
  return ids;
};

const symmetricDifference = (a: unknown, b: unknown): string[] => {
  const as = new Set(Array.isArray(a) ? a.map(String) : []);
  const bs = new Set(Array.isArray(b) ? b.map(String) : []);
  return [...[...as].filter((x) => !bs.has(x)), ...[...bs].filter((x) => !as.has(x))];
};

const make = (
  section: string,
  kind: DifferenceKind,
  cls: DifferenceClass,
  id?: string,
  field?: string,
): Difference => ({
  key: `${section}|${id ?? ''}|${field ?? ''}|${kind}`,
  section,
  ...(id !== undefined ? { id } : {}),
  ...(field !== undefined ? { field } : {}),
  kind,
  cls,
});

const singletonClass = (section: string, ctx: CompareContext): DifferenceClass => {
  if (ARCHIVE_SECTIONS.has(section)) return 'archive';
  if (section === 'MENU_TREE') return 'menu-tree';
  if (section === 'GLOBAL_CONFIG') return 'settings';
  if (section === 'TIME_TRACKING' && ctx.sawArchiveOp) return 'archive';
  return 'new';
};

/**
 * Every difference between the two states.
 *
 * `bridge` is the materializer's state; `appRules` is the app rules' snapshot after the bridge's own full-state normalization,
 * so both sides have the same shape and any difference is a difference in what the two did with the same ops.
 */
export const compareStates = (
  bridge: EntityMap,
  appRules: EntityMap,
  ctx: CompareContext,
): Difference[] => {
  const out: Difference[] = [];
  const appRulesArchived = archivedTaskIds(appRules);
  const bridgeArchived = archivedTaskIds(bridge);
  const appRulesTasks = asRecord(appRules.TASK);

  // A task archived or deleted by the app rules explains every id list that lost it.
  const goneFromAppRules = (id: string): boolean =>
    appRulesArchived.has(id) || !(id in appRulesTasks);

  for (const section of [
    ...new Set([...Object.keys(bridge), ...Object.keys(appRules)]),
  ].sort()) {
    const b = bridge[section];
    const e = appRules[section];
    if (b === undefined || e === undefined) {
      if (b === undefined && e === undefined) continue;
      const kind = b === undefined ? 'only-in-app-rules' : 'only-in-bridge';
      out.push(make(section, kind, ARCHIVE_SECTIONS.has(section) ? 'archive' : 'new'));
      continue;
    }

    if (!ENTITY_SECTIONS.has(section)) {
      const br = asRecord(b);
      const er = asRecord(e);
      for (const field of [...new Set([...Object.keys(br), ...Object.keys(er)])].sort()) {
        if (!sameValue(br[field], er[field])) {
          // Settings ops carry their section key as entity id, so a dropped one is attributable field by field.
          const cls = ctx.filteredEntityIds.has(field)
            ? 'import-filter'
            : singletonClass(section, ctx);
          out.push(make(section, 'differs', cls, undefined, field));
        }
      }
      continue;
    }

    const ids = [...new Set([...Object.keys(b), ...Object.keys(e)])].sort();
    for (const id of ids) {
      const be = b[id];
      const ee = e[id];
      if (be === undefined || ee === undefined) {
        const kind = be === undefined ? 'only-in-app-rules' : 'only-in-bridge';
        let cls: DifferenceClass = 'new';
        if (ctx.filteredEntityIds.has(id)) cls = 'import-filter';
        else if (
          section === 'TASK' &&
          (appRulesArchived.has(id) || bridgeArchived.has(id))
        ) {
          cls = 'archive';
        }
        out.push(make(section, kind, cls, id));
        continue;
      }
      const br = asRecord(be);
      const er = asRecord(ee);
      for (const field of [...new Set([...Object.keys(br), ...Object.keys(er)])].sort()) {
        if (IGNORED_ENTITY_FIELDS.has(field) || sameValue(br[field], er[field])) continue;
        out.push(
          make(
            section,
            'differs',
            classifyField(section, id, field, br, er, ctx, goneFromAppRules),
            id,
            field,
          ),
        );
      }
    }
  }
  return out;
};

const classifyField = (
  section: string,
  id: string,
  field: string,
  bridgeEntity: Record<string, unknown>,
  appRulesEntity: Record<string, unknown>,
  ctx: CompareContext,
  goneFromAppRules: (taskId: string) => boolean,
): DifferenceClass => {
  if (ctx.filteredEntityIds.has(id)) return 'import-filter';

  if (section === 'TASK' && field === 'tagIds') {
    const diff = symmetricDifference(bridgeEntity.tagIds, appRulesEntity.tagIds);
    if (
      diff.length === 1 &&
      diff[0] === BOARD_TAG_IDS.inProgress &&
      appRulesEntity.isDone === true
    ) {
      return 'in-progress-on-done';
    }
    return 'new';
  }
  if (section === 'TASK' && field === 'doneOn') return 'done-on';

  if (TASK_ID_LIST_FIELDS.has(field)) {
    const diff = symmetricDifference(bridgeEntity[field], appRulesEntity[field]);
    if (diff.length > 0 && diff.every(goneFromAppRules)) return 'archive';
    if (section === 'TAG' && field === 'taskIds') return 'tag-task-lists';
  }
  return 'new';
};

export type ClassCounts = Partial<Record<DifferenceClass, number>>;

export const countByClass = (list: readonly Difference[]): ClassCounts => {
  const counts: ClassCounts = {};
  for (const d of list) counts[d.cls] = (counts[d.cls] ?? 0) + 1;
  return counts;
};

/**
 * Remembers the last comparison, so the log reports changes rather than repeating every standing difference on each refresh.
 */
export class DifferenceTracker {
  private _current = new Map<string, Difference>();

  update(list: readonly Difference[]): {
    appeared: Difference[];
    resolved: Difference[];
  } {
    const next = new Map(list.map((d) => [d.key, d]));
    const appeared = list.filter((d) => !this._current.has(d.key));
    const resolved = [...this._current.values()].filter((d) => !next.has(d.key));
    this._current = next;
    return { appeared, resolved };
  }

  get current(): Difference[] {
    return [...this._current.values()];
  }
}

/** One log line per difference: section, id, field and class, never a value. */
export const describe = (d: Difference): string =>
  `${d.cls}: ${d.section}${d.id !== undefined ? ` ${d.id}` : ''}${d.field !== undefined ? `.${d.field}` : ''} (${d.kind})`;
