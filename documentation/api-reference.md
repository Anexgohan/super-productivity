<!--
EDITING THIS FILE: a working contract for admins and users, not a design doc. Keep it scannable.
One or two lines per route: params, response, status codes, and guards that fail a call or damage a board. No multi-paragraph blocks.
Rationale, history and internal names belong in super-productivity-explainer.md, linked by anchor. Unbuilt intent is a one-line "Not true yet." plus a link.
Never use em-dashes or en-dashes, here or anywhere: a hyphen, comma or colon instead. Repo-wide.
Never hard-wrap prose: one line per paragraph, the editor soft-wraps. Also repo-wide.
Routes live in packages/sp-bridge/src/{rest.ts,auth/routes.ts}; GET /api/docs is the live map and wins over this file.
-->

# sp-bridge REST API Reference

The complete endpoint contract for the containerized Super Productivity API (`sp-bridge`, v1): **62 data routes** plus **23 account routes**.

For the concepts behind it, the op-log, why boards are tags, and what the Today list is, read [`super-productivity-explainer.md`](./super-productivity-explainer.md) first.

---

## Conventions

**Base URL** - `http://<host>:<SP_WEB_PORT>/api` (default port `18230`). The bridge is **not published on a port of its own**: nginx serves the app at `/`, the sync server at `/sync/` and the bridge at `/api/`, all on the one published port. Any older note describing a separate bridge port predates that unification and points at a closed port.

**Content type** - send `Content-Type: application/json` on requests **that have
a body**. Do _not_ send it on bodyless `DELETE`s; the server rejects an empty
body declared as JSON (`400 FST_ERR_CTP_EMPTY_JSON_BODY`).

**Errors** - a uniform shape: `{"error": "<message>"}` with the status code. When a refusal has reasons to name, such as which input field is wrong or which rule of the app's validation a change breaks, they come as `errors`, a list of strings. The values you sent are never echoed back.

| Code  | Meaning                                                                               |
| ----- | ------------------------------------------------------------------------------------- |
| `400` | bad input - missing/invalid field, unwritable field, unknown reference                |
| `401` | missing or invalid credential                                                         |
| `403` | authenticated but not allowed - read-only role, or somebody else's account            |
| `404` | entity not found                                                                      |
| `409` | refused by a safety guard (e.g. deleting a task that still has subtasks)              |
| `503` | the board cannot answer right now; the message says why (`appRules` in `/api/status`) |
| `507` | sync storage is full; nothing was saved (`SYNC_STORAGE_LIMIT`)                        |

**Freshness** - reads reflect the last op-log poll (default 15s). Call
`POST /api/sync/refresh` first if you need guaranteed-current data. Writes
round-trip through the sync server before returning, so the returned entity is
the settled result.

**IDs** - task/tag/project ids are 21-character nanoids. Two are fixed and
well-known: project `INBOX_PROJECT` and tag `TODAY`.

**Writable task fields** - `title`, `notes`, `isDone`, `doneOn`, `timeEstimate`,
`timeSpent`, `projectId`, `tagIds`, `dueDay`, `dueWithTime`. Any other field in a
`PATCH` body is rejected with `400`. (Structural changes - parent, subtasks,
ordering, attachments - have their own endpoints.)

---

## Authentication

Two credentials reach this API, and both resolve to the same thing - a **user**. Which one you present changes nothing about what you are allowed to do; your account's role decides that either way.

| Credential         | How it is sent                                      | Who uses it     |
| ------------------ | --------------------------------------------------- | --------------- |
| **API key**        | `Authorization: Bearer <key>` or `X-Api-Key: <key>` | scripts, agents |
| **Session cookie** | set by `POST /api/auth/login`, `httpOnly`           | the web app     |

If a request carries both, the key is tried first and wins. Two different `401`s, because the causes differ:

| You sent          | Response                                                                               |
| ----------------- | -------------------------------------------------------------------------------------- |
| nothing           | `No API key or session. Send your key as X-Api-Key, or sign in.`                       |
| a key that failed | `That API key is not valid or has been revoked. Check Settings > Accounts > API keys.` |

### What each credential reaches

| Surface                                                                                          | API key              | Session |
| ------------------------------------------------------------------------------------------------ | -------------------- | ------- |
| Data routes - `/api/tasks`, `/projects`, `/tags`, `/boards`, `/today`, `/status`, …              | ✅                   | ✅      |
| Account routes - `/api/auth/*` (the 17 credentialed ones)                                        | ✅                   | ✅      |
| `/api/health`, `/api/docs`, `/login`, `/api/auth/login｜setup｜logout｜status｜verify｜register` | no credential needed |         |

One exception: `POST /api/auth/viewing` is session-only, because it stores a choice in your login session. Use [`?boardOf=`](#reading-someone-elses-board) instead, which does the same job per request.

### Roles

Three roles, applied identically to both credentials:

| Role       | Own board and account | Other accounts                   |
| ---------- | --------------------- | -------------------------------- |
| `admin`    | full                  | full - user and key management   |
| `operator` | full                  | none                             |
| `viewer`   | read-only             | read-only, published boards only |

A `viewer` gets `403 {"error":"Your account is read-only. An admin can change your role.","role":"viewer"}` on any write, whichever credential it used. Role is read fresh from the database on every request, so a demotion bites immediately.

### Calls that also want your password

Handing out or widening access needs your account password as well, but only when you are using an API key. A session already proved who you are; a stolen key must not be able to mint another one. Add `currentPassword` to the body:

| Call                                          | Why                         |
| --------------------------------------------- | --------------------------- |
| `POST /api/auth/users/:id/keys`               | mints a credential          |
| `DELETE /api/auth/users/:id/keys/:keyId`      | removes one                 |
| `POST /api/auth/users/:id/keys/:keyId/revoke` | removes one                 |
| `PUT /api/auth/users/:id/public`              | exposes a board             |
| `PUT /api/auth/users/:id` **with `role`**     | changes what someone may do |
| `POST /api/import`                            | replaces a whole board      |

Without it: `403 {"error":"This also needs your account password when using an API key. Add currentPassword to the body."}`. Wrong password: `403 {"error":"That password is not correct."}`.

The import is the one exception to the body field: its body is the backup file, so send the password as the `X-Current-Password` header, and a missing one is refused with `... Send it in the X-Current-Password header.`

The rule follows the route a request reaches, however its path is spelled: `/api/%69mport` is the import and wants the password too.

Renaming somebody or fixing their email on `PUT /api/auth/users/:id` needs nothing extra, because neither widens access. Reading keys is deliberately ungated: an admin holding a subordinate's key is how delegated management works here.

### Key format

`spk_<keyId>_<digest>`, **derived not stored**: `HMAC(JWT_SECRET, "api-key:v1:<userId>:<keyId>:<salt>:<version>")`. Re-readable at any time, so there is no "copy it now" moment. [Why derived](./super-productivity-explainer.md#talking-to-the-api).

⚠️ The middle number is the **key** id in base36, not the user id - do not parse a key to learn whose it is. Key id `42` renders as `spk_16_`.

A key has **no role of its own**: it inherits its owner's, read per request. So a non-admin can only create keys for itself, and only an admin can create one for somebody else.

Wrong keys from one address get a small added delay; a correct key is never refused by it.

### Reading someone else's board

Every route acts on your own board. Add `?boardOf=<accountId>` to read a board its owner has shared. [`GET /api/auth/public-boards`](#get-apiauthpublic-boards) lists the ones available to you.

```bash
curl -H "X-Api-Key: $KEY" "$BASE/tasks?boardOf=2"
```

It works on every data route, and passing your own id is the same as omitting it.

**Shared boards are read-only, for everyone.** Sharing grants a look, never a hand, and rank does not change that: an admin on an operator's board is a reader there like anybody else.

| Situation                 | Response                                                                         |
| ------------------------- | -------------------------------------------------------------------------------- |
| writing to a shared board | `403 That board belongs to someone else. Sharing grants a read, not a write.`    |
| the board is not shared   | `403 That board is not shared. Its owner can share it from Settings > Accounts.` |
| no such account           | `404 No account with id 99.`                                                     |
| not a number              | `400 boardOf must be an account id, like ?boardOf=2.`                            |

Sharing is all-or-nothing and applies to everyone signed in, not only to viewers. It is re-checked on every request, so unsharing takes effect on the next call.

---

## Route index

**Service** · [health](#get-apihealth) · [docs](#get-apidocs) · [status](#get-apistatus) · [sync/refresh](#post-apisyncrefresh)

**Reading tasks** · [list](#get-apitasks) · [single](#get-apitasksid) · [current-task](#get-apicurrent-task) · [repeat-cfgs](#get-apitask-repeat-cfgs) · [planner](#get-apiplanner) · [worklog](#get-apiworklog)

**Reading other** · [projects](#get-apiprojects) · [tags](#get-apitags) · [config](#get-apiconfig) · [entities](#get-apientities) · [entities/:type](#get-apientitiestype)

**Archive** · [list](#get-apiarchivetasks) · [single](#get-apiarchivetasksid)

**Notes** · [list](#get-apinotes) · [single](#get-apinotesid) · [create](#post-apinotes) · [update](#patch-apinotesid) · [delete](#delete-apinotesid)

**App actions** · [list](#get-apiactions) · [run](#post-apiactionsname)

**Recurring tasks** · [make recurring](#post-apitasksidrepeat-cfg) · [update](#patch-apitask-repeat-cfgsid) · [delete](#delete-apitask-repeat-cfgsid)

**Task lifecycle** · [create](#post-apitasks) · [from-syntax](#post-apitasksfrom-syntax) · [update](#patch-apitasksid) · [complete](#post-apitasksidcomplete) · [complete-on](#post-apitasksidcomplete-on) · [delete](#delete-apitasksid)

**Bulk** · [bulk complete](#post-apitasksbulkcomplete) · [bulk update](#post-apitasksbulkupdate)

**Hierarchy** · [with-subtasks](#post-apitaskswith-subtasks) · [add subtask](#post-apitasksidsubtasks) · [reparent](#post-apitasksidreparent) · [reorder](#post-apitasksreorder)

**Tags on tasks (Kanban)** · [add tag](#post-apitasksidtags) · [remove tag](#delete-apitasksidtagstagid) · [move project](#post-apitasksidmove)

**Today list** · [plan](#post-apitodayplan) · [remove](#post-apitodayremove)

**Links & issues** · [add link](#post-apitasksidlinks) · [issue link](#post-apitasksidissue-link)

**Tags** · [create](#post-apitags) · [update](#patch-apitagsid) · [delete](#delete-apitagsid)

**Projects** · [create](#post-apiprojects) · [update](#patch-apiprojectsid) · [delete](#delete-apiprojectsid)

**Export and import** · [export](#get-apiexport) · [import](#post-apiimport)

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

The body also carries an `appRules` block for the board: `state` (`starting`, `loading`, `ready` or `unavailable`), `seq` (the last server change applied), `droppedOps` (changes a browser drops as outdated by a full import), `reducerFailures`, `archiveFailures`, the worker's memory (`heapUsedMb`), and `error` when the board cannot answer. While `state` is not `ready`, every other route on that board answers `503` with the same reason, and `entityCounts` is empty.

`writesClosed` is `null`, or why API writes to the board answer `409` for now: an [import](#post-apiimport) replaced it and the board has not read it back yet, or an import got no answer from the sync server. It clears on the board's next successful sync.

A `checkpoint` block says when the bridge last checkpointed the board: `lastFullStateSeq` (the newest full state in its history), `changesSince` and `bytesSince`, `lastWrittenAt` and `lastAttemptAt` (ms since epoch, `0` if never), `lastError` (why the last attempt was refused, or `null`) and `countsComplete` (`false` until the counters reach back to a full state).

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
| `tagId`           | string           | tasks carrying a tag - **use this to read a Kanban column** |
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

### `GET /api/task-repeat-cfgs`

Lists recurring-task configurations.task*repeat_cfgs`.*

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

---

## Reading other entities

### `GET /api/projects`

All projects.projects`.\_

### `GET /api/tags`

All tags, including `color` and `icon`.tags`.\_

### `GET /api/config`

Global configuration, keyed by section.

### `GET /api/entities`

Lists every entity type available for raw access.

### `GET /api/entities/:type`

Raw entity map for one type (`TASK`, `TAG`, `PROJECT`, `BOARD`, `PLANNER`, `ISSUE_PROVIDER`, …). This is the escape hatch for anything the typed endpoints don't expose - e.g. reading a board's `includedTagIds`.

A type only exists once the board has data of that kind, so `404` here means "none yet" rather than "no such type". `GET /api/entities` lists what this board actually has.

```bash
# which tag drives each Kanban column
curl -H "X-Api-Key: $KEY" http://host:18230/api/entities/BOARD
```

---

## Archive

Completed tasks are swept into the archive **daily**, so `GET /api/tasks?isDone=true` only ever shows what was finished since the last sweep. Anything older is here. Read-only: the archive is written by the app's own lifecycle, not by callers.

### `GET /api/archive/tasks`

Archived tasks, **newest completion first**, capped at **500** by default.

| Param                | Meaning                                            |
| -------------------- | -------------------------------------------------- |
| `from`, `to`         | YYYY-MM-DD, inclusive, on the day it was completed |
| `projectId`, `tagId` | same meaning as on `/api/tasks`                    |
| `search`             | matches title or notes                             |
| `fields`             | comma-separated projection; `id` always returned   |
| `limit`              | whole number; overrides the default 500            |

The cap is a guard, not pagination: the archive grows without bound, and narrowing with `from`/`to` is the intended way to ask for more. Tasks with no recorded completion date are excluded whenever `from` or `to` is given, and sort last otherwise.

```bash
# what did this account finish last week
curl -H "X-Api-Key: $KEY" "http://host:18230/api/archive/tasks?from=2026-07-20&to=2026-07-26&fields=title,doneOn"
```

Honours [`?boardOf=`](#reading-someone-elses-board), so a shared board exposes its completed history as well as its current tasks.

### `GET /api/archive/tasks/:id`

Single archived task. `404` if it is not in the archive - it may still be a live task, in which case use [`GET /api/tasks/:id`](#get-apitasksid).

---

## Notes

Standalone notes, the ones in the app's notes panel. Per-task text is the `notes` field on a task and is unrelated to these.

### `GET /api/notes`

All notes. `?projectId=<id>` narrows to one project; `?projectId=null` returns the notes that belong to no project.

### `GET /api/notes/:id`

Single note. `404` if unknown.

### `POST /api/notes`

Body: `{content (required), projectId?, isPinnedToToday?, backgroundColor?, imgUrl?}`. Omitting `projectId` creates a global note. `400` on an unknown `projectId`. → `201` with the created note.

### `PATCH /api/notes/:id`

Writable: `content`, `isPinnedToToday`, `backgroundColor`, `imgUrl`, `isLock`, `projectId`. Anything else → `400`. `modified` is stamped for you.

### `DELETE /api/notes/:id`

→ `{"deleted": "<id>"}`. Also removes it from its project and from the today ordering.

---

## App actions

An app action is a change made the way the app makes it: the bridge runs the app's own code for it, the same code a browser runs, and uploads what that code saves. That includes the follow-up changes the app makes on its own. For example, marking the last open subtask done also completes its parent when the board's "mark parent as done" setting is on, and making a task recurring also schedules it. Every change of one action goes up in one upload, so the API never saves half of what a browser would.

Before anything is uploaded, the result is checked with the app's full validation. A change that would leave the board invalid is refused with `409` and the broken rules in `errors`; a board that was already invalid stays writable, and only what the change itself breaks counts.

| Action                      | Input                                                                           | What it does, as in the app                                                                                                                                |
| --------------------------- | ------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `deleteTasks`               | `{taskIds: string[]}`                                                           | deletes the tasks with their subtasks, as the multi-select delete                                                                                          |
| `deleteTask`                | `{taskId}`                                                                      | deletes the task with its subtasks, as the task's delete button                                                                                            |
| `updateTask`                | `{taskId, changes: {title?, notes?, isDone?, timeEstimate?}}`                   | edits the task; marking it done sets its done date, drops its reminders and may complete its parent                                                        |
| `updateManyTasks`           | `{updates: [{taskId, changes}]}`, 1 to 100, `changes` as in `updateTask`        | edits each task as `updateTask` does, in one upload; any refusal uploads nothing                                                                           |
| `addTaskRepeatCfgToTask`    | `{taskId, ...}` with the fields of [make recurring](#post-apitasksidrepeat-cfg) | makes the task recurring, as the repeat dialog                                                                                                             |
| `updateGlobalConfigSection` | `{sectionKey, changes}`                                                         | saves the given settings of one section, as the settings page; see below                                                                                   |
| `moveToArchive`             | `{taskIds: string[]}`                                                           | archives top-level tasks with their subtasks; a subtask `400`                                                                                              |
| `restoreTask`               | `{taskId}`                                                                      | restores an archived top-level task with its subtasks, as the history page; not archived `404`, on the board `409`, an archived subtask `400`              |
| `scheduleTaskWithTime`      | `{taskId, at, remind?, isMoveToBacklog?}`                                       | schedules the task at a time, as the schedule dialog; also a reschedule                                                                                    |
| `unscheduleTask`            | `{taskId}`                                                                      | removes the task's day or time, as the schedule dialog's remove                                                                                            |
| `setDeadline`               | `{taskId, day}` or `{taskId, at, remind?}`                                      | sets a deadline, as the deadline dialog; one due today plans the task for today                                                                            |
| `removeDeadline`            | `{taskId}`                                                                      | removes the deadline                                                                                                                                       |
| `planTaskForDay`            | `{taskId, day}`                                                                 | plans the task for a day without a time; a task already planned for that day changes nothing                                                               |
| `planTasksForToday`         | `{taskIds: string[]}`                                                           | adds the tasks to Today on the action's day                                                                                                                |
| `removeTasksFromTodayTag`   | `{taskIds: string[]}`                                                           | takes the tasks off Today                                                                                                                                  |
| `logTime`                   | `{taskId, date?, duration}`                                                     | adds time worked on a day (default: the action's day), as the idle dialog; another device's tracking on the same day adds up                               |
| `removeTimeSpent`           | `{taskId, date?, duration}`                                                     | removes time from a day; more than the day holds `409`                                                                                                     |
| `addSection`                | `{title, projectId}` or `{title, today: true}`                                  | adds a section to a project or to Today; `refs.sectionId` names it                                                                                         |
| `updateSection`             | `{sectionId, title}`                                                            | renames the section                                                                                                                                        |
| `deleteSection`             | `{sectionId}`                                                                   | deletes the section; its tasks stay in their list                                                                                                          |
| `addTaskToSection`          | `{sectionId, taskId, afterTaskId?}`                                             | moves a top-level task of the section's project (or of Today) into the section, out of any other; after `afterTaskId`, `null` for the top, default the end |
| `removeTaskFromSection`     | `{sectionId, taskId, afterTaskId?}`                                             | moves the task out of the section into the tasks outside sections; after `afterTaskId`, default the top                                                    |
| `archiveProject`            | `{projectId}`                                                                   | archives the project; the Inbox `400`                                                                                                                      |
| `unarchiveProject`          | `{projectId}`                                                                   | unarchives the project and reopens it if it was completed; the Inbox `400`                                                                                 |

Times (`at`) are ISO times with their offset, durations are in ms, days are `YYYY-MM-DD`. `remind` is one of `DoNotRemind`, `AtStart`, `m5`, `m10`, `m15`, `m30`, `h1`; without it a task that already has a time and reminder keeps the reminder's offset, and any other task takes the board's default reminder.

`updateGlobalConfigSection` takes any section of `GET /api/config` except `sync`, and only the settings that section has by default: anything else, such as `misc.uiPrefs`, is refused with `400`, and a wrong type with `409`. Only the given settings are saved, so another device's change to a different setting of the section is kept. Moving the start of the day (`misc.startOfNextDayTime`) also moves the tasks planned for the old today to the new today, as the app does.

Inputs take ids and the fields listed, nothing else: anything more is refused with `400`, so no call can send a malformed entity. The bridge fills in the rest from the board, as the app does. An input only ever gains fields, so a call that works now keeps working.

### `GET /api/actions`

Lists every action with its input as JSON Schema, and the schema of `when`. Readers may call it.

### `POST /api/actions/:name`

Runs one action on your own board. Body: `{"input": {...}, "when": {...}}`. → `{"opIds": [...], "refs": {...}}`: the ids of the uploaded changes, in order, and the ids the action created (`taskRepeatCfgId` for a new config, `sectionId` for a new section).

`when` is optional and says what time the action happens at, for the rules that depend on the day:

| `when`                                 | The action runs as if it were        |
| -------------------------------------- | ------------------------------------ |
| absent or `{}`                         | now, in the container's time zone    |
| `{"today": "YYYY-MM-DD"}`              | that day, at the current time of day |
| `{"now": "2031-03-03T09:30:00+01:00"}` | that moment; the offset is required  |

The day counts from the board's "start of next day" setting, as in the app. The time stamped on each uploaded change is always the container's real clock, whatever `when` says.

`400` bad input or `when`, with the wrong fields in `errors` · `404` unknown action or task · `409` refused by the app's rules or validation, or the board is being imported · `501` a follow-up the container cannot make yet (changing archived tasks, for one), so nothing is saved.

```bash
curl -H "X-Api-Key: $KEY" -H "Content-Type: application/json" \
  -X POST http://host:18230/api/actions/deleteTasks \
  -d '{"input":{"taskIds":["<id>","<id>"]}}'
```

---

## Recurring tasks

Reading is [`GET /api/task-repeat-cfgs`](#get-apitask-repeat-cfgs).

### `POST /api/tasks/:id/repeat-cfg`

Makes an existing task recurring. There is no route that creates a config on its own, because the app has no such action either: a config always describes how a particular task repeats. It runs the [`addTaskRepeatCfgToTask`](#app-actions) app action, so the result is what the app's repeat dialog saves.

Body, all optional: `{repeatCycle: DAILY|WEEKLY|MONTHLY|YEARLY, repeatEvery, startDate, startTime, monday…sunday, defaultEstimate, notes, tagIds, order, isPaused, repeatFromCompletionDate, waitForCompletion}`. Anything you leave out takes the dialog's default for a new config: weekly, every 1, Monday to Friday, starting on the task's due day (or today), with the task's title, notes, tags and estimate. The project always comes from the task.

What the app does next happens too, in the same upload: the task is scheduled for its first occurrence (its due day, and its created date moved to that day so no second instance is made), the task's subtasks become the config's subtask templates, and the config's title, tags and estimate are written onto the task.

`404` if the task is unknown · `409` if it already repeats, or if the app's validation refuses the result (an unknown tag in `tagIds`, for one) · `400` on an unknown field or value, naming it in `errors`. → `201` with the config.

The monthly Nth-weekday and last-day anchors and the reminder options are deliberately not settable here: their rules are interdependent, and a malformed pair silently changes the recurrence. Set those in the UI.

### `PATCH /api/task-repeat-cfgs/:id`

Same writable fields. `title` and `projectId` are not among them.

### `DELETE /api/task-repeat-cfgs/:id`

Stops future instances. → `{"deleted": "<id>"}`. Tasks already created from it are left alone and keep pointing at the deleted config, exactly as in the UI.

---

## Task lifecycle

### `POST /api/tasks`

Creates a task. → `201` with the created task.

| Field                                                      | Required | Notes                                   |
| ---------------------------------------------------------- | -------- | --------------------------------------- |
| `title`                                                    | ✅       |                                         |
| `projectId`                                                |          | defaults to `INBOX_PROJECT`; must exist |
| `notes`, `timeEstimate`, `tagIds`, `dueDay`, `dueWithTime` |          | `notes` is only written when given      |

```bash
curl -H "X-Api-Key: $KEY" -H "Content-Type: application/json" \
  -X POST http://host:18230/api/tasks \
  -d '{"title":"Write the deploy runbook","projectId":"N_rey...","timeEstimate":3600000}'
```

> **Note:** a task created through the API lands in its **project**, not on the
> Today list. Put it on Today explicitly with `POST /api/today/plan`.

### `POST /api/tasks/from-syntax`

Creates a task from a single short-syntax string. → `201`.

| Token                                    | Effect                                                              |
| ---------------------------------------- | ------------------------------------------------------------------- |
| `#tag`                                   | adds the tag - **created automatically if it doesn't exist**        |
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

Each field is saved as the app saves it, through the [app actions](#app-actions), all in one upload:

| Field                                      | Saved as                                                                                          |
| ------------------------------------------ | ------------------------------------------------------------------------------------------------- |
| `title`, `notes`, `isDone`, `timeEstimate` | `updateTask`, with its follow-ups                                                                 |
| `dueWithTime` (ms)                         | `scheduleTaskWithTime` at that time                                                               |
| `dueDay`                                   | `planTaskForDay`                                                                                  |
| `dueDay` or `dueWithTime` `null`           | `unscheduleTask`                                                                                  |
| `timeSpent` (the new total)                | the difference as `logTime` or `removeTimeSpent` on today; removing more than today holds → `409` |
| `doneOn`, `projectId`, `tagIds`            | a plain update, after the actions                                                                 |

`dueDay` and `dueWithTime` together → `400`: a task has one or the other.

### `POST /api/tasks/:id/complete`

Marks done, setting `doneOn` to now. No body.

### `POST /api/tasks/:id/complete-on`

Marks done with an explicit completion date, so the card sorts on the intended
day. Body: `{"doneOn": "YYYY-MM-DD"}` (other formats → `400`).

### `DELETE /api/tasks/:id`

Deletes a task, built by the app's own code as its delete button does ([`deleteTask`](#app-actions)). Returns `{"deleted": "<id>"}`.

**Guard:** `409` if the task still has live subtasks - delete them first. (Stale
ids for already-deleted children do not block the parent.) Deletion also detaches
the task from its parent, project lists, tag lists, and the Planner.

```bash
curl -H "X-Api-Key: $KEY" -X DELETE http://host:18230/api/tasks/<id>
```

---

## Bulk operations

Both routes save each task as [`PATCH /api/tasks/:id`](#patch-apitasksid) does and upload every change together, as the app's [`updateManyTasks`](#app-actions) action. Up to 100 tasks per call.

### `POST /api/tasks/bulk/complete`

Body: `{"taskIds": ["id1","id2"]}` → `{"completed":[...]}`. Each task is marked done as `updateTask` does, follow-ups included (a parent whose last open subtask is done, a reminder dropped).

### `POST /api/tasks/bulk/update`

Body: `{"updates":[{"id":"id1","title":"New","isDone":true}, ...]}` - each entry
is an id plus the writable fields to change. Returns the updated tasks.

**All-or-nothing:** every entry is validated up front; if any id is unknown or
any field unwritable, **nothing is submitted**.

```bash
curl -H "X-Api-Key: $KEY" -H "Content-Type: application/json" \
  -X POST http://host:18230/api/tasks/bulk/update \
  -d '{"updates":[{"id":"a1","timeEstimate":3600000},{"id":"b2","notes":"revised"}]}'
```

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

### `POST /api/tasks/:id/subtasks`

Adds one subtask under an existing top-level task. → `201` with the subtask.
Body: `{"title": "...", "notes": ..., "timeEstimate": ...}`.

Subtasks **inherit the parent's project** and carry no tags of their own.
Nesting under a task that is itself a subtask → `400` (one level only).

### `POST /api/tasks/:id/reparent`

Moves a task in the hierarchy. Body: `{"parentId": "<id>" | null}`.

- `parentId: "<id>"` - nest under that task.
- `parentId: null` - promote to a top-level task.

Refused with `400`/`409` if: the task is already top-level (on promote), the
target is itself a subtask, a task would become its own parent, or the task has
its own subtasks.

### `POST /api/tasks/reorder`

Reorders one list. Body: `taskIds` plus **exactly one** container:

| Container              | Reorders                |
| ---------------------- | ----------------------- |
| `{"projectId": "..."}` | the project's task list |
| `{"parentId": "..."}`  | that parent's subtasks  |
| `{"today": true}`      | the Today list          |

`taskIds` must be a **permutation of the list's current members** - reorder only,
no adds or removals (otherwise `400`). Zero or multiple containers → `400`.

```bash
curl -H "X-Api-Key: $KEY" -H "Content-Type: application/json" \
  -X POST http://host:18230/api/tasks/reorder \
  -d '{"parentId":"<parent>","taskIds":["c","b","a"]}'
```

---

## Tags on tasks - including Kanban moves

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

### `DELETE /api/tasks/:id/tags/:tagId`

Removes one tag, preserving the rest. Idempotent.

### `POST /api/tasks/:id/move`

Moves a top-level task to another project, updating both projects' lists. Body:
`{"projectId": "..."}`. Subtasks cannot be moved directly (`400`) - they follow
their parent.

---

## Today list

### `POST /api/today/plan`

Adds tasks to the Today list, as the app's [`planTasksForToday`](#app-actions) action. Body:
`{"taskIds": ["..."], "today": "YYYY-MM-DD"}` (`today` optional, defaults to the
server's current date). Unknown id → `404`.

```bash
curl -H "X-Api-Key: $KEY" -H "Content-Type: application/json" \
  -X POST http://host:18230/api/today/plan -d '{"taskIds":["a1","b2"]}'
```

### `POST /api/today/remove`

Removes tasks from the Today list, as the app's [`removeTasksFromTodayTag`](#app-actions) action. Body: `{"taskIds": ["..."]}`. Unknown id → `404`.

Read the list back with `GET /api/tasks?plannedForToday=true`.

---

## Links & issues

### `POST /api/tasks/:id/links`

Attaches a link to a task (appended to `attachments`).
Body: `{"url": "https://...", "title": "optional label"}` - `title` defaults to
the URL.

```bash
curl -H "X-Api-Key: $KEY" -H "Content-Type: application/json" \
  -X POST http://host:18230/api/tasks/<id>/links \
  -d '{"url":"https://github.com/org/repo/pull/42","title":"PR #42"}'
```

### `POST /api/tasks/:id/issue-link`

Links a task to an external issue so the issue panel recognizes it.

| Field             | Required                                        |
| ----------------- | ----------------------------------------------- |
| `issueId`         | ✅                                              |
| `issueType`       | ✅ (e.g. `GITHUB`)                              |
| `issueProviderId` | ✅ - must be a configured provider (else `400`) |
| `issuePoints`     |                                                 |

## Find provider ids via `GET /api/entities/ISSUE_PROVIDER`.

## Tags

### `POST /api/tags`

Creates a tag. → `201`. Body: `{"title": "...", "icon": "...", "color": "#rrggbb"}`. Built exactly as the app builds one: without `color` it gets a random preset colour, and `icon` defaults to `null`.

### `PATCH /api/tags/:id`

Updates a tag. Writable: `title`, `color`, `icon`. Changing `color` also syncs the
tag's theme so the UI recolors.

### `DELETE /api/tags/:id`

Deletes a tag and **cascades**: it is stripped from every task that carried it.
The virtual `TODAY` tag is protected (`400`).

---

## Projects

### `POST /api/projects`

Creates a project. → `201`. Body:
`{"title": "...", "color": "#rrggbb", "isEnableBacklog": false}`.

Built exactly as the app's create-project dialog builds one: `color` becomes the theme colour, a random preset colour when omitted, and `icon` is `null`.

### `PATCH /api/projects/:id`

Updates a project. Writable: `title`, `isEnableBacklog`, `isArchived`. `isArchived` runs the app's [`archiveProject` or `unarchiveProject`](#app-actions): unarchiving also reopens a completed project, and the Inbox can't be archived (`400`).

### `DELETE /api/projects/:id`

Deletes a project **and all of its tasks** (including subtasks) and notes. Returns `{"deleted": "<id>", "taskCount": <n>}`. `INBOX_PROJECT` is protected (`400`).

> ⚠️ Destructive, not undoable, and no archive to recover from.

---

## Boards

A board is a Kanban view over tasks you already have. It stores no tasks of its own: each panel is a filter, and a card appears in a column because the task matches that column's filter. See [Boards (Kanban) are tag-driven](./super-productivity-explainer.md#boards-kanban-are-tag-driven) before writing one.

A fresh account reads back the two starter boards (Eisenhower Matrix, Kanban) even though nothing has been stored yet, so the API and the browser agree. **`[]` means the owner deleted every board** - it does not mean "none exist, create one". Creating one with a starter board's id → `409`. [Why](./super-productivity-explainer.md#starter-boards-exist-before-they-are-stored).

### `GET /api/boards`

Every board with its panels. Default boards and panels carry i18n keys as titles (`F.BOARDS.DEFAULT.KANBAN`), resolved by the client at render time; boards you create keep the title you gave them.

### `GET /api/boards/:id`

One board. `404` on an unknown id.

### `POST /api/boards`

Creates a board. → `201`. Body: `{"title": "...", "id": "OPTIONAL_ID", "cols": 3, "panels": [...], "projectIds": ["..."]}`.

`id` is generated when omitted. `cols` defaults to the panel count, so a new board is not born with empty gaps. `409` if the id already exists, including the ids of the starter boards.

`projectIds` is the board's **project scope**: which project the board belongs to. It defaults to `[""]`, the "unassigned" sentinel, which is also what `[""]` mixed with real ids collapses to. See [Board project scope](#board-project-scope) below.

### `PATCH /api/boards/:id`

Updates a board. Writable: `title`, `cols`, `panels`, `projectIds`. `panels` is a **full replacement array** - the panel routes below are conveniences over exactly that.

#### Board project scope

`projectIds` decides whether a board appears in the browser's board strip while the app is scoped to a project, using the same `""` sentinel the panel filter uses:

| Value            | Meaning                                                                   |
| ---------------- | ------------------------------------------------------------------------- |
| `[""]` or absent | Unassigned. Shows only under "All Projects".                              |
| `["p1"]`         | Belongs to `p1`. Shows under All Projects and under `p1`.                 |
| `["p1","p2"]`    | Belongs to both, and shows under either.                                  |
| `["", "p1"]`     | Collapses to `[""]` on write - "All" wins, exactly as it does on a panel. |

A board naming only projects that do not exist stays visible under every scope rather than becoming unreachable. That covers a deleted project and, because project ids are per account, a board read over `?boardOf=` whose scope names the owner's projects rather than yours.

The scope decides which boards the UI lists **and** narrows their contents to the assigned project. `GET /api/boards` always returns every board regardless of it.

Changing `projectIds` resets every column's own project filter to `[""]` and drops card-order entries for tasks outside the new project, so a board moved out of a project keeps nothing of it. Sending `panels` in the same request skips the reset. An unassigned board staying unassigned keeps its per-column split.

### `DELETE /api/boards/:id`

Deletes a board. Returns `{"deleted": "<id>"}`. Deleting every board is allowed and is remembered, per the note above.

### `PUT /api/boards/order`

Reorders boards. Body: `{"ids": ["...", "..."]}`. Must name every board - a partial list is rejected rather than parking the rest at the tail.

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
  "projectIds": [""],
  "sortBy": "dueDate",
  "sortDir": "asc",
  "includedTagsMatch": "all",
  "excludedTagsMatch": "any"
}
```

`sortBy`: `dueDate`, `created`, `title` or `timeEstimate`; omit it for manual card order, and an unknown value is dropped. `includedTagsMatch`: `all` (default) or `any` of the included tags. `excludedTagsMatch`: `any` (default) or `all` of the excluded tags. The same fields work on the columns in `POST /api/boards`.

`taskDoneState`: 1 all, 2 done, 3 undone. `scheduledState`: 1 all, 2 scheduled, 3 not scheduled. `backlogState`: 1 all, 2 no backlog, 3 only backlog. `projectIds: [""]` means all projects, which is the app's own convention rather than a typo.

Only `title` is required. Omitted fields take the same defaults as a column added in the board editor: done and undone tasks (`taskDoneState: 1`), scheduled or not, backlog included (`backlogState: 1`), all projects, no tag filters. Send `taskDoneState: 3` and `backlogState: 2` for a stock Kanban column.

`cols` grows with the panel count. The panel is **appended** - reorder with a `PATCH` on the board.

⚠️ Two things this route will not do for you: exclude the new tag from the columns to its left (without that, a card appears in both), and place a column anywhere but the end.

### `PATCH /api/boards/:id/panels/:panelId`

Updates one column's filters. Writable: everything except `id` and `taskIds`.

### `DELETE /api/boards/:id/panels/:panelId`

Removes a column. Returns `{"deleted": "<panelId>"}`, and `cols` shrinks to match.

⚠️ The tag it filtered on survives, as do any exclusions of that tag on other columns - and a stray exclusion hides matching tasks from every column. Clean those up in the same pass.

### `PUT /api/panels/:panelId/taskIds`

Sets the manual card order inside one column. Body: `{"taskIds": [...]}`. Panel ids are unique across boards, so no board id is needed. Unknown task ids → `400`.

---

## Export and import

The board as the app's own backup file, and back. The file is the one **Settings > Import/Export** downloads, so either side reads the other's.

### `GET /api/export`

Your own board as a backup file, archives included, after a sync; when the sync fails, the board as it last synced. Any role. → the JSON file with `Content-Disposition: attachment; filename="sp-backup_<date>_<time>.json"`.

```bash
curl -H "X-Api-Key: $KEY" -o board.json http://host:18230/api/export
```

Own board only: `?boardOf=` of another account → `403 Export reads only your own board.`

### `POST /api/import`

Replaces a board with a backup file sent as the request body, as the app's own restore does. **Admin only**, and with a key it also wants your password in `X-Current-Password`. The body is read as the file whatever its `Content-Type`. `?boardOf=<accountId>` imports into another account's board, shared or not; it is the one write an admin may make there.

```bash
curl -H "X-Api-Key: $KEY" -H "X-Current-Password: $PW" \
  -X POST --data-binary @board.json "http://host:18230/api/import?boardOf=4"
```

```json
{
  "imported": true,
  "serverSeq": 412,
  "savedBefore": "pre-import.user-4.2026-11-21T10-00-00.000Z.json",
  "migratedLegacy": false,
  "repaired": false,
  "counts": { "tasks": 120, "projects": 4, "tags": 9, "notes": 3, "archivedTasks": 800 },
  "droppedServerChanges": 0,
  "readBack": true
}
```

The file goes through the app's own import steps first: a bare state or the wrapped backup file are both accepted, a pre-v14 file is upgraded, and a damaged one is repaired. One the repair cannot fix, or still leaves invalid, is refused and nothing changes.

⚠️ It is a full restore, not a merge: the board's server history is wiped and replaced. Changes a browser made but has not synced yet are dropped when that browser next syncs. `droppedServerChanges` counts server changes that arrived between the save below and the import, which the import also replaced.

`readBack` is `false` when the board could not read the import back straight away. API writes to it then answer `409` until it has, which the next successful sync does; `writesClosed` in [status](#get-apistatus) says so meanwhile.

**Undo.** Before anything is uploaded the board is saved, and the reply names the file in `savedBefore`. `POST /api/import?saved=<name>` with no body imports it back into the same board. The newest 3 are kept per board, failed attempts included, plus the one an import of unknown outcome saved (below) until it is settled. There is no route that lists them, so keep the name the reply gave you.

**Size.** The body may be up to 30 MB. The file is checked in a short-lived process of its own, with a 256 MB memory cap, apart from the boards in memory. A file whose check needs more than that is refused with `413` before anything is saved or uploaded, and the bridge keeps running. The sync server also caps the stored board at 30 MB compressed and 60 MB uncompressed, and refuses a larger one before anything is wiped.

**No answer.** When the sync server does not answer the upload, it is sent once more as the same change. If that gets no answer either, the reply is `502 {"error", "savedBefore", "outcome": "unknown"}`: the import may or may not have landed, and API writes to the board answer `409` until it next syncs and shows what the server holds. Send the same file again to settle it. The retry is the same change to the server, so it cannot restore twice, and it keeps the first attempt's saved file. Once any attempt got no answer, only an accepted one settles the import: a refusal says only that this attempt stored nothing, so it too answers `502` with `"outcome": "unknown"`, naming the refusal, and writes stay closed. A different file is a new import.

| Situation                                                     | Response                                                                            |
| ------------------------------------------------------------- | ----------------------------------------------------------------------------------- |
| not an admin                                                  | `403`                                                                               |
| password missing or wrong (key only)                          | `403`                                                                               |
| no body, or a body and `?saved=` together, or a bad `?saved=` | `400`                                                                               |
| not JSON                                                      | `400`                                                                               |
| not valid and not repairable, or still invalid after repair   | `422 {"error", "errors": ["$.task.entities.x.title: expected string"]}`, at most 20 |
| `?saved=` names no file of this board, or no such account     | `404`                                                                               |
| another import on the board, or the board is blocked          | `409`                                                                               |
| the sync server refused the import                            | `409 {"error", "savedBefore", "errorCode"}`, the board unchanged                    |
| the sync server answered with another error                   | `502 {"error", "savedBefore"}`, the board unchanged                                 |
| the sync server did not answer, now or on an earlier attempt  | `502 {"error", "savedBefore", "outcome": "unknown"}`, see **No answer**             |
| too large for the import check's memory                       | `413 {"error", "errors"}`, nothing imported                                         |
| over 30 MB                                                    | `413 The file is over the import limit of 30 MB. Nothing was imported.`             |
| over the sync server's limit                                  | `413 {"error", "savedBefore"}`, naming both sizes, the board unchanged              |
| sync storage full                                             | `507 {"error", "savedBefore"}`, the board unchanged                                 |
| the board could not sync or be checked first                  | `503`, nothing imported                                                             |
| the board could not be saved first                            | `500`, nothing imported                                                             |

While an import runs, other writes to that board answer `409 An import is replacing this board. Try again once it has finished.`, and after it, until the board has read the import back, `409` with the reason `writesClosed` gives.

---

## Accounts and keys

Session-only today - an API key is refused with `401`. See [Authentication](#authentication).

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

nginx `auth_request` target: `204` + `X-Auth-User`/`X-Auth-Role`, or bare `401`. Infrastructure - not a route to call.

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

Sets your email - profile data only, never the sync identity. Body `{"email": "..."}`; blank or `null` clears it, no `@` → `400`.

#### `PUT /api/auth/password`

Body `{currentPassword, newPassword}` → `{"ok": true}`. Wrong current → `403`; under 8 characters → `400`. Required even with a valid session.

### Accounts - admin only

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

Switches which board you read, for the rest of your login session. Body `{"userId": 2}`, or `{"userId": null}` for your own. `404` if unpublished or unknown - deliberately indistinguishable · `400` for your own id. Writes while viewing → `403 {"error":"That board belongs to someone else. Sharing grants a read, not a write."}`.

**Session-only**, and the one route a key cannot reach: the choice is stored by reissuing the session cookie, and a key has no cookie to store it in. A key gets `401 {"error":"Switching boards is a browser action: the choice is kept in your login session. Sign in to use it."}`. Scripts use [`?boardOf=`](#reading-someone-elses-board), which needs no stored state.

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
| `show_notification`                     | desktop UI action                            | -                                               |
| `get_current_task`                      | never syncs                                  | `GET /api/current-task` (returns `null` + note) |
| `check_connection`, `debug_directories` | MCP transport diagnostics; transport is gone | `GET /api/health`, `GET /api/status`            |
| `POST /api/auth/viewing`                | stores a choice in a login session           | [`?boardOf=`](#reading-someone-elses-board)     |
