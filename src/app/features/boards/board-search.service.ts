import { computed, inject, Injectable, signal } from '@angular/core';
import { Store } from '@ngrx/store';
import { Subject } from 'rxjs';
import { toSignal } from '@angular/core/rxjs-interop';
import type Fuse from 'fuse.js';
import { selectAllTasksInActiveProjects } from '../tasks/store/task.selectors';
import { Log } from '../../core/log';
import { buildTitleSegments, TitleSegment } from './boards.util';

interface TitleEntry {
  id: string;
  title: string;
}

interface FilterResult {
  ids: Set<string>;
  /** Fuse's score per matching card, from 0 for an exact match up to 1. */
  scores: Map<string, number>;
  segments: Record<string, TitleSegment[]>;
}

type FuseCtor = typeof Fuse;

const NO_SEGMENTS: Record<string, TitleSegment[]> = {};

const isSameEntries = (a: TitleEntry[], b: TitleEntry[]): boolean =>
  a.length === b.length && a.every((e, i) => e.id === b[i].id && e.title === b[i].title);

/** True for the Boards page, whatever its query string or hash. */
export const isBoardsUrl = (url: string | undefined): boolean =>
  (url ?? '').split(/[?#]/)[0] === '/boards';

/** The Boards page's title filter: in memory only, never stored or synced. */
@Injectable({ providedIn: 'root' })
export class BoardSearchService {
  private _store = inject(Store);
  private _fuseCtor = signal<FuseCtor | null>(null);
  private _fuseLoad?: Promise<void>;

  readonly query = signal('');
  readonly isFiltering = computed(() => this.query().trim().length > 0);
  /** Fires when the search shortcut is pressed on the Boards page. */
  readonly focusRequests$ = new Subject<void>();

  private _tasks = toSignal(this._store.select(selectAllTasksInActiveProjects), {
    initialValue: [],
  });

  // Only titles count, so time tracking and other edits don't rebuild the index.
  private _entries = computed(
    () => this._tasks().map((t) => ({ id: t.id, title: t.title })),
    { equal: isSameEntries },
  );

  private _index = computed(() => {
    const FuseClass = this._fuseCtor();
    return FuseClass
      ? new FuseClass(this._entries(), {
          keys: ['title'],
          ignoreLocation: true,
          threshold: 0.4,
          includeMatches: true,
          includeScore: true,
        })
      : null;
  });

  private _result = computed<FilterResult | null>(() => {
    const query = this.query().trim();
    const index = this._index();
    // Until Fuse has loaded every card stays, rather than the board going blank for a moment.
    if (!query || !index) {
      return null;
    }
    // Lone matched letters read as noise, so they are marked only for a one-letter query.
    const minRun = Math.min(2, query.length);
    const ids = new Set<string>();
    const scores = new Map<string, number>();
    const segments: Record<string, TitleSegment[]> = {};
    for (const r of index.search(query)) {
      ids.add(r.item.id);
      scores.set(r.item.id, r.score ?? 1);
      const ranges = (r.matches ?? [])
        .flatMap((m) => m.indices)
        .filter(([start, end]) => end - start + 1 >= minRun);
      segments[r.item.id] = buildTitleSegments(r.item.title, ranges);
    }
    return { ids, scores, segments };
  });

  /** Ids of the cards whose title matches, or null when every card shows. */
  readonly matchingIds = computed(() => this._result()?.ids ?? null);

  /** Each matching card's score, lower is better, or null when every card shows. */
  readonly matchScores = computed(() => this._result()?.scores ?? null);

  /** Each matching card's title as plain and matched runs; empty when there is no filter. */
  readonly titleSegments = computed(() => this._result()?.segments ?? NO_SEGMENTS);

  /** Resolves once Fuse has loaded, which is only waited on in tests. */
  setQuery(query: string): Promise<void> {
    this.query.set(query);
    return query.trim() ? this._loadFuse() : Promise.resolve();
  }

  private _loadFuse(): Promise<void> {
    // A failed load is forgotten, so the next keystroke tries again.
    this._fuseLoad ??= import('fuse.js')
      .then((m) => this._fuseCtor.set(m.default))
      .catch((e) => {
        this._fuseLoad = undefined;
        Log.err(e);
      });
    return this._fuseLoad;
  }
}
