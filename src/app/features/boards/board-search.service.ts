import { computed, inject, Injectable, signal } from '@angular/core';
import { Store } from '@ngrx/store';
import { Subject } from 'rxjs';
import { toSignal } from '@angular/core/rxjs-interop';
import type Fuse from 'fuse.js';
import { selectAllTasksInActiveProjects } from '../tasks/store/task.selectors';
import { Log } from '../../core/log';

interface TitleEntry {
  id: string;
  title: string;
}

type FuseCtor = typeof Fuse;

const isSameEntries = (a: TitleEntry[], b: TitleEntry[]): boolean =>
  a.length === b.length && a.every((e, i) => e.id === b[i].id && e.title === b[i].title);

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
        })
      : null;
  });

  /** Ids of the cards whose title matches, or null when every card shows. */
  readonly matchingIds = computed<Set<string> | null>(() => {
    const query = this.query().trim();
    const index = this._index();
    // Until Fuse has loaded every card stays, rather than the board going blank for a moment.
    if (!query || !index) {
      return null;
    }
    return new Set(index.search(query).map((r) => r.item.id));
  });

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
