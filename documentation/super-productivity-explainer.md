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
more. Browsers that open the web UI are disposable, zero-setup **views**: they
sync down a local replica and can be closed at will. Agents talk to the REST
API with `curl`; humans use the browser. Both see the same data.

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
  LAN. This is what a browser opens. It auto-connects to sync on first load.
- **SuperSync server** — SP's own operation-based sync server (self-hosted,
  PostgreSQL-backed, E2E-encrypted). It is the hub every client syncs through.
  *Self-hosted; no subscription.*
- **postgres** — stores the encrypted operation log.
- **sp-bridge** — a headless Node process that joins sync **as a peer**, holds
  the encryption passphrase, replays the op-log into live state, and exposes the
  **REST API**. This is the component that replaced MCP.

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
  what *every* client will converge on.
- **The API response reflects post-sync state.** Because a write round-trips
  through the server before returning, what you get back is the settled result,
  not an optimistic guess.
- **Reads can be up to one poll interval stale.** `sp-bridge` polls on an
  interval (default 15s). If another client just made a change, call
  `POST /api/sync/refresh` to pull immediately instead of waiting.
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
a container you move a task *into*. Each column has an `includedTagIds` list, and
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
- **Auth:** every route except `/api/health` and `/api/docs` needs the key from
  `SP_BRIDGE_API_KEY`, sent as either header:
  - `Authorization: Bearer <key>`
  - `X-Api-Key: <key>`
- **Self-describing:** `GET /api/docs` returns a live map of every route and its
  parameters, so an agent can discover the surface without this file.

```bash
# liveness (no auth)
curl http://192.168.100.237:18232/api/health

# everything else needs the key
curl -H "X-Api-Key: $SP_BRIDGE_API_KEY" \
     http://192.168.100.237:18232/api/tasks?isDone=false
```

Configuration lives in `docker/deployment/.env`:

| Variable | Purpose |
|---|---|
| `SP_BRIDGE_PORT` | REST port (default `18232`) |
| `SP_BRIDGE_API_KEY` | the API key callers must present |
| `SP_BRIDGE_POLL_INTERVAL_SEC` | how often the bridge pulls the op-log (default 15) |

---

## Mental model in five bullets

- The **container owns the data**; browsers are throwaway views; agents use REST.
- Data is an **encrypted op-log**; every change is an operation, replayed by all
  clients (the server never sees plaintext).
- **Board columns and the Today list are tags** — move tasks by changing tags,
  not by calling a board or list API.
- **Writes round-trip and settle** before the API returns; **reads** may lag one
  poll — `POST /api/sync/refresh` to force freshness.
- Things that are inherently device-local (current task, notifications, timers)
  are **reported as absent**, not simulated.
