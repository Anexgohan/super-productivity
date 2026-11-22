# AGENTS.md

Guidance for AI agents working in this repository. This is the Anexgohan fork of Super Productivity: a todo and time-tracking web app on Angular, run as a container stack (web, sync server, REST API bridge, Postgres) from `docker/deployment/`. Browsers are the only clients; there is no desktop or mobile build to keep working.

## Our docs

- The fork's own documentation lives in [`documentation/`](documentation/): [`api-reference.md`](documentation/api-reference.md) for the bridge's routes, [`basic-usage-guide.md`](documentation/basic-usage-guide.md) for driving a board over the API.
- A running stack's `GET /api/docs` is the live route map and wins when a document disagrees.
- User-facing changes to the API update `documentation/` in the same change.

## Core commands

**ALWAYS run `npm run checkFile <filepath>` on every `.ts` or `.scss` file you modify** before reporting work as done.

```bash
npm run checkFile <filepath>                 # prettier + lint a single file
npm run prettier                             # multi-file format
npm run lint                                 # multi-file lint
npx tsc --noEmit -p src/tsconfig.app.json    # typecheck the app
npm test --prefix packages/sp-bridge         # bridge tests (vitest)
npm test --prefix packages/shared-schema     # schema tests (vitest)
npm run test:file <filepath>                 # single Angular spec (Karma, needs a browser)
ng serve                                     # web dev (or npm run startFrontend)
```

- The root `tsconfig.json` is solution-style with `files: []`, so `tsc -p tsconfig.json` checks nothing and exits 0; point tsc at `src/tsconfig.app.json`.
- The Angular specs run under Karma, which needs a browser; CI runs them, and a machine without one reports them as typechecked and unrun.
- The stack is built and started with `docker compose` in `docker/deployment/`; `compose.override.yml` builds the images from the working tree.

## Project rules

- **Translations:** UI strings go through `T` / `TranslateService`. Edit only `en.json`; never other locales.
- **Privacy:** no analytics or tracking. User data stays on the user's own stack.
- **Dependencies:** prefer a well-maintained existing package over writing and maintaining our own version of it. Weigh its runtime cost (bundle size, memory), and load page-specific packages lazily so the main bundle doesn't grow.
- **Templates:** plain HTML, minimal CSS/classes, Angular Material sparingly.
- **Styling review:** do not locally restyle Angular Material or shared `src/app/ui/` components for one-off context needs. This includes overriding button styles via `.mat-*`, `.mdc-*`, `button[mat-*]`, or component internals in local SCSS. Prefer existing inputs/classes/tokens; if a variant must exist, make it reusable or add it to the shared style layer.
- **Strict TypeScript:** no `any` (use `unknown` if truly unknown).
- **State:** never mutate NgRx state; return new objects in reducers. Prefer Signals to Observables.
- **Tests:** add unit tests for new services and state logic.
- **Service size cap:** no service may exceed 1200 lines (physical lines, blanks and comments included), lint-enforced via `max-lines` on `**/*.service.ts`; specs are exempt. Split by responsibility before crossing the line. The services grandfathered to warnings in `eslint.config.js` are debt: that list may only shrink.
- **Code review:** weigh the long-term costs a change brings (maintenance burden, hard-to-reverse data shapes, API and sync formats, locked-in dependencies, footguns that only show at scale), not just whether the diff is correct.
- **Task component is a hot path:** every change to `src/app/features/tasks/task/task.component.*` (rendered once per task in long lists) must be checked for performance: no function or getter calls in the template, no extra change detection, no uncleaned subscriptions.

## Sync-correctness rules

**Every change to the sync system is high-risk:** a subtle bug can silently corrupt or lose data across browsers and is hard to recover from. Check each change for replay determinism, concurrent and remote edits, and vector-clock conflicts, and call out the risks before reporting work as done. Rules 1 to 3 and 6 are one invariant: one user intent is one op, and replayed or remote ops must not re-trigger effects.

1. **Effects inject `LOCAL_ACTIONS`**, never `Actions` (`ALL_ACTIONS` only for the op-log capture effect; remote archive side effects go to `ArchiveOperationHandler`). Lint-enforced (`no-actions-in-effects`). See `src/app/util/local-actions.token.ts`.
2. **Prefer action-based effects**; a selector-based effect needs `skipDuringSyncWindow()`. Lint-enforced (`require-hydration-guard`).
3. **Multi-entity change = meta-reducer**, not an effect fan-out (one reducer pass = one op). See `src/app/root-store/meta/task-shared-meta-reducers/`.
4. **Logical clock:** route "what day is this?" through `DateService` (`getLogicalTodayDate`, `isToday`, `todayStr`). Pure reducers and selectors take `startOfNextDayDiffMs` as an argument and call `isTodayWithOffset` for replay determinism; use `getStartOfNextDayDiffMs()` at service boundaries.
5. **`TODAY_TAG` (`'TODAY'`) is virtual:** never add it to `task.tagIds`; membership comes from `task.dueWithTime` or `task.dueDay`. `TODAY_TAG.taskIds` only stores ordering.
6. **Bulk dispatch loop:** `await new Promise(r => setTimeout(r, 0))` after the loop, or 50+ rapid dispatches lose state. See `OperationApplierService.applyOperations()`.
7. **`SYNC_IMPORT` / `BACKUP_IMPORT`** replace state and intentionally drop concurrent ops (CONCURRENT or LESS_THAN by vector clock). See `SyncImportFilterService`.
8. **Vector clocks:** `MAX_VECTOR_CLOCK_SIZE = 20`. The server prunes after conflict detection, before storage.
9. **Logging:** `Log.log({ id: task.id })`, never `Log.log(task)` or `Log.log(title)`; log history is exportable, so never log user content.
10. **Default to not bumping `CURRENT_SCHEMA_VERSION`:** once ops carry a version it can't be reverted. Prefer a payload marker or envelope (`LwwUpdatePayload`) that an open tab on the older version tolerates. See `packages/shared-schema/src/schema-version.ts`.
11. **A sync fix carries a test that fails without it,** and is confirmed to fire on a real op. An unreproduced finding is neither dismissed nor fixed blind.

## Anti-patterns

| Avoid                                                                      | Do instead                                |
| -------------------------------------------------------------------------- | ----------------------------------------- |
| `any` type                                                                 | proper types, `unknown` if truly unknown  |
| Direct DOM access                                                          | Angular bindings, `viewChild()`           |
| Side effects in constructors                                               | `async` pipe or `toSignal`                |
| Subscribing without cleanup                                                | `takeUntilDestroyed()` or async pipe      |
| `NgModules` for new code                                                   | standalone components                     |
| Re-declaring Material theme styles                                         | existing theme variables                  |
| One-off `.mat-*`, `.mdc-*`, `button[mat-*]`, or shared component overrides | reusable inputs, tokens, or shared styles |
