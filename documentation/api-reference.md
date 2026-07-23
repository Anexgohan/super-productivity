# sp-bridge REST API Reference

The complete endpoint contract for the containerized Super Productivity API
(`sp-bridge`, v1 — **40 routes**). For the concepts behind it — the op-log, why
boards are tags, what the Today list is — read
[`super-productivity-explainer.md`](./super-productivity-explainer.md) first.

---

## Conventions

**Base URL** — `http://<host>:<SP_BRIDGE_PORT>` (default port `18232`).

**Auth** — every route except `GET /api/health` and `GET /api/docs` requires the
key from `SP_BRIDGE_API_KEY`, in either header form:

```
Authorization: Bearer <key>
X-Api-Key: <key>
```

Missing or wrong key → `401 {"error":"Unauthorized"}`.

**Content type** — send `Content-Type: application/json` on requests **that have
a body**. Do *not* send it on bodyless `DELETE`s; the server rejects an empty
body declared as JSON (`400 FST_ERR_CTP_EMPTY_JSON_BODY`).

**Errors** — a uniform shape: `{"error": "<message>"}` with the status code.

| Code | Meaning |
|---|---|
| `400` | bad input — missing/invalid field, unwritable field, unknown reference |
| `401` | missing or invalid API key |
| `404` | entity not found |
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
*Replaces MCP `check_connection` / `debug_directories`.*

### `POST /api/sync/refresh`
Forces an immediate op-log pull instead of waiting for the next poll. Returns the
same body as `/api/status`. No request body.

---

## Reading tasks

### `GET /api/tasks`
Lists tasks. All filters are query parameters and combine with AND.

| Filter | Type | Notes |
|---|---|---|
| `isDone` | `true`/`false` | completion state |
| `projectId` | string | tasks in one project |
| `tagId` | string | tasks carrying a tag — **use this to read a Kanban column** |
| `dueDay` | `YYYY-MM-DD` | exact due date |
| `parentId` | string \| `null` | `null` (literal string) = top-level only |
| `search` | string | case-insensitive match on title *and* notes |
| `overdue` | `true` | not done and due before today |
| `unscheduled` | `true` | no due date, not on Today, not on the Planner |
| `plannedForToday` | `true` | on the Today list, or due today |
| `parentsOnly` | `true` | excludes subtasks |
| `recurringOnly` | `true` | only tasks from a repeat config |
| `today` | `YYYY-MM-DD` | overrides "today" for the date-relative filters above |
| `fields` | comma list | project only these fields (`id` always included) |

```bash
# overdue, trimmed to the fields an agent actually needs
curl -H "X-Api-Key: $KEY" \
  "http://host:18232/api/tasks?overdue=true&fields=title,dueDay"

# everything currently in the In Progress Kanban column
curl -H "X-Api-Key: $KEY" \
  "http://host:18232/api/tasks?tagId=KANBAN_IN_PROGRESS"
```
*Replaces MCP `get_tasks` (including its advanced filters).*

### `GET /api/tasks/:id`
One task by id. `404` if unknown.

### `GET /api/current-task`
Always returns `null` with an explanatory note — the active task is device-local
UI state that never syncs, so a headless peer has none. Documented rather than
faked.

```json
{ "currentTask": null, "note": "No active task: the headless bridge tracks no running timer..." }
```
*Replaces MCP `get_current_task`.*

### `GET /api/task-repeat-cfgs`
Lists recurring-task configurations. *Replaces MCP `get_task_repeat_cfgs`.*

### `GET /api/planner`
The future-day scheduling board: `{ "YYYY-MM-DD": ["taskId", ...] }`.

### `GET /api/worklog`
Time spent per day, aggregated from `timeSpentOnDay` across tasks.

| Query | Type |
|---|---|
| `from` | `YYYY-MM-DD` (inclusive) |
| `to` | `YYYY-MM-DD` (inclusive) |

```json
{ "2026-07-21": { "totalTimeSpent": 5400000,
                  "tasks": [{ "id": "...", "title": "...", "timeSpent": 5400000 }] } }
```
*Replaces MCP `get_worklog`.*

---

## Reading other entities

### `GET /api/projects`
All projects. *Replaces MCP `get_projects`.*

### `GET /api/tags`
All tags, including `color` and `icon`. *Replaces MCP `get_tags`.*

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

| Field | Required | Notes |
|---|---|---|
| `title` | ✅ | |
| `projectId` | | defaults to `INBOX_PROJECT`; must exist |
| `notes`, `timeEstimate`, `tagIds`, `dueDay`, `dueWithTime` | | |

```bash
curl -H "X-Api-Key: $KEY" -H "Content-Type: application/json" \
  -X POST http://host:18232/api/tasks \
  -d '{"title":"Write the deploy runbook","projectId":"N_rey...","timeEstimate":3600000}'
```

> **Note:** a task created through the API lands in its **project**, not on the
> Today list. Put it on Today explicitly with `POST /api/today/plan`.

*Replaces MCP `create_task`.*

### `POST /api/tasks/from-syntax`
Creates a task from a single short-syntax string. → `201`.

| Token | Effect |
|---|---|
| `#tag` | adds the tag — **created automatically if it doesn't exist** |
| `+Project` | moves to that project **by title**; must already exist (else `400`) |
| `@today` \| `@tomorrow` \| `@YYYY-MM-DD` | sets `dueDay` |
| `1h` / `30m` / `1h30m` | sets `timeEstimate` (bare token) |

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

*Replaces MCP `update_task`.*

### `POST /api/tasks/:id/complete`
Marks done, setting `doneOn` to now. No body.
*Replaces MCP `complete_task`.*

### `POST /api/tasks/:id/complete-on`
Marks done with an explicit completion date, so the card sorts on the intended
day. Body: `{"doneOn": "YYYY-MM-DD"}` (other formats → `400`).
*Replaces MCP `complete_task_on`.*

### `DELETE /api/tasks/:id`
Deletes a task. Returns `{"deleted": "<id>"}`.

**Guard:** `409` if the task still has live subtasks — delete them first. (Stale
ids for already-deleted children do not block the parent.) Deletion also detaches
the task from its parent, project lists, tag lists, and the Planner.

```bash
curl -H "X-Api-Key: $KEY" -X DELETE http://host:18232/api/tasks/<id>
```
*Replaces MCP `delete_task`.*

---

## Bulk operations

Both routes build one operation per task and upload them together — cheaper and
more consistent than looping single calls.

### `POST /api/tasks/bulk/complete`
Body: `{"taskIds": ["id1","id2"]}` → `{"completed":[...]}`.
*Replaces MCP `bulk_complete_tasks`.*

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
*Replaces MCP `bulk_update_tasks`.*

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
*Replaces MCP `create_task_with_subtasks`.*

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

*Replaces MCP `reparent_task`.*

### `POST /api/tasks/reorder`
Reorders one list. Body: `taskIds` plus **exactly one** container:

| Container | Reorders |
|---|---|
| `{"projectId": "..."}` | the project's task list |
| `{"parentId": "..."}` | that parent's subtasks |
| `{"today": true}` | the Today list |

`taskIds` must be a **permutation of the list's current members** — reorder only,
no adds or removals (otherwise `400`). Zero or multiple containers → `400`.

```bash
curl -H "X-Api-Key: $KEY" -H "Content-Type: application/json" \
  -X POST http://host:18232/api/tasks/reorder \
  -d '{"parentId":"<parent>","taskIds":["c","b","a"]}'
```
*Replaces MCP `reorder_tasks`.*

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
*Replaces MCP `add_tag_to_task`.*

### `DELETE /api/tasks/:id/tags/:tagId`
Removes one tag, preserving the rest. Idempotent.
*Replaces MCP `remove_tag_from_task`.*

### `POST /api/tasks/:id/move`
Moves a top-level task to another project, updating both projects' lists. Body:
`{"projectId": "..."}`. Subtasks cannot be moved directly (`400`) — they follow
their parent.

*Replaces MCP `move_task_to_project`.*

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
*Replaces MCP `plan_tasks_for_today`.*

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
*Replaces MCP `add_link_to_task`.*

### `POST /api/tasks/:id/issue-link`
Links a task to an external issue so the issue panel recognizes it.

| Field | Required |
|---|---|
| `issueId` | ✅ |
| `issueType` | ✅ (e.g. `GITHUB`) |
| `issueProviderId` | ✅ — must be a configured provider (else `400`) |
| `issuePoints` | |

Find provider ids via `GET /api/entities/ISSUE_PROVIDER`.
*Replaces MCP `link_task_to_issue`.*

---

## Tags

### `POST /api/tags`
Creates a tag. → `201`. Body: `{"title": "...", "icon": "...", "color": "#rrggbb"}`.
*Replaces MCP `create_tag`.*

### `PATCH /api/tags/:id`
Updates a tag. Writable: `title`, `color`, `icon`. Changing `color` also syncs the
tag's theme so the UI recolors.
*Replaces MCP `update_tag`.*

### `DELETE /api/tags/:id`
Deletes a tag and **cascades**: it is stripped from every task that carried it.
The virtual `TODAY` tag is protected (`400`).

---

## Projects

### `POST /api/projects`
Creates a project. → `201`. Body:
`{"title": "...", "color": "#rrggbb", "isEnableBacklog": false}`.
*Replaces MCP `create_project`.*

### `PATCH /api/projects/:id`
Updates a project. Writable: `title`, `isEnableBacklog`, `isArchived`.
*Replaces MCP `update_project`.*

### `DELETE /api/projects/:id`
Deletes a project **and all of its tasks** (including subtasks) and notes, as one
delete-wins operation so it cannot be resurrected by a stale peer.

Returns `{"deleted": "<id>", "taskCount": <n>}`. `INBOX_PROJECT` is protected
(`400`).

> ⚠️ Destructive and not undoable through the API. The task set is derived by
> scanning every task's `projectId`, so it is accurate even if ordering lists are
> stale.

---

## Not available (by design)

These MCP tools have no API equivalent because they describe device-local or
desktop-only behaviour. The API reports their absence rather than simulating it.

| MCP tool | Why not | Use instead |
|---|---|---|
| `start_task` / `stop_task` | running timer is local UI state | set `timeSpent` via `PATCH /api/tasks/:id` |
| `show_notification` | desktop UI action | — |
| `get_current_task` | never syncs | `GET /api/current-task` (returns `null` + note) |
| `check_connection`, `debug_directories` | MCP transport diagnostics; transport is gone | `GET /api/health`, `GET /api/status` |
