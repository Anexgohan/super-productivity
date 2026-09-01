# Super Productivity, Containerized - How It Works

This is the conceptual guide to our self-hosted, container-only Super Productivity
(SP). It explains what the stack is, how data flows, and the model an agent or
script needs in its head before calling the API. For the endpoint-by-endpoint
contract, see [`api-reference.md`](./api-reference.md).

---

## The one-paragraph version

The desktop app is no longer required, and the MCP server is gone. A small
always-on stack runs SP as a container, owns the data itself, and exposes a
single **REST API** (`sp-bridge`) that does everything the old MCP did - and
more. Browsers that open the web UI are disposable, zero-setup **views**: sign in
with a username and password and everything else - sync, encryption, settings -
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
  encrypted - no per-browser configuration.
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

**The browser is a cache with provenance, not a peer.** This is the part worth
being precise about, because the obvious reading is wrong in both directions.

The browser does **not** render from the backend. It holds a complete replica of
your data in IndexedDB (`SUP_OPS`) and renders from that - which is what makes
the UI instant and what makes offline work at all. Wiping the server does not
empty a browser, and for a long time in this fork a stale tab could repopulate a
freshly wiped stack from its own copy.

What it does not have is **standing**. The replica is stamped with the stack that
served it and the account that was signed in (`instanceId`, `userId`). At
startup, before anything is read, `ReplicaIdentityGateService` compares that
stamp against the signed-in session and destroys the replica if it belongs to
someone else - a different account on a shared machine, or a stack whose
database has since been wiped. Signing out purges it outright.

So: open the app in five tabs, in a private window, or on a machine you have
never used before, and you get the same state. Clearing site data costs you
nothing you have already synced. But the copy on disk is real, and it is yours
only for as long as you are the one signed in.

> **Not true yet.** "Never an authority" is still an overstatement, and this doc
> used to make it flatly. Container authority settles _whole-state divergence_ -
> when client and server disagree about the world, the server wins. Concurrent
> edits still merge at the op level through vector clocks and last-write-wins, so
> an offline tab can still win an individual field against the container. Closing
> that would mean giving up offline editing, which is not a trade this stack has
> chosen to make.

**Preferences follow the account, not the browser profile.** Upstream keeps
things like theme, dark mode, sort order, and which lists are collapsed in
`localStorage`, which silently makes them per-profile. Those are mirrored into
the synced config instead, by a single interception point rather than edits
scattered across ~19 services - see
`src/app/core/persistence/synced-ui-prefs.service.ts` for the list and the
reasoning.

Deliberately **not** synced: window and sidebar geometry, panel widths, sidebar
expansion. Those describe the screen in front of you, so pushing a desktop's
sidebar width onto a laptop makes the experience worse, not more consistent.
Caches, debug logs and per-install counters stay local for the same reason.

One caveat: most settings read their stored value once, at construction, so a
preference changed on another device applies here on the next reload rather than
instantly. Dark mode is wired to react live.

The case that actually hurt - a fresh browser rendering defaults - is handled by
`StartupService.init()`, which waits for data-init and then calls
`SyncedUiPrefsService.hydrateNow()` **before** the theme is applied, so the
account's values are already in `localStorage` when those constructors run.

One preference could not be fixed by ordering alone. `focusMode`'s reducer is
registered eagerly and reads `localStorage` at **module scope**, so its initial
state is fixed on import - before any service exists. Startup therefore corrects
the store explicitly, dispatching `setFocusModeMode` with
`readPersistedFocusModeMode()` once the values are in place.

> **Not true yet.** `HIDDEN_CALENDAR_PROVIDER_IDS` is listed in `SYNCED_KEYS`
> but has no reader anywhere in the app. It is either dead weight or consumed
> by some path that does not go through `LS`, and nobody has checked which.

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
itself has no password auth - only magic links and passkeys, neither of which
suits a LAN-only container - and because the served frontend embeds a sync token
that must not be readable by anyone who can reach the port.

How it fits together:

- **nginx** gates every request with `auth_request` against the bridge's
  `/api/auth/verify`. No valid session, no app - and no embedded token.
- **The login page and session endpoints are proxied under the app's own
  origin**, so the cookie, the login page and the app all share one origin and
  `?next=` stays a plain same-origin path.
- **Passwords** are hashed with scrypt (N=2¹⁷); **sessions** are HS256 JWTs in
  `httpOnly` cookies with the algorithm pinned on verify, renewed on a sliding
  window. Repeated failures lock an address out for 15 minutes.
- **Accounts live in Postgres** - the same database the stack already runs,
  under its own `bridge` schema. One engine, one backup: a `pg_dump` captures
  accounts alongside sync data.

The first visit to `/login` creates the admin account. There is no default
password to forget to change.

**What the end user needs:** a username and a password. That is the whole list.
The sync token, the E2E encryption passphrase and the API key are admin
concerns, set once in `.env` and never typed by a person signing in.

---

## Accounts, roles and per-user boards

Every account owns its own board. Three roles:

| Role       | Own board | Other users' boards              | User management |
| ---------- | --------- | -------------------------------- | --------------- |
| `admin`    | full      | **no access**                    | full            |
| `operator` | full      | no access                        | none            |
| `viewer`   | none      | read-only, published boards only | none            |

The admin manages _accounts_, not _data_ - an operational role, not a
surveillance one. That limit is a design choice, not a cryptographic guarantee;
see the encryption note below.

Concretely, no route hands an admin another user's board: `boardFor()` in `rest.ts` resolves the request to the principal's own board and has no override. What an admin does have is the ability to read anyone's API key, and a key acts as its owner. So the honest statement is that an admin cannot read another board directly but can always obtain the means to, which is unavoidable anyway because they hold `JWT_SECRET` and every key is derived from it.

### Isolation comes from the sync server, which was already multi-tenant

No schema change was needed there: `Operation.userId` scopes every op,
`@@unique([userId, serverSeq])` gives each user an independent sequence, and
`UserSyncState`/`SyncDevice` are already per-user. All the work is in the
container layer - the bridge, nginx and provisioning.

`bridge.users` carries the mapping: `email`, `supersync_user_id`, `is_public`
and `sort_order`.

### Identity is the account id, never a name or address

A user's sync account is `sp-user-<id>@sp.invalid`, derived from the immutable
bridge user id. Passwords for those accounts are derived too -
`HMAC(JWT_SECRET, "sync-account:" + address)` - and never stored; nobody types
them, they exist only because the sync server's account model wants one.

Email was the identity in the first draft, and that was a trap: an account
provisions its sync board on first login, so editing the email afterwards would
either silently do nothing or repoint the user at a different, empty account -
their tasks apparently gone. "Editable afterwards" and "email is the identity"
cannot both be true. Deriving from the id makes renaming a user, or changing
their email, completely safe. Email is now ordinary profile data, kept only
because an admin list showing `sp-user-42@sp.invalid` with no human label is
hard to read.

The one exception: the **first** account binds to `SP_SYNC_ACCOUNT_EMAIL` and
reuses the existing `supersync.webapp_access_token` row, so a stack upgraded
from single-user keeps the board it already had - and every browser already out
there keeps its sync cursor.

### The load-bearing piece: a per-session override

`docker-entrypoint.sh` used to bake `assets/sync-config-default-override.json`
once at container start, with one token in it. Every browser got the same file,
so every browser was the same user.

That path is now served by the bridge, which reads the session cookie and
returns the caller's own token. It cost **zero Angular changes** - the app
fetches the path same-origin, so the cookie rides along and it never learns the
file became dynamic. nginx falls back to the baked file only on a 404 (which
means auth is disabled); a 401 must never fall through, or an unauthenticated
browser would be handed the container account's token.

### Encryption is container-wide, deliberately

One passphrase (`SP_SYNC_ENCRYPTION_PASSWORD`), no per-user keys. Isolation
comes from `userId` scoping on the server, not key separation. The honest
consequence: **an admin with database access can decrypt any user's board.**
Per-user keys would fix that but would make publishing impossible - a viewer
could not decrypt what they are allowed to read - and the bridge could no longer
read anything. Not worth it for a self-hosted LAN deployment where the admin
already owns the disk.

### Publishing is whole-board

`is_public` cannot be finer. The server stores ops encrypted and cannot read
them, so it cannot filter a board down to "just the public projects" without
decrypting - which defeats the encryption. A client-side filter is not an access
control. So a board is published or it isn't.

Viewers read a published board through token delegation: the bridge mints a token for the board's _owner_ and serves it in that viewer's override. What stops that token being used to write is its **scope** - it is provisioned with `scope: 'read'` (`sync-identity.ts`, `provision(..., 'read')`), which the sync server refuses on every route that changes data.

> **Not true yet.** This section used to say nginx denies the write routes for `role=viewer`. It does not: `location /sync/` carries no `auth_request` and no role check at all. Proxy-level gating _would_ be sufficient, because the write surface is exactly three routes - `POST /sync/api/sync/ops`, `POST /sync/api/sync/snapshot`, `DELETE /sync/api/sync/data` - with everything else being reads plus a notification-only websocket. It is planned, not built. Until it is, the read-scoped token is the only thing holding that boundary, so a regression in scoping has no second layer behind it.

### Deleting a user removes their data

Delete is a purge, not a detach: the bridge row, the stored token, the SuperSync
account, and that account's ops, devices, sync state and passkeys. The sync
server owns those tables, so the bridge calls `DELETE /api/internal/users/:id`
over the internal channel. Irreversible, so the UI asks for the username to be
typed first.

### The UI

Two surfaces, both shown only when the container is the authority - desktop and
standalone builds have no accounts:

- **Account menu** in the toolbar, holding the slot upstream's profile switcher
  used to occupy. Who you are, then Account, Settings, and Log out.
- **Accounts** section in Settings, which is one table for every rank.

The table has the same three columns whatever your role: USER, ROLE, ACTIONS. What changes is the number of rows and the number of actions.

An admin sees every account, and each row carries reordering, the API keys toggle, edit, and delete. Everyone else sees exactly one row, their own, carrying the keys toggle and edit. There is no second layout and no separate panel: a non-admin gets the same table with a shorter list.

Editing any account, including your own, goes through the row's edit dialog. That is the only place an account is changed, so there is never a form above the table competing with the row below it. What the dialog offers depends on who you are:

| Editing                  | Username | Role                   | Email | Password | Current password |
| ------------------------ | -------- | ---------------------- | ----- | -------- | ---------------- |
| yourself, as admin       | yes      | yes, unless last admin | yes   | yes      | required         |
| yourself, as anyone else | no       | no                     | yes   | yes      | required         |
| someone else, as admin   | yes      | yes, unless last admin | yes   | yes      | not asked        |

That table describes **the dialog**, not the routes underneath it. The API is looser: `PUT /api/auth/users/:id` is admin-gated but has no self-check, so an admin naming their own id can set a password without supplying the current one. The UI never does that - a self-edit goes to the self routes - but nothing on the server enforces the split.

Changing your own password asks for the current one first. A session proves the browser holds a valid cookie, not that the owner is at the keyboard, so without that check an unattended machine or a copied cookie converts temporary access into permanent credential control. An admin resetting someone else's password is exercising authority rather than proving identity, so it does not apply there. Mechanically this is why a self-edit goes to `PUT /api/auth/me` and `PUT /api/auth/password` while an admin editing someone else goes to `PUT /api/auth/users/:id`.

API keys render as indented sub-rows under the account that owns them, revealed by the key toggle in the actions column, which also shows how many live keys that account has. Each key row carries reveal, copy and revoke; once revoked the row stays, struck through, and offers delete instead. The two are different operations on purpose, see "Revoking and deleting are separate" below.

Both surfaces talk to the bridge over the session cookie, **not** through
formly/`GlobalConfig`. `GlobalConfig` is synced op-log data - encrypted,
per-user, unreadable by the server - so access control cannot live in it.

### Why upstream's user profiles are hidden here

Upstream ships a profile switcher (toolbar avatar → "Manage User Profiles"),
default off. It is not multi-user: profile metadata sits in `localStorage`, each
profile's data is a whole-dataset blob in IndexedDB, and switching exports the
current dataset, imports the other, and reloads. No accounts, no passwords, no
server involvement, and profiles exist only in the browser that created them.

Under container authority it is actively dangerous. The `lastServerSeq` cursor is
keyed on `hash(baseUrl|accessToken)`; a switch replaces the dataset but leaves
the token untouched, so the browser continues as _the same sync client_ holding
_different data_. The next sync either pushes one profile's data into the other's
account, or raises the migration prompt - which container authority suppresses,
so the server wins silently.

Both surfaces are therefore hidden when the container is the authority. The
stored setting is not forced off: hiding the surfaces closes the path, and
writing to `globalConfig` would be a sync operation - changing user data to
enforce a UI decision. Profiles stay fully available in desktop and standalone
builds, where they make sense.

### The account routes took API keys late

Every `/api/auth/*` route once read the session cookie directly and refused an API key. That was unfinished wiring rather than a decision, and it is now closed: both credentials resolve to a user, and that user's role applies either way.

It read as deliberate because it once was. When those handlers were written a key was a single container-wide secret with no user attached, so "your own account" had no meaning for it and a session was the only thing that could answer. Keys became per-user later, the request hook was rewritten so both credentials resolve to a user, and these handlers were not revisited until this change.

The containment question had to be settled first. A key that reaches these routes can mint further keys, read every account's key string, and reset passwords, so revoking the leaked key would no longer end the incident. Minted keys at least show up as rows in the accounts table, where they can be spotted and revoked; a password reset renders nowhere at all. The answer shipped is that a **key** performing a credential-granting call must also send the caller's account password: creating a key, revoking or deleting one, changing a role, or publishing a board. Browser sessions are unaffected, and ordinary read and write traffic never carries a password. Renaming an account or fixing its email is not gated, because neither widens access, and reading keys is deliberately left open because an admin holding a subordinate's key is how delegated management works here.

Two things follow from keys having no role of their own. A key inherits its owner's role, read per request, so demoting an account instantly weakens every key it holds. And "create an admin key" is not expressible: you create a key _for an account_, so a non-admin can only ever create keys for itself.

### Reading somebody else's board over the API

The browser switches boards by storing a choice in the login session (`POST /api/auth/viewing`), which is no use to a script. `?boardOf=<accountId>` is the per-request equivalent, honoured on every data route, and an explicit parameter beats whatever the cookie says.

The permission rule is deliberately narrow and lives in one function, `mayReadBoard` in `rest.ts`: a board is readable if its owner shared it, full stop. No role logic, because sharing is all-or-nothing and applies to everyone signed in. If per-account grants ever replace whole-board publishing, that one function learns about them and the other 49 route handlers do not, since all of them resolve their board through the single `boardFor` seam.

Shared boards are read-only for everyone, enforced in the request hook rather than per route. Rank buys nothing here: an admin reading an operator's board is a reader there, and the sync token minted for that board is read-scoped for the same reason. An admin cannot read a board that was never shared.

### Known gaps

- Sync tokens are stored in plaintext in `bridge.settings`, one row per user under `supersync.user_token.<id>`. Anyone with database access holds every user's sync credential. They are not derived like API keys are, because the sync server issues them and we only keep what it hands back.
- `DELETE /api/sync/data` on the sync server is scoped to the calling user (`getAuthUser(req).userId`), so it wipes only that account. It is still unguarded by role, meaning a viewer can erase their own board despite being read-only everywhere else.
- `PUT /api/auth/users/:id` has no self-check, so an admin can reset their own password through the admin route without proving the current one. The self route asks; the admin route does not, and an admin is allowed to target themselves with it.
- The Web Locks API needs a secure context, and this stack is normally reached over plain HTTP on a bare address (`http://<host>:18230`), which is not one. The app logs `[LockService] Web Locks API not available. Using multiple tabs may cause DATA LOSS.` and its multi-tab guard is off. HTTPS or `localhost` restores it. For a fork whose whole model is reaching a server over the network, this is the common case rather than an edge one.

Closed since the first draft: the role ACL is enforcing (`canWrite` gates every non-read method in the bridge's `onRequest` hook), API keys are per-user rather than one container-wide key, the account routes accept API keys and read role from the database rather than the session JWT, `?boardOf=` gives scripts the board switching the browser had, and the bridge no longer reports zero boards for an account whose browser is showing the built-in defaults.

---

## The pieces

```
                        ┌───────────────────────────────────────────────┐
                        │             container stack (.env)            │
  browser (view) ─┐     │                                               │
  browser (view) ─┼─────┼──▶ ┌──────────┐  /sync/  ┌──────────────┐     │
  browser (view) ─┘     │    │   web    │─────────▶│  SuperSync   │     │
                        │    │ (nginx)  │          │    server    │     │
   agent / curl ────────┼──▶ └──────────┘          └───────┬──────┘     │
        one port        │          │  /api/                │            │
      SP_WEB_PORT       │          ▼                       ▼            │
                        │    ┌──────────────────┐   ┌────────────┐      │
                        │    │    sp-bridge     │──▶│  postgres  │      │
                        │    │ headless peer +  │   └────────────┘      │
                        │    │    REST API      │                       │
                        │    └────────┬─────────┘                       │
                        │             └──▶ op-log (via SuperSync) ──────┤
                        └───────────────────────────────────────────────┘
```

- **web** - the standard SP frontend (patched build), served over HTTP on the
  LAN. This is what a browser opens, and the **only** container with a published
  port. nginx gates it behind a login and, once you have a session, it
  auto-connects to sync on first load. It also proxies `/sync/` and `/api/`, so
  the sync server and bridge are reachable only through it.
- **SuperSync server** - SP's own operation-based sync server (self-hosted,
  PostgreSQL-backed, E2E-encrypted). It is the hub every client syncs through.
  _Self-hosted; no subscription._
- **postgres** - stores the encrypted operation log, plus (in its own `bridge`
  schema) local accounts and the durable secrets described below.
- **sp-bridge** - a headless Node process that joins sync **as a peer**, holds
  the encryption passphrase, replays the op-log into live state, and exposes the
  **REST API**. This is the component that replaced MCP. It also owns login: it
  serves the login page and the session endpoints that nginx checks against.

---

## How data flows (the op-log model)

SP does not sync "the current state." It syncs **operations** - a running log of
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
`timeSpentOnDay`), scheduling fields (`dueDay`, `dueWithTime`), and - if it is a
subtask - a `parentId`. Parent tasks list their children in `subTaskIds`.

### Projects

A container for tasks. Every task belongs to exactly one project (the default is
`INBOX_PROJECT`, titled "Inbox", which cannot be deleted). Deleting a project
deletes its tasks with it.

### Tags

Cross-cutting labels with a `title`, `color`, and `icon`. A task can carry many
tags. Tags are how several features are actually implemented - read on.

### Boards (Kanban) are tag-driven

This is the single most important non-obvious fact. A Kanban board column is not
a container you move a task _into_. Each column has an `includedTagIds` list, and
a task appears in that column because it **carries that tag**. So "move this task
to the In Progress column" means **add the `KANBAN_IN_PROGRESS` tag** (and
usually remove the previous column's tag). You do board moves through the tag
endpoints, not a dedicated board endpoint.

Two practical consequences when you build a column rather than move a card through one. A new column needs a tag to filter on, so creating the column is usually two writes, not one. And its tag has to be excluded from the columns to its left, or the same card shows up in two places at once, which is why the stock To Do panel excludes `KANBAN_IN_PROGRESS`.

### Boards have a project scope

A board carries `projectIds`, saying which project it belongs to. It uses the
same `""` sentinel the panel filters use: `[""]` (or absent) means **unassigned**,
and any array mixing `""` with real ids collapses to `[""]` on save.

The header carries a project selector. On **All Projects** the app behaves as it
always has. Pick a project and the board strip narrows to boards assigned to it -
strictly, so an unassigned board shows only under All Projects. The scope also
narrows what the panels contain, to tasks in that project.

A board is assigned from its own context menu — **Move to project**, **Copy to
project**, or **Copy as empty template** — each picking one project or "No
project". Assignment is deliberately NOT a form field: the shared
`project-select` is built for panel filters, where "All Projects" means "match
every project", so it expands `['']` into `['', ...everyProjectId]` and ticks
every box. As an assignment that reads as "this board is in all projects" and
makes a single project nearly unpickable.

"All Projects" is a **view over every board, never an owner**. A board is either
assigned to a project or unassigned; unassigned boards appear only under All
Projects, and All Projects shows every board whatever its assignment.

An assignment narrows the board's **contents** as well as its tab: a board
assigned to Work lists only Work's tasks, in every view including All Projects,
and a task added to one of its columns is created in Work. Scope resolution runs
most-specific-first — the panel's own project filter, then the board's
assignment, then the header scope.

The two copy actions differ only in the manual card order. Both keep the tag
filters, because those are what make cards appear at all; **Copy to project**
keeps the card order so the columns look as they did, while **Copy as empty
template** clears it so the board starts fresh. Neither touches task data:
a board stores no tasks, so what a copy shows is whatever its filters match in
its new home.

Two board-level filters could disagree, so they do not both exist in the UI: the
per-panel project filter is no longer rendered in the board editor, and the
header scope is the only one a person drives. `BoardSrcCfg.projectIds` is
untouched underneath - still in the schema, still in the op-log, still writable
over the REST API - so an API caller that deliberately wants a per-column project
split can still build one. When a panel is scoped that way and the header scope
names a different project, the column says so instead of rendering empty, because
an unexplained empty column reads as lost data.

A board naming only projects that do not exist stays visible under every scope.
That is deliberate: a deleted project is permanent, and project ids are per
account, so a board read over `?boardOf=` names its owner's projects, not yours.
Hiding it would leave it reachable under no scope at all.

The selected scope is a **preference, not geometry** - it says what you want to
look at - so it follows the account through `SYNCED_KEYS`
(`LS.GLOBAL_PROJECT_SCOPE`) rather than sitting per-browser. Like most
preferences here it is read once at construction, so a change made on another
device applies on the next reload.

> **Not true yet.** The selector sits in the global header, but only the Boards
> page honours it. Planner, Schedule, Search, the scheduled list and Habits
> ignore the scope entirely and show every project regardless of it. Boards was
> deliberately first - it is where the two scoping mechanisms met and had to be
> reconciled - and widening it is mechanical now the precedence rule is settled.
> Until that lands, the control is more global-looking than it is global.

### Starter boards exist before they are stored

The two boards a fresh install shows, the Eisenhower Matrix and a Kanban, are not data. They are `DEFAULT_BOARDS`, the NgRx initial state, and nothing is written to the op-log until somebody edits a board for the first time.

That used to mean the browser and the bridge disagreed about reality. A browser drew two boards; the bridge, reading the op-log, correctly reported none. Anything trusting the bridge would then create a board that already existed on screen, and the add-board op appended it, leaving two identical Kanbans.

`DEFAULT_BOARDS` now lives in `@sp/shared-schema` so both sides read one definition, and the bridge treats an account with no board record as holding the defaults. The first write of any kind stores the whole default set before applying the change, so an edit to a starter board has something real to land on.

The distinction that makes this safe is between an **absent** board record and a **stored empty** one. The materializer creates `state.BOARD` on the first board op of any kind, so absent means untouched and empty means the owner deleted everything. Only absent gets defaults. Delete every board and it stays deleted through a refresh, a re-login, and a bridge restart.

The seed is also gated on a completed `refresh()`, because a store that is merely behind on ops looks identical to a fresh one, and seeding on that misread would duplicate boards another client had already edited.

### The Today list

"Planned for today" is membership in a special virtual tag, `TODAY`. A task is on
today's list if its id is in `TAG['TODAY'].taskIds`. You add/remove membership
with the `today` endpoints, and filter for it with `?plannedForToday=true`.
Scheduling a task for a **future** day (`dueDay`) is separate and shows up on the
Planner.

### What has no equivalent on a headless peer

Some desktop concepts don't exist for an always-on API server, and the API says
so honestly rather than faking them:

- **Current task / running timer** - which task is "active" is device-local UI
  state that never syncs. `GET /api/current-task` always returns `null`.
- **Notifications, start/stop timer** - these are desktop UI actions with no
  server-side meaning.
- **Connection / directory diagnostics** - the MCP transport is gone;
  `GET /api/health` and `GET /api/status` replace those checks.

---

## Talking to the API

- **Base URL:** `http://<host>:<SP_WEB_PORT>/api` (default port `18230`) - the
  same port as the app. The bridge is not published on its own port; nginx
  proxies `/api/` to it.
- **Auth:** every route except `/api/health` and `/api/docs` needs an API key,
  sent as either header:
  - `Authorization: Bearer <key>`
  - `X-Api-Key: <key>`
- **Self-describing:** `GET /api/docs` returns a live map of every route and its
  parameters, so an agent can discover the surface without this file.

Keys belong to **accounts**, not to the deployment. Each is created in
Settings → Accounts → API keys (or `POST /api/auth/users/:id/keys`) and acts as
its owner: it reads and writes that user's board and is held to that user's
role, so a `viewer`'s key gets `403` on any write. An admin can create, view and
revoke anyone's keys: this is one person's container, and the admin already
holds `JWT_SECRET`, so hiding them would only cost them the ability to fix a
broken integration.

Keys are `spk_<id>_<digest>` and are **derived, never stored**:
`HMAC(JWT_SECRET, "api-key:v1:<userId>:<keyId>:<salt>:<version>")`. The database
holds only the ingredients, none of which is a secret, so a leaked backup yields
no working key and there is no digest in the process to steal. Because
derivation is repeatable, an owner can re-read a key whenever they ask,
"copy it now, you will never see it again" is a limitation of servers that threw
the plaintext away, not a security property. Rotation is a `version` bump.

### Revoking and deleting are separate

`POST /api/auth/users/:id/keys/:keyId/revoke` kills the key and keeps the row. `DELETE /api/auth/users/:id/keys/:keyId` removes the row entirely.

Revoke is the normal action, because the row is the only record that the key ever existed: its label says what it was for and its last-used stamp says when something was still calling in with it. Delete is for tidying up records you no longer want to look at, which is why the UI only offers it once a key is already dead.

Deleting is safe rather than reckless: a `SERIAL` sequence only ever moves forward, so a freed id is never handed to a future key and the old string can never verify again.

Repeated failures from one address add a short delay, but a **correct** key is
never refused by it. That is deliberately unlike the login limiter, which does
lock out: passwords have a small guessable space, whereas a key has 96 random
bits, so a lockout would buy nothing and would deny service to whoever shares
the caller's address behind a proxy.

A browser session cookie also authenticates these routes, which is what lets the
web app call the bridge without a key.

```bash
# liveness (no auth)
curl http://192.168.100.237:18230/api/health

# everything else needs a key from Settings -> Accounts -> API keys
curl -H "X-Api-Key: spk_1_yourkeyhere" \
     http://192.168.100.237:18230/api/tasks?isDone=false
```

Configuration lives in `docker/deployment/.env`. Every service reads that one
file via `env_file:`, so a value is written once and no service has an
`environment:` block to keep in sync.

**Required** - the stack will not start correctly without these:

| Variable                      | Purpose                                              |
| ----------------------------- | ---------------------------------------------------- |
| `JWT_SECRET`                  | signs sync tokens; must be identical across services |
| `POSTGRES_PASSWORD`           | database password                                    |
| `SP_SYNC_ENCRYPTION_PASSWORD` | E2E passphrase - admin-set, never typed by a user    |
| `SP_SYNC_ACCOUNT_EMAIL`       | sync server account identity (never emailed)         |
| `SP_SYNC_ACCOUNT_PASSWORD`    | **minimum 8 characters** - see below                 |

**Optional** - sensible defaults otherwise:

| Variable                      | Purpose                                                     |
| ----------------------------- | ----------------------------------------------------------- |
| `TZ`                          | container timezone, used for logs and logical-day rollover  |
| `SP_WEB_PORT`                 | the only published port (default `18230`)                   |
| `SP_IMAGE_TAG`                | published image tag to run (default `latest`)               |
| `STACK_PREFIX`                | container name prefix (default `sp`: `sp-web`, `sp-bridge`) |
| `ALLOW_INSECURE_HTTP`         | `true` for plain HTTP on a LAN; `false` behind a TLS proxy  |
| `SP_BRIDGE_POLL_INTERVAL_SEC` | websocket-fallback poll interval (default 15)               |
| `SP_AUTH_SESSION_TTL_H`       | session lifetime in hours, sliding (default 720)            |
| `POSTGRES_USER` / `_DB`       | database name and role                                      |
| `POSTGRES_HOST` / `_PORT`     | point these at an external server to drop the bundled one   |

**Resource caps**, all with working defaults - raise them on a busy stack rather than tuning by default:

| Variable                                                             | Default                                    |
| -------------------------------------------------------------------- | ------------------------------------------ |
| `SUPERSYNC_MEM_LIMIT` / `SP_BRIDGE_MEM_LIMIT` / `POSTGRES_MEM_LIMIT` | `512m` / `256m` / `256m`                   |
| `PG_SHARED_BUFFERS`                                                  | `64MB`, keep well under the postgres cap   |
| `PG_MAX_CONNECTIONS`                                                 | `20`, ample for this stack's three clients |

`SP_BRIDGE_MEM_LIMIT` is the one that grows with real use: the bridge holds the materialized board in memory, so it scales with task count.

**Deliberately not in `.env.example`:** `SP_AUTH_ENABLED`. It disables the browser login gate entirely, which also unpublishes the per-session sync override and hands every browser the container account's token. It exists for local development only, and putting it in the file people copy would invite turning it off in a deployment where accounts are what issue the API keys.

A sync account password under 8 characters **fails quietly**: provisioning
logs an error and stops, so the stack boots but serves no sync token.

`DATABASE_URL` is not set by hand - the bridge and the sync server each
assemble it from `POSTGRES_*`, percent-encoding the credentials. Setting it
explicitly still wins, which is how you point at an external database that
needs connection parameters.

**Using an external postgres:** comment out the `postgres` service and the two
`postgres:` `depends_on` blocks, create an empty database on your server, and
set `POSTGRES_HOST`/`_PORT`. Schema creation still happens on first start.

---

## Operational notes

**The sync token is stable across restarts, on purpose.** SuperSync derives the
localStorage key it tracks its sync cursor under from
`hash(baseUrl | accessToken)`. That is sound upstream - it separates two users
sharing one server - but it assumes the token is a stable identity. The web
entrypoint therefore asks `sp-bridge` for the token rather than minting one, and
the bridge persists it in Postgres.

Minting per boot instead means every restart hands browsers a new token, which
changes the hash, resets every client's cursor to zero, and makes each one
conclude it has never met this server before. Renewal only happens within 30
days of the token's expiry - an annual event, not a per-restart one.

**Editing deployment config does not rebuild the frontend.** `nginx/`,
`docker-entrypoint.sh`, `docker/` and `documentation/` are excluded from the
build stage's `COPY`, so they are not part of its cache key. Without that,
changing one line of an nginx directive forced a full ~10-minute Angular
rebuild. (This needs BuildKit's labs Dockerfile syntax, declared at the top of
the `Dockerfile`.)

**`docker compose restart` does not honour `depends_on` ordering** the way `up`
does - it starts every container at once. `sp-bridge` retries its initial
connection for up to 30s rather than exiting, so a whole-stack restart settles
on its own instead of crash-looping until the sync server is ready.

**One published port, and that is a security property, not just tidiness.**
nginx serves the app at `/`, the sync server at `/sync/`, and the bridge at
`/api/`, all on `SP_WEB_PORT`. Neither the sync server nor the bridge is
published, so nothing on the LAN can reach either except through nginx.

That is what makes the served config address-free: the sync `baseUrl` is the
root-relative `/sync`, so no deployment ever has to be told its own address,
and the same image works on any host, port, or reverse proxy unchanged.

It is also the prerequisite for per-role write gating. Because every sync
request passes through nginx, a session's role can be checked before `POST
/sync/api/sync/ops` reaches the server. While sync was published on its own
port, browsers talked to it directly and no such check was possible.

**The sync server's write surface is three routes** - `POST /api/sync/ops`,
`POST /api/sync/snapshot`, and `DELETE /api/sync/data`. The websocket is
notification-only and accepts no writes, which is why gating those three at
the proxy is sufficient. Note that `DELETE /api/sync/data` wipes the op-log
and currently answers to any authenticated session.

---

## Working on the app without rebuilding the image

The production Angular build takes ~7 minutes, so rebuilding the web image to
see a CSS change is the wrong loop. Point the dev server at a running stack
instead:

```bash
docker compose -f docker/deployment/compose.yml up -d   # if not already up
npm run serve:container                                 # http://localhost:4200
```

`proxy.conf.json` forwards `/api`, `/login`, `/sync` (websocket included) and the
per-session override to the stack on `:18230`, so the app you get is the real
one - real bridge, real database, real accounts - with hot reload instead of an
image build. Point `target` elsewhere in that file if the stack is not local.

**One wrinkle:** the dev server serves `src/assets/` before consulting the proxy,
so the placeholder `sync-config-default-override.json` shadows the bridge's
per-session route and the app will not see itself as container-managed - which
hides the Accounts UI. Move the placeholder aside while dev-serving:

```bash
mv src/assets/sync-config-default-override.json /tmp/    # restore when done
```

Build an image when you actually want to ship one. Timings on a 4-vCPU host,
measured: `sp-web` ~7 min, dominated by the production Angular build.
`sp-bridge` and `sp-supersync` are well under a minute - **as long as
`package.json` has not changed.** Touching it invalidates the `npm ci` layer in
all three images, which took those two from seconds to 7 minutes combined. A
backend-only change never needs `sp_web` rebuilt.

**Lint does not run inside the image build.** It cost 76s of every build and
failed _after_ the expensive layer. The gate lives in
`.github/workflows/publish-containers.yml` as a job the six build jobs depend on,
so a style error stops the release before any image starts building, and costs a
local build nothing. Note that `ci.yml` only lints on pull requests to `master`,
which this fork's tag-driven flow never opens - without that job nothing would
lint at all. Run `npm run lint` locally before tagging.

### Rebuilding the dev stack from scratch

```bash
cd docker/deployment
docker compose down
docker compose build --no-cache
docker compose up -d --force-recreate
```

`docker compose build` with no arguments is already the whole stack. Only three services declare a `build:` (in `compose.override.yml`); `sp_postgres` is an upstream image with no build section, so Compose skips it silently. Naming the three services adds nothing.

**Never run `docker compose pull` against this stack.** It looks like the way to refresh images and it quietly destroys a local build. The three built services are tagged `ghcr.io/anexgohan/sp-{web,supersync,bridge}:latest` - the same names the local build writes to - so `pull` fetches the published images from GHCR and overwrites whatever you just built. The stack then comes up green and healthy running code that is potentially weeks old. Health checks cannot catch this; the tell is behavioural, like a route count that is short of what the source says it should be. Only `sp_postgres` benefits from a pull, and `up -d` handles that on its own.

If you genuinely want newer `FROM` bases - `node:24-alpine`, `node:22`, `nginx:1`, all moving tags that upstream repatches - use `docker compose build --pull`, which refreshes the bases _during_ the build instead of replacing the artifacts after it. Keep that as a deliberate occasional act rather than part of a routine rebuild: it changes the build environment underneath you, so a build that worked yesterday can fail today for reasons that have nothing to do with your code.

**A full rebuild keeps your data, and keeps more than you might want.** Persistence is bind-mounted at `docker-data/{postgres,bridge,supersync}`, which `down` never touches (only `down -v` would, and that would take the accounts and API keys with it). The bridge's materialized state cache under `docker-data/bridge` also survives, and it is restored on boot rather than replayed from the op log. So a materializer fix applies to new ops only; entities materialized wrongly before the fix stay wrong across any number of rebuilds. Clear that directory to force a full re-materialization.

---

## Publishing images (GHCR) and deploying elsewhere

The dev box builds from source. A real deployment target should not have to -
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
plain-HTTP `server.ts` fix) - upstream's build has none of those.

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
  them publicly safe - a pulled image is inert until an operator supplies `.env`.

**Deploying on another host** needs no source tree, no build toolchain and no
`git clone`. Every release ships the two files a user actually runs, so getting
started is two downloads:

```bash
wget -O compose.yml https://github.com/Anexgohan/super-productivity/releases/latest/download/compose.yml
wget -O .env        https://github.com/Anexgohan/super-productivity/releases/latest/download/example.env
# edit .env: set the five CHANGE_ME values
docker compose pull && docker compose up -d
```

`releases/latest/download/…` always resolves to the newest release, so those
URLs never need updating. Then open `http://<host>:18230/` - it redirects to
`/login`, and the first visit creates the admin account.

The three packages are public, so no token is needed to pull. That is a one-time
setting per package - GHCR creates them private, and they were flipped after the
first publish.

**One compose file, not two.** `docker/deployment/compose.yml` is image-only and
is the file shipped as a release asset. Building from source lives in
`compose.override.yml`, which Docker loads automatically from the same
directory - so `docker compose up -d --build` still builds locally in the dev
tree, while a user who downloads only `compose.yml` gets pulls. That avoids
maintaining two near-identical compose files that drift apart.

---

## Major removals from upstream

Things this fork deleted rather than kept. Recorded so the decisions stay legible
instead of looking like drift. Nothing is lost - it is all in git history.

### Upstream's containerized E2E suite (2026-07-24)

Removed: 91 spec files tagged `@supersync` (73) or `@webdav` (18), 11
Docker/compose files, 3 `wait-for-*.sh` helpers, 9 E2E fixtures/pages/utils, and
9 npm scripts (`e2e:docker*`, `e2e:supersync*`, `e2e:webdav*`, `supersync:up`/
`:down`). Kept: the ~113 plain specs (279 tests) and our own three Dockerfiles
plus `docker/deployment/`.

Three reasons:

- **They could never run here.** CI invoked `npm run e2e:ci`, which resolves to
  `--grep-invert "@supersync|@webdav"` - the 91 were already excluded from every
  CI run. Running them locally needs Playwright's Chromium (~200 MB) plus Docker
  backends, and installing browsers on the dev container is ruled out. Code that
  cannot run is worse than absent: it reads as coverage that does not exist.
- **They test behaviour this fork deliberately changed.**
  `supersync-server-migration-abort.spec.ts` asserts the _"Server Already
  Contains Data"_ dialog appears - which container authority suppresses on
  purpose. `supersync-token-expiry.spec.ts` assumes a rotating token, where we
  persist one. "Fixing" those meant rewriting upstream's tests to match a fork
  they were never written for.
- **The deployment files were superseded.** `docker-compose.yaml` was upstream's
  self-host stack; `docker/deployment/compose.yml` replaces it.

**What it costs:** there is no automated regression test for sync semantics -
op-log ordering, vector clocks, multi-client convergence, cascade deletes. That
gap is real, and it covers exactly the paths the multi-user work touches. The
option not taken was running the containerized suite in CI, where GitHub's
runners provide both Chromium and Docker at no local cost; it remains the only
honest way to get that coverage back.

Removing the specs broke three things the _kept_ tests depend on, fixed in the
same change: the `syncPage` fixture was dropped from `e2e/fixtures/test.fixture.ts`
(and `tagPage` **restored**, since 3 kept specs use it), `e2e/global-setup.ts`
lost its health gate on a server that can no longer exist, and one test in
`packages/super-sync-server/tests/migration-sql.spec.ts` that read upstream deploy
tooling this fork does not use was removed.

Verified after removal: 900 sync-server tests in 44 files pass, and
`npx playwright test --list` loads 279 tests in 113 files, so every remaining
import resolves.

Upstream's own docs still reference the removed compose files
(`docs/wiki/2.13-Run-with-Docker.md` and others). Those describe upstream's
deployment story, not this fork's, so they were left rather than rewritten.

To restore, find the removal commit with
`git log --diff-filter=D --oneline -- 'e2e/tests/sync/*'` and check out its
parent. The specs alone are not enough - they need the fixtures, pages, utils,
compose files and shell scripts from the same commit, plus the npm scripts.

### Upstream's 26 CI workflows

Pruned when the fork's own `publish-containers.yml` was added: they built and
released upstream's desktop apps, store listings and web deployment, none of
which this fork produces.

---

## Mental model in six bullets

- The **container owns the data**; a browser holds a full replica but no claim on
  it, and loses it when the signed-in identity changes; agents use REST.
- Data is an **encrypted op-log**; every change is an operation, replayed by all
  clients. The _sync_ server never sees plaintext - the **bridge does**, because
  it holds the container-wide key and that is what lets the REST API work at all.
- **Board columns and the Today list are tags** - move tasks by changing tags,
  not by calling a board or list API.
- **Writes round-trip and settle** before the API returns; **reads** are live
  over a websocket, with `POST /api/sync/refresh` as the guarantee.
- **Settings follow the account, geometry follows the screen** - and a browser
  is never asked to arbitrate against the server.
- Things that are inherently device-local (current task, notifications, timers)
  are **reported as absent**, not simulated.
