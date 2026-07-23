# Super Productivity, Containerized — How It Works

This is the conceptual guide to our self-hosted, container-only Super Productivity
(SP). It explains what the stack is, how data flows, and the model an agent or
script needs in its head before calling the API. For the endpoint-by-endpoint
contract, see [`api-reference.md`](./api-reference.md).

---

## The one-paragraph version

The desktop app is no longer required, and the MCP server is gone. A small
always-on stack runs SP as a container, owns the data itself, and exposes a
single **REST API** (`sp-bridge`) that does everything the old MCP did — and
more. Browsers that open the web UI are disposable, zero-setup **views**: sign in
with a username and password and everything else — sync, encryption, settings —
is already done for you. Agents talk to the REST API with `curl`; humans use the
browser. Both see the same data.

---

## Why it was built this way

The previous setup had two problems:

1. **Settings lived in the browser tab.** Every browser and every VM needed its
   own manual sync setup. Close the tab or switch machines and you started over.
2. **MCP only worked against the desktop app.** The container had no MCP and no
   API, so automation depended on a desktop instance being open somewhere.

The fix is to make the **container the source of truth** and give it a proper
API, so nothing depends on a browser tab or a desktop app being alive.

Design constraints that shaped it:

- **Always-on, so minimal footprint.** The whole stack is ~200 MB RAM. No
  headless Chromium, no VNC.
- **Container owns the data.** Browsers hold synced replicas, not the master
  copy.
- **Zero-setup browsers.** Open the URL and you're already connected and
  encrypted — no per-browser configuration.
- **Config lives in `.env`,** not hard-coded and not in a tab.

---

## What "the container is the authority" actually means

This is the single design rule the rest of the stack follows, and it is worth
stating precisely because upstream SP does **not** work this way.

Upstream is desktop-first: every install is a peer with an equal claim on the
data, and the sync server is dumb storage. That is the right model for people
running SP on three laptops. It is the wrong model here, and where the two
disagree, the container wins.

Concretely, three things follow.

**The browser is a reader, a viewer and a writer — never an authority.** It
reads the backend, renders what it is given, and writes back. Open the app in
five tabs, or in a private window, or on a machine you have never used before,
and you get the same state. Clearing site data costs you nothing.

**Preferences follow the account, not the browser profile.** Upstream keeps
things like theme, dark mode, sort order, and which lists are collapsed in
`localStorage`, which silently makes them per-profile. Those are mirrored into
the synced config instead, by a single interception point rather than edits
scattered across ~19 services — see
`src/app/core/persistence/synced-ui-prefs.service.ts` for the list and the
reasoning.

Deliberately **not** synced: window and sidebar geometry, panel widths, sidebar
expansion. Those describe the screen in front of you, so pushing a desktop's
sidebar width onto a laptop makes the experience worse, not more consistent.
Caches, debug logs and per-install counters stay local for the same reason.

One caveat: most settings read their stored value once at startup, so a
preference changed on another device applies here on the next reload rather than
instantly. The case that actually hurt — a fresh browser starting from defaults
— is fixed, because the synced values are hydrated during data-init before those
services are constructed. Dark mode is wired to react live.

**Questions with a fixed answer are not asked.** Upstream shows a
_"Server Already Contains Data"_ dialog when a client and the server both hold
data, offering "Replace Server Data" or "Cancel". That prompt makes sense
between equal peers. Here the answer is always the server, so
`ServerMigrationService` consults `ContainerAuthorityService` and takes the
server's data silently instead of putting a one-click path to overwriting
everything in front of a human.

That suppression is not lossy: it runs as the pre-upload step of the normal sync
cycle, so the browser's own local operations still upload and merge. Only the
_"Replace Server Data"_ branch is destructive, and no browser can reach it.

The one case still left to a client: if the server is genuinely **empty** and a
client has data, that client seeds it. That is what recovers the stack if the
sync database is ever wiped.

---

## Signing in

The web app sits behind a username/password gate. This exists because SuperSync
itself has no password auth — only magic links and passkeys, neither of which
suits a LAN-only container — and because the served frontend embeds a sync token
that must not be readable by anyone who can reach the port.

How it fits together:

- **nginx** gates every request with `auth_request` against the bridge's
  `/api/auth/verify`. No valid session, no app — and no embedded token.
- **The login page and session endpoints are proxied under the app's own
  origin**, so the cookie, the login page and the app all share one origin and
  `?next=` stays a plain same-origin path.
- **Passwords** are hashed with scrypt (N=2¹⁷); **sessions** are HS256 JWTs in
  `httpOnly` cookies with the algorithm pinned on verify, renewed on a sliding
  window. Repeated failures lock an address out for 15 minutes.
- **Accounts live in Postgres** — the same database the stack already runs,
  under its own `bridge` schema. One engine, one backup: a `pg_dump` captures
  accounts alongside sync data.

The first visit to `/login` creates the admin account. There is no default
password to forget to change.

**On multi-user:** not implemented, but the shape is there rather than bolted on
later. `users` is a real table with ids and roles (`admin`, `viewer`), not a
single admin blob, and everything downstream already carries a `userId`. Adding
accounts is `INSERT`s; scoping data per user is one more column plus a join.

**What the end user needs:** a username and a password. That is the whole list.
The sync token, the E2E encryption passphrase and the API key are admin
concerns, set once in `.env` and never typed by a person signing in.

---

## The pieces

```
                         ┌──────────────────────────────────────────┐
                         │            container stack (.env)         │
                         │                                           │
  browser (view) ─┐      │   ┌──────────┐      ┌───────────────┐     │
  browser (view) ─┼──────┼──▶│   web    │      │   postgres    │     │
  browser (view) ─┘      │   │ (nginx)  │      └───────▲───────┘     │
                         │   └────┬─────┘              │             │
                         │        │             ┌──────┴───────┐     │
   agent / curl ─────────┼───────────────┐      │  SuperSync   │     │
                         │        │       │      │   server     │     │
                         │        ▼       ▼      └──────▲───────┘     │
                         │   ┌─────────────────────┐    │            │
                         │   │      sp-bridge       │───▶│ (op-log)   │
                         │   │  headless sync peer  │◀───┘            │
                         │   │   + REST API         │                 │
                         │   └─────────────────────┘                 │
                         └──────────────────────────────────────────┘
```

- **web** — the standard SP frontend (patched build), served over HTTP on the
  LAN. This is what a browser opens. nginx gates it behind a login and, once you
  have a session, it auto-connects to sync on first load.
- **SuperSync server** — SP's own operation-based sync server (self-hosted,
  PostgreSQL-backed, E2E-encrypted). It is the hub every client syncs through.
  _Self-hosted; no subscription._
- **postgres** — stores the encrypted operation log, plus (in its own `bridge`
  schema) local accounts and the durable secrets described below.
- **sp-bridge** — a headless Node process that joins sync **as a peer**, holds
  the encryption passphrase, replays the op-log into live state, and exposes the
  **REST API**. This is the component that replaced MCP. It also owns login: it
  serves the login page and the session endpoints that nginx checks against.

---

## How data flows (the op-log model)

SP does not sync "the current state." It syncs **operations** — a running log of
small changes (create task, update task, delete tag, …). Every client, including
`sp-bridge`, does the same two things:

1. **Downloads** new operations from the SuperSync server and applies them to its
   own local copy of the state.
2. **Uploads** operations for the changes it makes, which every other client then
   downloads and applies.

A few consequences worth knowing:

- **Writes are operations, not overwrites.** When you `POST` a new task through
  the API, `sp-bridge` builds an operation shaped exactly like the one a real
  client would produce, uploads it, then re-pulls so the value you read back is
  what _every_ client will converge on.
- **The API response reflects post-sync state.** Because a write round-trips
  through the server before returning, what you get back is the settled result,
  not an optimistic guess.
- **Reads are usually live.** `sp-bridge` holds a websocket to the sync server
  and pulls as soon as new operations land; `GET /api/status` reports `isLive`.
  Polling stays on underneath as a fallback so a silently dead socket degrades
  to "slightly stale" rather than "permanently stale". If you need a guarantee,
  `POST /api/sync/refresh` pulls synchronously.
- **Encryption is end-to-end.** Operations are encrypted with your passphrase
  before they leave a client. The SuperSync server and postgres only ever see
  ciphertext. `sp-bridge` can read the data because it holds the passphrase; the
  server cannot.

---

## The data model an API caller needs

### Tasks

The core entity. A task has a `title`, an `isDone` flag, an optional
`projectId`, a `tagIds` array, time fields (`timeEstimate`, `timeSpent`,
`timeSpentOnDay`), scheduling fields (`dueDay`, `dueWithTime`), and — if it is a
subtask — a `parentId`. Parent tasks list their children in `subTaskIds`.

### Projects

A container for tasks. Every task belongs to exactly one project (the default is
`INBOX_PROJECT`, titled "Inbox", which cannot be deleted). Deleting a project
deletes its tasks with it.

### Tags

Cross-cutting labels with a `title`, `color`, and `icon`. A task can carry many
tags. Tags are how several features are actually implemented — read on.

### Boards (Kanban) are tag-driven

This is the single most important non-obvious fact. A Kanban board column is not
a container you move a task _into_. Each column has an `includedTagIds` list, and
a task appears in that column because it **carries that tag**. So "move this task
to the In Progress column" means **add the `KANBAN_IN_PROGRESS` tag** (and
usually remove the previous column's tag). You do board moves through the tag
endpoints, not a dedicated board endpoint.

### The Today list

"Planned for today" is membership in a special virtual tag, `TODAY`. A task is on
today's list if its id is in `TAG['TODAY'].taskIds`. You add/remove membership
with the `today` endpoints, and filter for it with `?plannedForToday=true`.
Scheduling a task for a **future** day (`dueDay`) is separate and shows up on the
Planner.

### What has no equivalent on a headless peer

Some desktop concepts don't exist for an always-on API server, and the API says
so honestly rather than faking them:

- **Current task / running timer** — which task is "active" is device-local UI
  state that never syncs. `GET /api/current-task` always returns `null`.
- **Notifications, start/stop timer** — these are desktop UI actions with no
  server-side meaning.
- **Connection / directory diagnostics** — the MCP transport is gone;
  `GET /api/health` and `GET /api/status` replace those checks.

---

## Talking to the API

- **Base URL:** `http://<host>:<SP_BRIDGE_PORT>` (default port `18232`).
- **Auth:** every route except `/api/health` and `/api/docs` needs an API key,
  sent as either header:
  - `Authorization: Bearer <key>`
  - `X-Api-Key: <key>`
- **Self-describing:** `GET /api/docs` returns a live map of every route and its
  parameters, so an agent can discover the surface without this file.

The key is only ever compared as a SHA-256 digest, in constant time — a plain
string compare short-circuits on the first differing byte and on a length
mismatch, leaking both. Set `SP_BRIDGE_API_KEY` to choose the value yourself, or
leave it unset and the bridge mints an `spb_`-prefixed key on first boot,
storing **only the hash** and printing the key once in the startup log. A minted
key is unrecoverable by design; if it is lost, set `SP_BRIDGE_API_KEY` to take
over.

A browser session cookie also authenticates these routes, which is what lets the
web app call the bridge without a key.

```bash
# liveness (no auth)
curl http://192.168.100.237:18232/api/health

# everything else needs the key
curl -H "X-Api-Key: $SP_BRIDGE_API_KEY" \
     http://192.168.100.237:18232/api/tasks?isDone=false
```

Configuration lives in `docker/deployment/.env`:

| Variable                      | Purpose                                                      |
| ----------------------------- | ------------------------------------------------------------ |
| `SP_BRIDGE_PORT`              | REST port (default `18232`)                                  |
| `SP_BRIDGE_API_KEY`           | API key callers must present; unset = mint one on first boot |
| `SP_BRIDGE_POLL_INTERVAL_SEC` | websocket-fallback poll interval (default 15)                |
| `SP_AUTH_ENABLED`             | browser login gate (default on; `false` serves the app open) |
| `SP_AUTH_SESSION_TTL_H`       | session lifetime in hours, sliding (default 720)             |
| `SP_SYNC_ENCRYPTION_PASSWORD` | E2E passphrase — admin-set, never typed by a user            |

---

## Operational notes

**The sync token is stable across restarts, on purpose.** SuperSync derives the
localStorage key it tracks its sync cursor under from
`hash(baseUrl | accessToken)`. That is sound upstream — it separates two users
sharing one server — but it assumes the token is a stable identity. The web
entrypoint therefore asks `sp-bridge` for the token rather than minting one, and
the bridge persists it in Postgres.

Minting per boot instead means every restart hands browsers a new token, which
changes the hash, resets every client's cursor to zero, and makes each one
conclude it has never met this server before. Renewal only happens within 30
days of the token's expiry — an annual event, not a per-restart one.

**Editing deployment config does not rebuild the frontend.** `nginx/`,
`docker-entrypoint.sh`, `docker/` and `documentation/` are excluded from the
build stage's `COPY`, so they are not part of its cache key. Without that,
changing one line of an nginx directive forced a full ~10-minute Angular
rebuild. (This needs BuildKit's labs Dockerfile syntax, declared at the top of
the `Dockerfile`.)

**`docker compose restart` does not honour `depends_on` ordering** the way `up`
does — it starts every container at once. `sp-bridge` retries its initial
connection for up to 30s rather than exiting, so a whole-stack restart settles
on its own instead of crash-looping until the sync server is ready.

---

## Publishing images (GHCR) and deploying elsewhere

The dev box builds from source. A real deployment target should not have to —
it should pull finished images. That is what
`.github/workflows/publish-containers.yml` is for.

**Three images, published multi-arch to GHCR:**

| Image                            | From                                    |
| -------------------------------- | --------------------------------------- |
| `ghcr.io/anexgohan/sp-web`       | root `Dockerfile` (the Angular app)     |
| `ghcr.io/anexgohan/sp-bridge`    | `packages/sp-bridge/Dockerfile`         |
| `ghcr.io/anexgohan/sp-supersync` | `packages/super-sync-server/Dockerfile` |

We publish our **own** supersync rather than reusing upstream's image because
this fork patches it (`ALLOW_INSECURE_HTTP`, container auto-provisioning, the
plain-HTTP `server.ts` fix) — upstream's build has none of those.

**Publishing is release-driven, not per-commit.** Push a version tag and all
three images build and publish at that version:

```bash
git tag v0.1.0
git push origin v0.1.0     # ← triggers the workflow
```

| You push        | Images are tagged                        |
| --------------- | ---------------------------------------- |
| `v1.2.3`        | `1.2.3`, `1.2`, `latest`, `sha-<short>`  |
| `v1.2.3-beta`   | `1.2.3-beta`, `sha-<short>` (not latest) |
| manual dispatch | the version you enter, or `sha-<short>`  |

A `-beta`/`-rc` suffix keeps a build off `latest` automatically, so `latest`
only ever moves to a stable release.

**Two design choices worth knowing:**

- **Each architecture builds on its own native runner** (`ubuntu-24.04` for
  amd64, `ubuntu-24.04-arm` for arm64) rather than emulating arm64 under QEMU.
  The web image runs a full Angular build; emulated, that would go from ~10 min
  to 40+. The two per-arch builds are then stitched into one multi-arch tag by
  **digest**, so no `-amd64`/`-arm64` tags litter the package list.
- **Images carry no secrets.** The sync token and E2E passphrase are injected at
  runtime by the entrypoint, never baked at build. That is what makes publishing
  them publicly safe — a pulled image is inert until an operator supplies `.env`.

**Deploying on another host** then needs no source tree and no build toolchain —
only `compose.yml` pointed at the published images, an `.env`, and empty `data/`
directories:

```bash
docker compose pull
docker compose up -d
```

One first-time step: GHCR creates packages **private** by default, so after the
first publish each of the three must be flipped to public once (package settings,
or `gh` API). Until then a puller needs a GitHub token with `read:packages`.

---

## Mental model in six bullets

- The **container owns the data**; browsers are throwaway views; agents use REST.
- Data is an **encrypted op-log**; every change is an operation, replayed by all
  clients (the server never sees plaintext).
- **Board columns and the Today list are tags** — move tasks by changing tags,
  not by calling a board or list API.
- **Writes round-trip and settle** before the API returns; **reads** are live
  over a websocket, with `POST /api/sync/refresh` as the guarantee.
- **Settings follow the account, geometry follows the screen** — and a browser
  is never asked to arbitrate against the server.
- Things that are inherently device-local (current task, notifications, timers)
  are **reported as absent**, not simulated.
