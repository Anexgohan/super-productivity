# Removed: upstream's containerized E2E

Removed on 2026-07-24 from `anex/container-parity`. This is the record of what
went and why, so the decision is legible later instead of looking like drift.

Nothing here is lost — every file is in git history. See [Restoring](#restoring).

## What was removed

| Group          | Count | Detail                                                                                                                                                                                      |
| -------------- | ----- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Docker/compose | 11    | `docker-compose.{yaml,e2e,e2e.fast,supersync}.yaml`, `Dockerfile.e2e.dev{,.fast}`, `webdav.yaml`, and the supersync package's `Dockerfile.test` + `docker-compose{,.build,.monitoring}.yml` |
| Shell helpers  | 3     | `scripts/wait-for-{app,supersync,webdav}.sh` (the `scripts/` directory is now gone)                                                                                                         |
| Spec files     | 91    | everything tagged `@supersync` (73) or `@webdav` (18)                                                                                                                                       |
| E2E helpers    | 9     | fixtures, pages and utils used only by those specs                                                                                                                                          |
| npm scripts    | 9     | `e2e:docker*`, `e2e:supersync*`, `e2e:webdav*`, `supersync:up`/`:down`                                                                                                                      |

Kept: the ~113 plain specs (279 tests), which still run in CI, and our own
three Dockerfiles plus `docker/deployment/`.

## Why

**They could never run here.** CI invokes `npm run e2e:ci`, which resolves to
`--grep-invert "@supersync|@webdav"` — so the 91 were already excluded from
every CI run. Running them locally needs Playwright's Chromium (~200 MB into
`~/.cache`) plus Docker backends, and installing browsers on the dev container
is ruled out. Code that cannot run is worse than absent: it reads as coverage
that does not exist.

**They test behaviour this fork deliberately changed.** `supersync-server-migration-abort.spec.ts`
asserts the _"Server Already Contains Data"_ dialog appears — which we suppress
on purpose under container authority. `supersync-token-expiry.spec.ts` assumes
a rotating token, where we now persist one. A meaningful share of the 73 were
asserting the opposite of our design, so "fixing" them meant rewriting upstream's
tests to match a fork they were never written for.

**The deployment files were genuinely superseded.** `docker-compose.yaml` was
upstream's self-host stack; `docker/deployment/compose.yml` replaces it.

## What this costs

There is no automated regression test for sync semantics — op-log ordering,
vector clocks, multi-client convergence, cascade deletes. That gap is real and
worth remembering before the multi-user work, which touches exactly those paths.

The option not taken: run the containerized suite **in CI**, where GitHub's
runners already provide both Chromium and Docker at no local cost. That would
mean dropping the `--grep-invert` and adding a job to bring up the compose
stack. It was judged not worth it given how far the tests have diverged from
this fork, but it remains the only honest way to get that coverage back.

## Collateral fixes

Removing the specs broke three things that the _kept_ tests depend on, all
fixed in the same change:

- `e2e/fixtures/test.fixture.ts` exposed a `syncPage` fixture from a deleted
  page object. Removed — no remaining spec used it. `tagPage` was **restored**,
  because 3 kept specs still use it through the fixture.
- `e2e/global-setup.ts` imported `isServerHealthy` and gated on a SuperSync
  server that can no longer exist. Removed.
- `packages/super-sync-server/tests/migration-sql.spec.ts` had one test,
  _"runs migrations before replacing the app during compose deploys"_, reading
  upstream's `deploy.sh`, compose files, helm chart and a `supersync-docker.yml`
  workflow that yesterday's workflow purge had already deleted. It asserts on
  upstream deploy tooling this fork does not use. Removed; the other 11 tests in
  that file pass.

`e2e/pages/index.ts` also exported the deleted `SyncPage`, and `e2e/CLAUDE.md`
documented how to run the removed suite. Both updated.

## Verified after removal

- `packages/super-sync-server`: **900 tests in 44 files pass**
- `npx playwright test --list`: **279 tests in 113 files load**, so every
  remaining import resolves
- no dangling references to any removed file outside `docs/` (see below)

## Known stale references, deliberately left

Upstream documentation still mentions the removed files. These are upstream's
own docs about upstream's deployment story, not instructions for this fork, so
they were left rather than rewritten:

- `docs/wiki/2.13-Run-with-Docker.md` — references `docker-compose.yaml` and `webdav.yaml`
- `docs/long-term-plans/supersync-encryption-at-rest.md` — references `docker-compose.yaml` service names
- `packages/super-sync-server/scripts/deploy.sh` — optional `-f docker-compose.{monitoring,build}.yml` flags, now inert
- `packages/super-sync-server/tests/integration/conflict-detection-sql.integration.spec.ts` — a comment pointing at `docker-compose.yaml`

## Restoring

```bash
# find the commit that removed them
git log --diff-filter=D --oneline -- 'e2e/tests/sync/*'

# read a single file as it was
git show <sha>^:e2e/tests/sync/supersync-multi-tab.spec.ts

# restore everything from the parent of the removal commit
git checkout <sha>^ -- e2e/tests/sync/ docker-compose.yaml docker-compose.supersync.yaml
```

Restoring the specs alone is not enough — they need the deleted fixtures, pages
and utils, the compose files, and the `wait-for-*.sh` scripts, all from the same
commit. The npm scripts would have to come back too.
