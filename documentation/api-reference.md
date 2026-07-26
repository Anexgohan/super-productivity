# sp-bridge REST API Reference

The complete endpoint contract for the containerized Super Productivity API (`sp-bridge`, v1): **40 data routes**, plus the account routes that mint keys.

For the concepts behind it, the op-log, why boards are tags, and what the Today list is, read [`super-productivity-explainer.md`](./super-productivity-explainer.md) first.

---

## Conventions

**Base URL** — `http://<host>:<SP_BRIDGE_PORT>` (default port `18232`).

**Auth**: every route except `GET /api/health` and `GET /api/docs` requires a
per-user API key, in either header form:

```
Authorization: Bearer <key>
X-Api-Key: <key>
```

Missing, wrong or revoked key → `401 {"error":"Unauthorized"}`.

Keys belong to accounts, not to the deployment. Create one in **Settings →
Accounts → API keys**, or over the API at `POST /api/auth/users/:id/keys`. A key
acts as its owner: it reads and writes that user's board, and it is held to that
user's role. A `viewer`'s key gets `403` on any write, exactly as their browser
session would. An admin may create, view and revoke anyone's keys.

Keys are `spk_<id>_<digest>` and are **derived**, not stored:
`HMAC(JWT_SECRET, "api-key:v1:<userId>:<keyId>:<salt>:<version>")`. The database
holds only the ingredients, so a leaked backup yields no working key, and
because derivation is repeatable, the owner can re-read a key at any time
instead of having one chance to copy it.

Revoking and deleting a key are different operations. Revoking kills the key and keeps the row, so its label and last-used stamp still record what had been calling in. Deleting removes the row. Both are safe against reuse: a `SERIAL` id only ever moves forward, so a freed id is never handed to a future key.

A browser session cookie is accepted in place of a key, which is how the web app
calls the bridge.

Repeated failures from one address add a short delay. A **correct** key is never
refused by that throttle. Keys carry 96 bits of entropy, so locking an address
out would only deny service to whoever shares it behind a proxy.

**Content type** — send `Content-Type: application/json` on requests **that have
a body**. Do _not_ send it on bodyless `DELETE`s; the server rejects an empty
body declared as JSON (`400 FST_ERR_CTP_EMPTY_JSON_BODY`).

**Errors** — a uniform shape: `{"error": "<message>"}` with the status code.

| Code  | Meaning                                                                  |
| ----- | ------------------------------------------------------------------------ |
| `400` | bad input — missing/invalid field, unwritable field, unknown reference   |
| `401` | missing or invalid API key                                               |
| `404` | entity not found                                                         |
| `409` | refused by a safety guard (e.g. deleting a task that still has subtasks) |

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

**Accounts and keys** · [me](#get-apiauthme) · [list keys](#get-apiauthusersidkeys) · [create key](#post-apiauthusersidkeys) · [revoke key](#post-apiauthusersidkeyskeyidrevoke) · [delete key](#delete-apiauthusersidkeyskeyid)

---

## Service

### `GET /api/health`

Liveness probe. **No auth.**

```bash
curl http://192.168.100.237:18232/api/health
# {"status":"ok"}
```

### `GET /api/docs`

Machine-readable map of every route. **No auth.** Lets an agent discover the
surface without this document.

### `GET /api/status`

Sync cursor, last sync time, last error, and per-type entity counts.

```bash
curl -H "X-Api-Key: $KEY" http://host:18232/api/status
```

```json
{
  "lastServerSeq": 23,
  "lastSyncAt": 1784775109418,
  "lastError": null,
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
  "http://host:18232/api/tasks?overdue=true&fields=title,dueDay"

# everything currently in the In Progress Kanban column
curl -H "X-Api-Key: $KEY" \
  "http://host:18232/api/tasks?tagId=KANBAN_IN_PROGRESS"
```

_Replaces MCP `get_tasks` (including its advanced filters)._

### `GET /api/tasks/:id`

One task by id. `404` if unknown.

### `GET /api/current-task`

Always returns `null` with an explanatory note — the active task is device-local
UI state that never syncs, so a headless peer has none. Documented rather than
faked.

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
curl -H "X-Api-Key: $KEY" http://host:18232/api/entities/BOARD
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
  -X POST http://host:18232/api/tasks \
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
  -X POST http://host:18232/api/tasks/from-syntax \
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
curl -H "X-Api-Key: $KEY" -X DELETE http://host:18232/api/tasks/<id>
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
  -X POST http://host:18232/api/tasks/bulk/update \
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
  -X POST http://host:18232/api/tasks/with-subtasks \
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
  -X POST http://host:18232/api/tasks/reorder \
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
  -X POST http://host:18232/api/tasks/<taskId>/tags \
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
  -X POST http://host:18232/api/today/plan -d '{"taskIds":["a1","b2"]}'
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
  -X POST http://host:18232/api/tasks/<id>/links \
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

Deletes a project **and all of its tasks** (including subtasks) and notes, as one
delete-wins operation so it cannot be resurrected by a stale peer.

Returns `{"deleted": "<id>", "taskCount": <n>}`. `INBOX_PROJECT` is protected
(`400`).

> ⚠️ Destructive and not undoable through the API. The task set is derived by
> scanning every task's `projectId`, so it is accurate even if ordering lists are
> stale.

---

## Boards

A board is a Kanban view over tasks you already have. It stores no tasks of its own: each panel is a filter, and a card appears in a column because the task matches that column's filter. See [Boards (Kanban) are tag-driven](./super-productivity-explainer.md#boards-kanban-are-tag-driven) before writing one.

### Starter boards and what "empty" means

A fresh account shows two boards, the Eisenhower Matrix and a Kanban, and neither has been written to the op-log. They are the app's built-in defaults, and nothing is stored until someone edits a board for the first time.

The API accounts for that: `GET /api/boards` on an account that has never touched boards returns those defaults rather than `[]`, so what you read matches what the owner sees in a browser. The first write of any kind stores the whole default set and then applies your change, which is why editing a starter board works even though it had never been saved.

`[]` therefore means something specific: the owner had boards and deleted every one. That state is preserved, not repaired, so the defaults never come back on their own.

One consequence worth knowing if you are writing automation: do not read `[]` as "no boards exist here, I should create one". That was possible before this behaviour existed and produced a duplicate board sitting alongside an identical one the browser was already drawing. `POST` now returns `409` for an id that belongs to the default set.

### `GET /api/boards`

Every board with its panels. Titles of default boards and their panels are i18n keys, not display text, so you will see `F.BOARDS.DEFAULT.KANBAN` rather than "Kanban". The client resolves them at render time. Boards you create carry whatever title you gave them, verbatim.

### `GET /api/boards/:id`

One board. `404` on an unknown id.

### `POST /api/boards`

Creates a board. → `201`. Body: `{"title": "...", "id": "OPTIONAL_ID", "cols": 3, "panels": [...]}`.

`id` is generated when omitted. `cols` defaults to the panel count, so a new board is not born with empty gaps. `409` if the id already exists, including the ids of the starter boards.

### `PATCH /api/boards/:id`

Updates a board. Writable: `title`, `cols`, `panels`.

Panels have no update action of their own upstream, so a panel edit is a `PATCH` carrying the board's whole replacement `panels` array. The panel routes below are conveniences over exactly that.

### `DELETE /api/boards/:id`

Deletes a board. Returns `{"deleted": "<id>"}`. Deleting every board is allowed and is remembered, per the note above.

### `PUT /api/boards/order`

Reorders boards. Body: `{"ids": ["...", "..."]}`.

The list must name every board. A partial list is far more likely to be a caller bug than an intent to shuffle a subset, and the reducer would silently park the omitted boards at the tail.

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

`cols` grows with the panel count so the new column is visible instead of wrapping under the others. The panel is appended; reorder with a `PATCH` on the board.

Two things this route will not do for you. A tag-driven column usually needs its tag excluded from the columns to its left, or a card shows up in both at once. And a column added to fill a middle position arrives at the end until you reorder.

### `PATCH /api/boards/:id/panels/:panelId`

Updates one column's filters. Writable: everything except `id` and `taskIds`.

### `DELETE /api/boards/:id/panels/:panelId`

Removes a column. Returns `{"deleted": "<panelId>"}`, and `cols` shrinks to match.

Removing a column does not touch the tag it filtered on, nor any exclusion of that tag on the other columns. Left behind, such an exclusion hides matching tasks from every column, so clean those up in the same pass.

### `PUT /api/panels/:panelId/taskIds`

Sets the manual card order inside one column. Body: `{"taskIds": [...]}`. Panel ids are unique across boards, so no board id is needed, and this route sits outside `/api/boards` for that reason. Unknown task ids are rejected with `400`.

---

## Accounts and keys

These routes live under `/api/auth/` and are how a key is minted in the first place. They accept a session cookie or an API key, exactly like the rest of the API, and each key acts as its owner.

Access rule for every `/keys` route: you may act on your own keys, and an admin may act on anyone's. Naming an id you do not own returns `403 {"error":"Not your account"}`; naming a key that belongs to a different user than the path says returns `404 {"error":"No such key"}`.

### `GET /api/auth/me`

Who the caller is: `{"id": 1, "username": "anex", "role": "admin", "email": "you@example.com", "setupRequired": false}`.

Read from the database rather than the session, so a role or email changed since sign-in is current.

### `GET /api/auth/users/:id/keys`

Every key that account owns, revoked ones included, as `{"keys": [...]}`. Each entry is `{id, label, createdAt, lastUsedAt, revokedAt, key}`.

`key` is the usable key string, re-derived per request. It is `null` once `revokedAt` is set, because a revoked key no longer authenticates anything.

### `POST /api/auth/users/:id/keys`

Body `{"label": "ci runner"}`. Label is optional and defaults to `API key`; over 64 characters is `400`.

Returns `201` with the same shape as a list entry, including the key string. Nothing is hidden afterwards, so there is no "copy it now" moment to miss.

### `POST /api/auth/users/:id/keys/:keyId/revoke`

Kills the key, keeps the record. Returns `{"revoked": true}`, or `{"revoked": false}` if it was already revoked. The key returns `401` on the next request.

### `DELETE /api/auth/users/:id/keys/:keyId`

Removes the record. Returns `{"deleted": true}`.

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
