<!--
EDITING THIS FILE — read before adding anything.

Audience: admins and users who are starting to USE the API. A working contract, not a design doc. Keep it lean enough to scan.

- One or two lines per route: body/params, response shape, status codes, and any guard that makes a call fail or quietly damage a board.
- Rationale, history, threat models and internal names (services, functions, columns) do NOT belong here. Put them in super-productivity-explainer.md and link to the anchor.
- Short inline notes at most. No multi-paragraph block under a route heading.
- ⚠️ warnings that stop a caller damaging data earn their space. Keep those.
- Never hard-wrap prose at a column — one line per paragraph, the editor soft-wraps. Repo-wide rule, not just this file.
- Behaviour that is intended but not built is a one-line "Not true yet." marker plus a link, never a paragraph. See README.md.
- Routes live in packages/sp-bridge/src/{rest.ts,auth/routes.ts}; GET /api/docs is the live map. If this file disagrees with either, this file is wrong.
-->

# sp-bridge REST API Reference

The complete endpoint contract for the containerized Super Productivity API (`sp-bridge`, v1): **50 data routes** plus **23 account routes**, covering everything the web UI does.

For the concepts behind it, the op-log, why boards are tags, and what the Today list is, read [`super-productivity-explainer.md`](./super-productivity-explainer.md) first.

---

## Conventions

**Base URL** — `http://<host>:<SP_WEB_PORT>/api` (default port `18230`). The bridge is **not published on a port of its own**: nginx serves the app at `/`, the sync server at `/sync/` and the bridge at `/api/`, all on the one published port. Any older note describing a separate bridge port predates that unification and points at a closed port.

**Content type** — send `Content-Type: application/json` on requests **that have
a body**. Do _not_ send it on bodyless `DELETE`s; the server rejects an empty
body declared as JSON (`400 FST_ERR_CTP_EMPTY_JSON_BODY`).

**Errors** — a uniform shape: `{"error": "<message>"}` with the status code.

| Code  | Meaning                                                                    |
| ----- | -------------------------------------------------------------------------- |
| `400` | bad input — missing/invalid field, unwritable field, unknown reference     |
| `401` | missing or invalid credential                                              |
| `403` | authenticated but not allowed — read-only role, or somebody else's account |
| `404` | entity not found                                                           |
| `409` | refused by a safety guard (e.g. deleting a task that still has subtasks)   |

**Freshness** — reads reflect the last op-log poll (default 15s). Call
`POST /api/sync/refresh` first if you need guaranteed-current data. Writes
round-trip through the sync server before returning, so the returned entity is
the settled result.

**IDs** — task/tag/project ids are 21-character nanoids. Two are fixed and
well-known: project `INBOX_PROJECT` and tag `TODAY`.

**Writable task fields** — `title`, `notes`, `isDone`, `doneOn`, `timeEstimate`,
`timeSpent`, `projectId`, `tagIds`, `dueDay`, `dueWithTime`. Any other field in a
`PATCH` body is rejected with `400`. (Structural changes — parent, subtasks,
ordering, attachments — have their own endpoints.)

---

## Authentication

Two credentials reach this API, and both resolve to the same thing — a **user**. Which one you present changes nothing about what you are allowed to do; your account's role decides that either way.

| Credential         | How it is sent                                      | Who uses it     |
| ------------------ | --------------------------------------------------- | --------------- |
| **API key**        | `Authorization: Bearer <key>` or `X-Api-Key: <key>` | scripts, agents |
| **Session cookie** | set by `POST /api/auth/login`, `httpOnly`           | the web app     |

If a request carries both, the key is tried first and wins. Missing, wrong or revoked → `401 {"error":"Unauthorized"}`.

### What each credential reaches today

| Surface                                                                                          | API key              | Session |
| ------------------------------------------------------------------------------------------------ | -------------------- | ------- |
| Data routes — `/api/tasks`, `/projects`, `/tags`, `/boards`, `/today`, `/status`, …              | ✅                   | ✅      |
| Account routes — `/api/auth/*` (the 17 credentialed ones)                                        | ❌ see below         | ✅      |
| `/api/health`, `/api/docs`, `/login`, `/api/auth/login｜setup｜logout｜status｜verify｜register` | no credential needed |         |

> **Not true yet.** A key on `/api/auth/*` gets `401` — `{"error":"Not signed in"}` on `/auth/me`, `{"error":"Unauthorized"}` on the rest. Unfinished wiring, not policy: the goal is that anything the UI can do, the API can do. [Why, and what will gate it](./super-productivity-explainer.md#the-account-routes-are-session-only-for-now).

### Roles

Three roles, applied identically to both credentials:

| Role       | Own board and account | Other accounts                   |
| ---------- | --------------------- | -------------------------------- |
| `admin`    | full                  | full — user and key management   |
| `operator` | full                  | none                             |
| `viewer`   | read-only             | read-only, published boards only |

A `viewer` gets `403 {"error":"Read-only account"}` on any write, whichever credential it used. Role is read fresh from the database on every data request, so a demotion bites immediately.

> **Not true yet.** `/api/auth/*` reads the role from the session JWT instead, so a demoted admin keeps account powers until their session is reissued.

### Key format

`spk_<keyId>_<digest>`, **derived not stored**: `HMAC(JWT_SECRET, "api-key:v1:<userId>:<keyId>:<salt>:<version>")`. Re-readable at any time, so there is no "copy it now" moment. [Why derived](./super-productivity-explainer.md#talking-to-the-api).

⚠️ The middle number is the **key** id in base36, not the user id — do not parse a key to learn whose it is. Key id `42` renders as `spk_16_`.

A key has **no role of its own**: it inherits its owner's, read per request. So a non-admin can only create keys for itself, and only an admin can create one for somebody else.

Wrong keys from one address get a small added delay; a correct key is never refused by it.

---

## Route index

**Service** · [health](#get-apihealth) · [docs](#get-apidocs) · [status](#get-apistatus) · [sync/refresh](#post-apisyncrefresh)

**Reading tasks** · [list](#get-apitasks) · [single](#get-apitasksid) · [current-task](#get-apicurrent-task) · [repeat-cfgs](#get-apitask-repeat-cfgs) · [planner](#get-apiplanner) · [worklog](#get-apiworklog)

**Reading other** · [projects](#get-apiprojects) · [tags](#get-apitags) · [config](#get-apiconfig) · [entities](#get-apientities) · [entities/:type](#get-apientitiestype)

**Task lifecycle** · [create](#post-apitasks) · [from-syntax](#post-apitasksfrom-syntax) · [update](#patch-apitasksid) · [complete](#post-apitasksidcomplete) · [complete-on](#post-apitasksidcomplete-on) · [delete](#delete-apitasksid)

**Bulk** · [bulk complete](#post-apitasksbulkcomplete) · [bulk update](#post-apitasksbulkupdate)

**Hierarchy** · [with-subtasks](#post-apitaskswith-subtasks) · [add subtask](#post-apitasksidsubtasks) · [reparent](#post-apitasksidreparent) · [reorder](#post-apitasksreorder)

**Tags on tasks (Kanban)** · [add tag](#post-apitasksidtags) · [remove tag](#delete-apitasksidtagstagid) · [move project](#post-apitasksidmove)

**Today list** · [plan](#post-apitodayplan) · [remove](#post-apitodayremove)

**Links & issues** · [add link](#post-apitasksidlinks) · [issue link](#post-apitasksidissue-link)

**Tags** · [create](#post-apitags) · [update](#patch-apitagsid) · [delete](#delete-apitagsid)

**Projects** · [create](#post-apiprojects) · [update](#patch-apiprojectsid) · [delete](#delete-apiprojectsid)

**Boards** · [list](#get-apiboards) · [single](#get-apiboardsid) · [create](#post-apiboards) · [update](#patch-apiboardsid) · [delete](#delete-apiboardsid) · [reorder](#put-apiboardsorder) · [add column](#post-apiboardsidpanels) · [update column](#patch-apiboardsidpanelspanelid) · [delete column](#delete-apiboardsidpanelspanelid) · [card order](#put-apipanelspanelidtaskids)

**Session** · [setup](#post-apiauthsetup) · [login](#post-apiauthlogin) · [logout](#post-apiauthlogout) · [status](#get-apiauthstatus) · [verify](#get-apiauthverify)

**Your own account** · [me](#get-apiauthme) · [set email](#put-apiauthme) · [change password](#put-apiauthpassword)

**Accounts (admin)** · [list](#get-apiauthusers) · [create](#post-apiauthusers) · [update](#put-apiauthusersid) · [delete](#delete-apiauthusersid) · [reorder](#put-apiauthusersorder) · [registration](#get-apiauthregistration--put-apiauthregistration) · [self-register](#post-apiauthregister)

**Publishing** · [publish](#put-apiauthusersidpublic) · [published boards](#get-apiauthpublic-boards) · [switch viewing](#post-apiauthviewing)

**API keys** · [list](#get-apiauthusersidkeys) · [create](#post-apiauthusersidkeys) · [revoke](#post-apiauthusersidkeyskeyidrevoke) · [delete](#delete-apiauthusersidkeyskeyid)

---

## Service

### `GET /api/health`

Liveness probe. **No auth.**

```bash
curl http://192.168.100.237:18230/api/health
# {"status":"ok"}
```

### `GET /api/docs`

Machine-readable map of every route. **No auth.** Lets an agent discover the
surface without this document.

### `GET /api/status`

Sync cursor, last sync time, last error, and per-type entity counts. `isLive` is `true` while the websocket is pushing and `false` when the bridge has fallen back to polling. Counts are **this caller's own board**, not the container's.

```bash
curl -H "X-Api-Key: $KEY" http://host:18230/api/status
```

```json
{
  "lastServerSeq": 23,
  "lastSyncAt": 1784775109418,
  "lastError": null,
  "isLive": true,
  "entityCounts": { "TASK": 26, "PROJECT": 2, "TAG": 14, "...": 0 }
}
```

_Replaces MCP `check_connection` / `debug_directories`._

### `POST /api/sync/refresh`

Forces an immediate op-log pull instead of waiting for the next poll. Returns the
same body as `/api/status`. No request body.

---

## Reading tasks

### `GET /api/tasks`

Lists tasks. All filters are query parameters and combine with AND.

| Filter            | Type             | Notes                                                       |
| ----------------- | ---------------- | ----------------------------------------------------------- |
| `isDone`          | `true`/`false`   | completion state                                            |
| `projectId`       | string           | tasks in one project                                        |
| `tagId`           | string           | tasks carrying a tag — **use this to read a Kanban column** |
| `dueDay`          | `YYYY-MM-DD`     | exact due date                                              |
| `parentId`        | string \| `null` | `null` (literal string) = top-level only                    |
| `search`          | string           | case-insensitive match on title _and_ notes                 |
| `overdue`         | `true`           | not done and due before today                               |
| `unscheduled`     | `true`           | no due date, not on Today, not on the Planner               |
| `plannedForToday` | `true`           | on the Today list, or due today                             |
| `parentsOnly`     | `true`           | excludes subtasks                                           |
| `recurringOnly`   | `true`           | only tasks from a repeat config                             |
| `today`           | `YYYY-MM-DD`     | overrides "today" for the date-relative filters above       |
| `fields`          | comma list       | project only these fields (`id` always included)            |

```bash
# overdue, trimmed to the fields an agent actually needs
curl -H "X-Api-Key: $KEY" \
  "http://host:18230/api/tasks?overdue=true&fields=title,dueDay"

# everything currently in the In Progress Kanban column
curl -H "X-Api-Key: $KEY" \
  "http://host:18230/api/tasks?tagId=KANBAN_IN_PROGRESS"
```

_Replaces MCP `get_tasks` (including its advanced filters)._

### `GET /api/tasks/:id`

One task by id. `404` if unknown.

### `GET /api/current-task`

Always `null`: the active task is device-local UI state that never syncs, so a headless peer has none.

```json
{
  "currentTask": null,
  "note": "No active task: the headless bridge tracks no running timer..."
}
```

_Replaces MCP `get_current_task`._

### `GET /api/task-repeat-cfgs`

Lists recurring-task configurations. _Replaces MCP `get_task_repeat_cfgs`._

### `GET /api/planner`

The future-day scheduling board: `{ "YYYY-MM-DD": ["taskId", ...] }`.

### `GET /api/worklog`

Time spent per day, aggregated from `timeSpentOnDay` across tasks.

| Query  | Type                     |
| ------ | ------------------------ |
| `from` | `YYYY-MM-DD` (inclusive) |
| `to`   | `YYYY-MM-DD` (inclusive) |

```json
{
  "2026-07-21": {
    "totalTimeSpent": 5400000,
    "tasks": [{ "id": "...", "title": "...", "timeSpent": 5400000 }]
  }
}
```

_Replaces MCP `get_worklog`._

---

## Reading other entities

### `GET /api/projects`

All projects. _Replaces MCP `get_projects`._

### `GET /api/tags`

All tags, including `color` and `icon`. _Replaces MCP `get_tags`._

### `GET /api/config`

Global configuration, keyed by section.

### `GET /api/entities`

Lists every materialized entity type available for raw access.

### `GET /api/entities/:type`

Raw entity map for one type (`TASK`, `TAG`, `PROJECT`, `BOARD`, `PLANNER`,
`ISSUE_PROVIDER`, …). This is the escape hatch for anything the typed endpoints
don't expose — e.g. reading a board's `includedTagIds`. `404` on unknown type.

```bash
# which tag drives each Kanban column
curl -H "X-Api-Key: $KEY" http://host:18230/api/entities/BOARD
```

---

## Task lifecycle

### `POST /api/tasks`

Creates a task. → `201` with the created task.

| Field                                                      | Required | Notes                                   |
| ---------------------------------------------------------- | -------- | --------------------------------------- |
| `title`                                                    | ✅       |                                         |
| `projectId`                                                |          | defaults to `INBOX_PROJECT`; must exist |
| `notes`, `timeEstimate`, `tagIds`, `dueDay`, `dueWithTime` |          |                                         |

```bash
curl -H "X-Api-Key: $KEY" -H "Content-Type: application/json" \
  -X POST http://host:18230/api/tasks \
  -d '{"title":"Write the deploy runbook","projectId":"N_rey...","timeEstimate":3600000}'
```

> **Note:** a task created through the API lands in its **project**, not on the
> Today list. Put it on Today explicitly with `POST /api/today/plan`.

_Replaces MCP `create_task`._

### `POST /api/tasks/from-syntax`

Creates a task from a single short-syntax string. → `201`.

| Token                                    | Effect                                                              |
| ---------------------------------------- | ------------------------------------------------------------------- |
| `#tag`                                   | adds the tag — **created automatically if it doesn't exist**        |
| `+Project`                               | moves to that project **by title**; must already exist (else `400`) |
| `@today` \| `@tomorrow` \| `@YYYY-MM-DD` | sets `dueDay`                                                       |
| `1h` / `30m` / `1h30m`                   | sets `timeEstimate` (bare token)                                    |

Remaining words become the title. Body: `{"text": "...", "projectId": "..."}`
(`projectId` is the fallback when no `+Project` is given).

```bash
curl -H "X-Api-Key: $KEY" -H "Content-Type: application/json" \
  -X POST http://host:18230/api/tasks/from-syntax \
  -d '{"text":"Ship the release #urgent +Pankha @tomorrow 1h30m"}'
```

### `PATCH /api/tasks/:id`

Updates a task. Body is a partial of the writable fields (see Conventions).
Unknown/unwritable fields → `400` listing them; empty body → `400`.

_Replaces MCP `update_task`._

### `POST /api/tasks/:id/complete`

Marks done, setting `doneOn` to now. No body.
_Replaces MCP `complete_task`._

### `POST /api/tasks/:id/complete-on`

Marks done with an explicit completion date, so the card sorts on the intended
day. Body: `{"doneOn": "YYYY-MM-DD"}` (other formats → `400`).
_Replaces MCP `complete_task_on`._

### `DELETE /api/tasks/:id`

Deletes a task. Returns `{"deleted": "<id>"}`.

**Guard:** `409` if the task still has live subtasks — delete them first. (Stale
ids for already-deleted children do not block the parent.) Deletion also detaches
the task from its parent, project lists, tag lists, and the Planner.

```bash
curl -H "X-Api-Key: $KEY" -X DELETE http://host:18230/api/tasks/<id>
```

_Replaces MCP `delete_task`._

---

## Bulk operations

Both routes build one operation per task and upload them together — cheaper and
more consistent than looping single calls.

### `POST /api/tasks/bulk/complete`

Body: `{"taskIds": ["id1","id2"]}` → `{"completed":[...]}`.
_Replaces MCP `bulk_complete_tasks`._

### `POST /api/tasks/bulk/update`

Body: `{"updates":[{"id":"id1","title":"New","isDone":true}, ...]}` — each entry
is an id plus the writable fields to change. Returns the updated tasks.

**All-or-nothing:** every entry is validated up front; if any id is unknown or
any field unwritable, **nothing is submitted**.

```bash
curl -H "X-Api-Key: $KEY" -H "Content-Type: application/json" \
  -X POST http://host:18230/api/tasks/bulk/update \
  -d '{"updates":[{"id":"a1","timeEstimate":3600000},{"id":"b2","notes":"revised"}]}'
```

_Replaces MCP `bulk_update_tasks`._

---

## Hierarchy

### `POST /api/tasks/with-subtasks`

Creates a parent task and its subtasks in one upload. → `201` with the parent.

Body: the `POST /api/tasks` fields plus `subTasks: ["title", ...]`.

```bash
curl -H "X-Api-Key: $KEY" -H "Content-Type: application/json" \
  -X POST http://host:18230/api/tasks/with-subtasks \
  -d '{"title":"Release v2","projectId":"N_rey...","subTasks":["Cut branch","Write notes","Tag"]}'
```

_Replaces MCP `create_task_with_subtasks`._

### `POST /api/tasks/:id/subtasks`

Adds one subtask under an existing top-level task. → `201` with the subtask.
Body: `{"title": "...", "notes": ..., "timeEstimate": ...}`.

Subtasks **inherit the parent's project** and carry no tags of their own.
Nesting under a task that is itself a subtask → `400` (one level only).

### `POST /api/tasks/:id/reparent`

Moves a task in the hierarchy. Body: `{"parentId": "<id>" | null}`.

- `parentId: "<id>"` — nest under that task.
- `parentId: null` — promote to a top-level task.

Refused with `400`/`409` if: the task is already top-level (on promote), the
target is itself a subtask, a task would become its own parent, or the task has
its own subtasks.

_Replaces MCP `reparent_task`._

### `POST /api/tasks/reorder`

Reorders one list. Body: `taskIds` plus **exactly one** container:

| Container              | Reorders                |
| ---------------------- | ----------------------- |
| `{"projectId": "..."}` | the project's task list |
| `{"parentId": "..."}`  | that parent's subtasks  |
| `{"today": true}`      | the Today list          |

`taskIds` must be a **permutation of the list's current members** — reorder only,
no adds or removals (otherwise `400`). Zero or multiple containers → `400`.

```bash
curl -H "X-Api-Key: $KEY" -H "Content-Type: application/json" \
  -X POST http://host:18230/api/tasks/reorder \
  -d '{"parentId":"<parent>","taskIds":["c","b","a"]}'
```

_Replaces MCP `reorder_tasks`._

---

## Tags on tasks — including Kanban moves

Board columns are tag-driven: a task is in a column because it carries that
column's tag. These endpoints are therefore how you move cards.

### `POST /api/tasks/:id/tags`

Adds a tag to a task, preserving its other tags. Body: `{"tagId": "..."}`.
Idempotent. Unknown tag → `400`.

```bash
# move a card into the In Progress column
curl -H "X-Api-Key: $KEY" -H "Content-Type: application/json" \
  -X POST http://host:18230/api/tasks/<taskId>/tags \
  -d '{"tagId":"KANBAN_IN_PROGRESS"}'
```

_Replaces MCP `add_tag_to_task`._

### `DELETE /api/tasks/:id/tags/:tagId`

Removes one tag, preserving the rest. Idempotent.
_Replaces MCP `remove_tag_from_task`._

### `POST /api/tasks/:id/move`

Moves a top-level task to another project, updating both projects' lists. Body:
`{"projectId": "..."}`. Subtasks cannot be moved directly (`400`) — they follow
their parent.

_Replaces MCP `move_task_to_project`._

---

## Today list

### `POST /api/today/plan`

Adds tasks to the Today list. Body:
`{"taskIds": ["..."], "today": "YYYY-MM-DD"}` (`today` optional, defaults to the
server's current date). Unknown id → `404`.

```bash
curl -H "X-Api-Key: $KEY" -H "Content-Type: application/json" \
  -X POST http://host:18230/api/today/plan -d '{"taskIds":["a1","b2"]}'
```

_Replaces MCP `plan_tasks_for_today`._

### `POST /api/today/remove`

Removes tasks from the Today list. Body: `{"taskIds": ["..."]}`.

Read the list back with `GET /api/tasks?plannedForToday=true`.

---

## Links & issues

### `POST /api/tasks/:id/links`

Attaches a link to a task (appended to `attachments`).
Body: `{"url": "https://...", "title": "optional label"}` — `title` defaults to
the URL.

```bash
curl -H "X-Api-Key: $KEY" -H "Content-Type: application/json" \
  -X POST http://host:18230/api/tasks/<id>/links \
  -d '{"url":"https://github.com/org/repo/pull/42","title":"PR #42"}'
```

_Replaces MCP `add_link_to_task`._

### `POST /api/tasks/:id/issue-link`

Links a task to an external issue so the issue panel recognizes it.

| Field             | Required                                        |
| ----------------- | ----------------------------------------------- |
| `issueId`         | ✅                                              |
| `issueType`       | ✅ (e.g. `GITHUB`)                              |
| `issueProviderId` | ✅ — must be a configured provider (else `400`) |
| `issuePoints`     |                                                 |

Find provider ids via `GET /api/entities/ISSUE_PROVIDER`.
_Replaces MCP `link_task_to_issue`._

---

## Tags

### `POST /api/tags`

Creates a tag. → `201`. Body: `{"title": "...", "icon": "...", "color": "#rrggbb"}`.
_Replaces MCP `create_tag`._

### `PATCH /api/tags/:id`

Updates a tag. Writable: `title`, `color`, `icon`. Changing `color` also syncs the
tag's theme so the UI recolors.
_Replaces MCP `update_tag`._

### `DELETE /api/tags/:id`

Deletes a tag and **cascades**: it is stripped from every task that carried it.
The virtual `TODAY` tag is protected (`400`).

---

## Projects

### `POST /api/projects`

Creates a project. → `201`. Body:
`{"title": "...", "color": "#rrggbb", "isEnableBacklog": false}`.
_Replaces MCP `create_project`._

### `PATCH /api/projects/:id`

Updates a project. Writable: `title`, `isEnableBacklog`, `isArchived`.
_Replaces MCP `update_project`._

### `DELETE /api/projects/:id`

Deletes a project **and all of its tasks** (including subtasks) and notes. Returns `{"deleted": "<id>", "taskCount": <n>}`. `INBOX_PROJECT` is protected (`400`).

> ⚠️ Destructive, not undoable, and no archive to recover from.

---

## Boards

A board is a Kanban view over tasks you already have. It stores no tasks of its own: each panel is a filter, and a card appears in a column because the task matches that column's filter. See [Boards (Kanban) are tag-driven](./super-productivity-explainer.md#boards-kanban-are-tag-driven) before writing one.

A fresh account reads back the two starter boards (Eisenhower Matrix, Kanban) even though nothing has been stored yet, so the API and the browser agree. **`[]` means the owner deleted every board** — it does not mean "none exist, create one". Creating one with a starter board's id → `409`. [Why](./super-productivity-explainer.md#starter-boards-exist-before-they-are-stored).

### `GET /api/boards`

Every board with its panels. Default boards and panels carry i18n keys as titles (`F.BOARDS.DEFAULT.KANBAN`), resolved by the client at render time; boards you create keep the title you gave them.

### `GET /api/boards/:id`

One board. `404` on an unknown id.

### `POST /api/boards`

Creates a board. → `201`. Body: `{"title": "...", "id": "OPTIONAL_ID", "cols": 3, "panels": [...]}`.

`id` is generated when omitted. `cols` defaults to the panel count, so a new board is not born with empty gaps. `409` if the id already exists, including the ids of the starter boards.

### `PATCH /api/boards/:id`

Updates a board. Writable: `title`, `cols`, `panels`. `panels` is a **full replacement array** — the panel routes below are conveniences over exactly that.

### `DELETE /api/boards/:id`

Deletes a board. Returns `{"deleted": "<id>"}`. Deleting every board is allowed and is remembered, per the note above.

### `PUT /api/boards/order`

Reorders boards. Body: `{"ids": ["...", "..."]}`. Must name every board — a partial list is rejected rather than parking the rest at the tail.

### `POST /api/boards/:id/panels`

Adds a column. → `201`. Body is one panel:

```json
{
  "id": "BLOCKED",
  "title": "Blocked",
  "includedTagIds": ["<tagId>"],
  "excludedTagIds": [],
  "taskDoneState": 3,
  "scheduledState": 1,
  "backlogState": 2,
  "isParentTasksOnly": false,
  "projectIds": [""]
}
```

`taskDoneState`: 1 all, 2 done, 3 undone. `scheduledState`: 1 all, 2 scheduled, 3 not scheduled. `backlogState`: 1 all, 2 no backlog, 3 only backlog. `projectIds: [""]` means all projects, which is the app's own convention rather than a typo.

`cols` grows with the panel count. The panel is **appended** — reorder with a `PATCH` on the board.

⚠️ Two things this route will not do for you: exclude the new tag from the columns to its left (without that, a card appears in both), and place a column anywhere but the end.

### `PATCH /api/boards/:id/panels/:panelId`

Updates one column's filters. Writable: everything except `id` and `taskIds`.

### `DELETE /api/boards/:id/panels/:panelId`

Removes a column. Returns `{"deleted": "<panelId>"}`, and `cols` shrinks to match.

⚠️ The tag it filtered on survives, as do any exclusions of that tag on other columns — and a stray exclusion hides matching tasks from every column. Clean those up in the same pass.

### `PUT /api/panels/:panelId/taskIds`

Sets the manual card order inside one column. Body: `{"taskIds": [...]}`. Panel ids are unique across boards, so no board id is needed. Unknown task ids → `400`.

---

## Accounts and keys

Session-only today — an API key is refused with `401`. See [Authentication](#authentication).

**Access rule** for `/users/:id/*`: your own id, or any id if you are an admin. Someone else's → `403 {"error":"Not your account"}`. A key id belonging to a different user than the path names → `404 {"error":"No such key"}`. Admin-only routes answer `403 {"error":"Admin only"}`.

Why admins can read anyone's key, why publishing is whole-board, and the role model behind all of it: [explainer → Accounts, roles and per-user boards](./super-productivity-explainer.md#accounts-roles-and-per-user-boards).

### Session

#### `POST /api/auth/setup`

First admin account, fresh deployment only. **No auth.** Body `{username, password}` → `{username, role}` + cookie. `400` once any account exists.

#### `POST /api/auth/login`

**No auth.** Body `{username, password}` → `{username, role}` + cookie. `401 Invalid credentials` (identical for unknown user and wrong password). 8 failures from one address → `429` + `retryAfterSeconds`, for 15 minutes.

#### `POST /api/auth/logout`

**No auth.** Clears the cookie. → `{"ok": true}`.

#### `GET /api/auth/status`

**No auth.** → `{"setupRequired": false, "userCount": 3}`.

#### `GET /api/auth/verify`

nginx `auth_request` target: `204` + `X-Auth-User`/`X-Auth-Role`, or bare `401`. Infrastructure — not a route to call.

### Your own account

Any role.

#### `GET /api/auth/me`

```json
{
  "id": 1,
  "username": "anex",
  "role": "admin",
  "email": "you@example.com",
  "isPublic": false,
  "viewingUserId": null,
  "setupRequired": false
}
```

Read from the database, not the cookie, so a role or email changed since sign-in is current. `viewingUserId` is whose published board you are reading, `null` for your own.

#### `PUT /api/auth/me`

Sets your email — profile data only, never the sync identity. Body `{"email": "..."}`; blank or `null` clears it, no `@` → `400`.

#### `PUT /api/auth/password`

Body `{currentPassword, newPassword}` → `{"ok": true}`. Wrong current → `403`; under 8 characters → `400`. Required even with a valid session.

### Accounts — admin only

#### `GET /api/auth/users`

→ `[{id, username, role, email, isPublic}]`, in display order.

#### `POST /api/auth/users`

→ `201` with the new row. `409` if the name is taken. No board exists until the account signs in once.

| Field      | Required | Notes                                                 |
| ---------- | -------- | ----------------------------------------------------- |
| `username` | ✅       | 3-32 chars, `a-zA-Z0-9_.-`                            |
| `password` | ✅       | min 8 characters                                      |
| `role`     |          | `admin` \| `operator` \| `viewer`, default `operator` |
| `email`    |          | profile data only                                     |

#### `PUT /api/auth/users/:id`

Sets any of `username`, `role`, `password`, `email` on any account. `409` name taken · `400` demoting the last admin · `404` unknown id. Renaming is safe: the board is keyed to the account id, never the name.

> **Known gap.** Sets a password with no `currentPassword` and has no self-check, so an admin can reset their own this way. See [explainer → Accounts](./super-productivity-explainer.md#the-ui).

#### `DELETE /api/auth/users/:id`

Purges the account, its sync token, its SuperSync account and every op it owns → `{"deleted": true}`. `400` own account or last admin · `404` unknown · `502` if the sync server refuses, leaving the account intact.

> ⚠️ Irreversible. The UI asks for the username to be typed first.

#### `PUT /api/auth/users/order`

Body `{"ids": [3, 1, 2]}` → `{"ok": true}`. Must name every account exactly once (`400`).

#### `GET /api/auth/registration` · `PUT /api/auth/registration`

Whether strangers may sign themselves up. `{"isEnabled": true|false}` both ways.

#### `POST /api/auth/register`

**No credential**, but `403` unless an admin enabled it. Body `{username, password}` → `{username, role}` + cookie. Always creates a `viewer`, whatever the body says. `409` if the name is taken.

### Publishing and viewing

#### `PUT /api/auth/users/:id/public`

Body `{"isPublic": true}` → `{id, isPublic}`. Whole-board only. `409` if the account has never signed in, so has no board yet.

#### `GET /api/auth/public-boards`

→ `{"viewing": null, "boards": [{"id": 2, "username": "sam"}]}`. Your own row is excluded. Any signed-in account.

#### `POST /api/auth/viewing`

Switches which board you read. Body `{"userId": 2}`, or `{"userId": null}` for your own. `404` if unpublished or unknown — deliberately indistinguishable · `400` for your own id. Writes while viewing → `403 {"error":"Read-only: viewing another board"}`.

### API keys

#### `GET /api/auth/users/:id/keys`

→ `{"keys": [{id, label, createdAt, lastUsedAt, revokedAt, key}]}`, revoked ones included. `key` is re-derived per request, and `null` once revoked.

#### `POST /api/auth/users/:id/keys`

Body `{"label": "ci runner"}` → `201` with the full row including the key string. Label defaults to `API key`; over 64 characters → `400`.

#### `POST /api/auth/users/:id/keys/:keyId/revoke`

→ `{"revoked": true}`, or `false` if already revoked. The key `401`s on its next request.

#### `DELETE /api/auth/users/:id/keys/:keyId`

Removes the record. → `{"deleted": true}`.

---

## Not available (by design)

These MCP tools have no API equivalent because they describe device-local or
desktop-only behaviour. The API reports their absence rather than simulating it.

| MCP tool                                | Why not                                      | Use instead                                     |
| --------------------------------------- | -------------------------------------------- | ----------------------------------------------- |
| `start_task` / `stop_task`              | running timer is local UI state              | set `timeSpent` via `PATCH /api/tasks/:id`      |
| `show_notification`                     | desktop UI action                            | —                                               |
| `get_current_task`                      | never syncs                                  | `GET /api/current-task` (returns `null` + note) |
| `check_connection`, `debug_directories` | MCP transport diagnostics; transport is gone | `GET /api/health`, `GET /api/status`            |
