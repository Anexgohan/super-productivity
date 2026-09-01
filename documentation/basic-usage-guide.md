# Basic Usage Guide

This guide covers driving Super Productivity through the `sp-bridge` REST API: connecting to a deployment, reading your tasks, and changing them from a script, a terminal, or an automation.

It is written for anyone who wants to work with their board from outside the app. That includes people writing small scripts or integrations, and it includes AI coding assistants, which tend to be the heaviest users of this API. Everything here is plain HTTP and `curl`, so nothing needs installing to follow along.

Two companion documents sit alongside this one. `api-reference.md` is the complete route contract, with every parameter and error. `super-productivity-explainer.md` covers how the system is put together internally. This guide is the practical middle: enough to get real work done without reading either.

## What you are talking to

`sp-bridge` is a headless peer on the sync network. Rather than sitting in front of a database, it joins the same sync mesh your app clients use, replays the operation log, and builds its own copy of the application state. That copy is what the REST API serves.

The practical consequence is that the API is a first-class client, not a side door. It sees what your other devices see, changes made through it sync outward like any other client's would, and it keeps working whether or not anything else is running. There is no desktop app to keep open and no plugin to install.

If you are following older notes that mention an MCP server, a bridge plugin, or a `TOOLS.md` tool listing, those describe a previous approach that has been retired. The REST API replaces all of it.

## Getting a key

Almost every route needs authentication. Keys look like `spk_<keyId>_<secret>` and go in one of two headers, whichever suits your client:

```
X-Api-Key: spk_1_yourkeyhere
Authorization: Bearer spk_1_yourkeyhere
```

Keys are created from the web UI, or over the API with `POST /api/auth/users/:id/keys`. Minting a key with a key also needs your account password in the body as `currentPassword`, so that a stolen key cannot quietly produce more of itself. The same goes for revoking or deleting a key, changing a role, and sharing a board.

The number in the middle of a key is the **key** id, not your user id, so do not parse it to work out which account you are. Ask `GET /api/auth/me` instead, which works with a key and tells you who you are.

Keys carry one of three roles. **Admin** can do anything, including deleting projects. **Operator** can read and write tasks. **Viewer** can only read, and any write returns `403 Your account is read-only. An admin can change your role.` If you get that error, nothing is wrong with your request; the account simply is not allowed to make changes.

Two routes need no key at all, which makes them useful for checking whether you are pointed at a live deployment: `/api/health` and `/api/docs`.

## Your first request

The examples below use two shell variables, so set them once:

```bash
SP_API="http://your-host:port/api"
SP_KEY="spk_1_yourkeyhere"
```

Check the deployment is up. This needs no key, so it also confirms the host and port before you start debugging auth:

```bash
curl -s "$SP_API/health"
# {"status":"ok"}
```

Now read something real:

```bash
curl -s -H "X-Api-Key: $SP_KEY" "$SP_API/tasks?parentsOnly=true&fields=id,title,isDone"
```

`parentsOnly` skips subtasks, and `fields` limits the response to what you asked for. Both matter more than they look: a full task list on an established board is large, and most of it is fields you will never read. Get in the habit of projecting.

If that returned your tasks, you are set up correctly and everything below will work.

## Knowing which deployment you are on

Most people running this have more than one instance, typically something for development and something holding real data. They are separate systems with separate databases, and the API gives you no hint about which is which.

This is worth being careful about because the failure is quiet. Writing a task to the wrong deployment returns a perfectly healthy `200`, and the task is genuinely created, just not where anyone will look for it. Nothing surfaces the mistake until someone wonders where their task went.

Two habits make this a non-issue. Give your deployments clearly different ports so a URL is self-describing, and confirm with `GET /api/health` before the first write of a session. If you automate against this API, keep the base URL in configuration rather than in the script, so switching targets is deliberate.

## Finding your way around

Every write takes internal ids. Projects and tags have human-readable titles in the UI, but the API wants the id underneath, and there is no lookup-by-name shortcut.

```bash
curl -s -H "X-Api-Key: $SP_KEY" "$SP_API/projects"
curl -s -H "X-Api-Key: $SP_KEY" "$SP_API/tags"
```

Both return id and title, and both are cheap. Call them at the start of a session and match on `title`.

Resist the temptation to paste the ids into your script as constants. Tags in particular get created as work demands them, so a hardcoded list goes stale quietly and starts failing on the tags you added last week. One call at startup avoids the whole category of problem.

Tags have no description field, so the tag name is the whole definition. If you meet a board where a tag's purpose is not obvious, each tag object carries a `taskIds` array; look at what is currently tagged with it and the intent is usually clear immediately.

## Working with tasks

### Reading

The task list takes filters, and they compose:

```bash
curl -s -H "X-Api-Key: $SP_KEY" "$SP_API/tasks?projectId=$PROJECT_ID"
curl -s -H "X-Api-Key: $SP_KEY" "$SP_API/tasks?tagId=$TAG_ID"        # one kanban column
curl -s -H "X-Api-Key: $SP_KEY" "$SP_API/tasks?isDone=false"
curl -s -H "X-Api-Key: $SP_KEY" "$SP_API/tasks?overdue=true"
curl -s -H "X-Api-Key: $SP_KEY" "$SP_API/tasks?search=calibration"
curl -s -H "X-Api-Key: $SP_KEY" "$SP_API/tasks/$TASK_ID"             # a single task, in full
```

`unscheduled` and `plannedForToday` are available too, and `GET /api/status` gives entity counts and the sync cursor if you want a quick sense of board size.

### Creating

```bash
curl -s -H "X-Api-Key: $SP_KEY" -H 'Content-Type: application/json' \
  -X POST "$SP_API/tasks" \
  -d '{
    "title": "Add Fahrenheit display option",
    "projectId": "'"$PROJECT_ID"'",
    "notes": "**Why:** US users have asked for it. Display-layer only.",
    "tagIds": ["'"$FRONTEND_TAG"'"]
  }'
```

The response includes the new task's id, which you will want for anything that follows.

For something with known steps, create the parent and its subtasks together rather than making four calls:

```bash
curl -s -H "X-Api-Key: $SP_KEY" -H 'Content-Type: application/json' \
  -X POST "$SP_API/tasks/with-subtasks" \
  -d '{
    "title": "Ship v2 settings page",
    "projectId": "'"$PROJECT_ID"'",
    "subTasks": ["Wire the form", "Add validation", "Update docs"]
  }'
```

There is also `POST /api/tasks/from-syntax`, which parses the app's shorthand (`Fix the header #frontend +Website @tomorrow 1h`) out of a single string. It is convenient for a quick capture, with one caveat covered below.

### Updating

`PATCH` accepts any of `title`, `notes`, `isDone`, `doneOn`, `timeEstimate`, `timeSpent`, `projectId`, `tagIds`, `dueDay` and `dueWithTime`:

```bash
curl -s -H "X-Api-Key: $SP_KEY" -H 'Content-Type: application/json' \
  -X PATCH "$SP_API/tasks/$TASK_ID" \
  -d '{"notes": "Revised approach, see PR 42."}'
```

### Finishing

Two routes close a task. `POST /api/tasks/<id>/complete` marks it done as of right now. `POST /api/tasks/<id>/complete-on` lets you say when it was actually finished:

```bash
curl -s -H "X-Api-Key: $SP_KEY" -H 'Content-Type: application/json' \
  -X POST "$SP_API/tasks/$TASK_ID/complete-on" \
  -d '{"doneOn": "2026-07-19"}'
```

Prefer the dated form whenever you are logging work after the fact. Completed tasks group by date in the app, so a batch of last week's work closed today all lands on today and tells you nothing. The dated route puts each card on the day it belongs to.

### Moving between kanban columns

Columns are driven by tags, so moving a card means changing which tags it has. Add and remove them one at a time:

```bash
curl -s -H "X-Api-Key: $SP_KEY" -H 'Content-Type: application/json' \
  -X POST "$SP_API/tasks/$TASK_ID/tags" \
  -d '{"tagId": "'"$IN_PROGRESS_TAG"'"}'

curl -s -H "X-Api-Key: $SP_KEY" \
  -X DELETE "$SP_API/tasks/$TASK_ID/tags/$PLANNED_TAG"
```

Do not do this by sending `tagIds` to `PATCH`. That field is a full replacement, so setting it to move one card into one column erases every other tag it had. The dedicated routes exist precisely because that mistake is easy and silent. Save `tagIds` for creating a task or for a rewrite you actually intend.

### A worked example

Capturing a bug, starting it, and finishing it a few days later. Assume `$PROJECT_ID`, `$BUG_TAG` and `$IN_PROGRESS_TAG` came from the `/projects` and `/tags` calls above:

```bash
# capture it, keeping the new task's id
TASK_ID=$(curl -s -H "X-Api-Key: $SP_KEY" -H 'Content-Type: application/json' \
  -X POST "$SP_API/tasks" \
  -d '{
    "title": "Summary stats overflow to three rows",
    "projectId": "'"$PROJECT_ID"'",
    "tagIds": ["'"$BUG_TAG"'"]
  }' | python3 -c 'import json,sys; print(json.load(sys.stdin)["id"])')

# start work on it
curl -s -H "X-Api-Key: $SP_KEY" -H 'Content-Type: application/json' \
  -X POST "$SP_API/tasks/$TASK_ID/tags" \
  -d '{"tagId": "'"$IN_PROGRESS_TAG"'"}'

# attach the pull request when it opens
curl -s -H "X-Api-Key: $SP_KEY" -H 'Content-Type: application/json' \
  -X POST "$SP_API/tasks/$TASK_ID/links" \
  -d '{"url": "https://github.com/owner/repo/pull/42", "title": "PR 42"}'

# close it on the day it actually merged
curl -s -H "X-Api-Key: $SP_KEY" -H 'Content-Type: application/json' \
  -X POST "$SP_API/tasks/$TASK_ID/complete-on" \
  -d '{"doneOn": "2026-07-24"}'
```

### Pulling in GitHub issues

Tasks do not all have to be typed by hand. Super Productivity ships a GitHub plugin that, once enabled and pointed at a repository, adds a sidebar where you can search your issues and pull any of them in as a task. For anything already tracked on GitHub, this beats retyping it, and it keeps the card tied to the issue rather than being a loose copy of it.

Setup happens in the app rather than through this API: enable the plugin, give it the repository and a token, and choose how much it should sync back (title and status can follow the issue, or you can keep the card independent once imported).

Imported tasks are ordinary tasks as far as the API is concerned, with three extra fields identifying where they came from:

```bash
curl -s -H "X-Api-Key: $SP_KEY" \
  "$SP_API/tasks?fields=id,title,issueId,issueType,issueProviderId"
```

Worth knowing: an imported card's title is the issue's title, so it arrives in GitHub's style rather than yours. If you keep title conventions on your board, imported cards are the exception, and renaming one may be undone later if you have title sync enabled.

You can also link a task you already have to an issue, which is useful when the work started before the issue existed:

```bash
curl -s -H "X-Api-Key: $SP_KEY" -H 'Content-Type: application/json' \
  -X POST "$SP_API/tasks/$TASK_ID/issue-link" \
  -d '{
    "issueId": "62",
    "issueType": "GITHUB",
    "issueProviderId": "'"$PROVIDER_ID"'"
  }'
```

The provider id identifies which configured integration the issue belongs to. The simplest way to find yours is to read it off a card the plugin already imported, using the `fields` query above.

## Things that will trip you up

**`tagIds` on `PATCH` replaces everything.** Covered above, and worth repeating because it is the single most common way to quietly damage a board.

**A board can be scoped to a project, and the UI hides the ones that are not.** Boards carry `projectIds`; the header's project selector narrows the board strip to the boards assigned to the project you picked. `GET /api/boards` is unaffected and still returns every board, so a board you cannot find in the browser is usually assigned elsewhere rather than missing. Set it with `PATCH /api/boards/:id -d '{"projectIds":["<projectId>"]}'`, or `[""]` to unassign.

**New tasks go to their project, not to Today.** Creating a task never schedules it. If you meant today, follow up with `POST /api/today/plan` and the task's id.

**Send `Content-Type` only when there is a body.** A `DELETE` with no body but a JSON content type fails with `400 FST_ERR_CTP_EMPTY_JSON_BODY`. Harmless once you know, baffling before.

**Time values are milliseconds.** `timeEstimate` and `timeSpent` both. An hour is `3600000`.

**The shorthand route creates tags you did not mean to create.** `POST /api/tasks/from-syntax` treats `#`, `+` and `@` as markup wherever they appear. A title like `PR #61: fix the header` produces a tag literally named `61:` and drops it from the title. If your text might contain those characters, use `POST /api/tasks` with explicit `tagIds` instead.

**Tasks with live subtasks cannot be deleted.** You get a `409`. Delete or reparent the children first.

**Bulk update is all or nothing.** `POST /api/tasks/bulk/update` applies every change or none, so one bad id fails the batch. Similarly `POST /api/tasks/reorder` expects an exact permutation of the list's current members, not a partial ordering.

**Deleting a project deletes its tasks, permanently.** There is no undo and no archive to recover from. The Inbox project and the `TODAY` tag are protected and cannot be deleted at all.

**Somebody else's board is read-only.** Add `?boardOf=<accountId>` to any data route to read a board its owner shared, and `GET /api/auth/public-boards` lists the ones open to you. Writes there are refused whatever your role, so an admin reading an operator's board is a reader like anyone else.

**Switching boards in the browser does not carry over to a key.** `POST /api/auth/viewing` stores a choice in your login session; a script has no session, so it uses `?boardOf=` per request instead.

## Working conventions

None of this is enforced by the software. It is the set of habits that keeps a board readable when part of it is maintained by hand and part by automation, offered as a sane default rather than a rule.

**Write titles as outcomes, in plain words.** "Release notes scoped per release" rather than "fix(notes): scope by tag". Keep commit-style prefixes and issue numbers out of them. Completed work reads as what happened, upcoming work reads as an instruction, and ideas read as a bare noun. Anything that needs more explanation belongs in the notes. Cards imported from GitHub are the exception, since their titles come from the issue.

**Notes render markdown, so write markdown.** Bold labels and bullets survive being skimmed six months later; a wall of prose does not. Say what the thing is, why it matters, and link anything worth following.

```markdown
**Branch:** `feat/ui-polish-2`

**Scope:** buttons and cards first
**Why:** several look generic and drift from the design language
```

When several cards share a branch, put the branch line on one parent card and make the rest subtasks, so the branch is recorded once.

**Give logged work a consistent shape.** For example, cards recording merged pull requests carry a `PR` tag and a note built the same way every time:

```markdown
**[PR 61](https://github.com/owner/repo/pull/61)** - merged 2026-07-19

- Release notes now scoped by release tag
- Button language unified
```

The value is in the sameness. Anything regular is greppable later, by you or by a script.

**Mark shipped work with the version it shipped in**, as a title suffix like `(v0.6.2)`, added when the stable release goes out rather than at a pre-release.

**If an automation writes to your board, have it log outcomes at the end of a session** rather than narrating as it goes, and have it ask before deleting or reordering anything a person created.

## Keeping up with changes

This API is under active development and routes get added. Every deployment serves its own current route map:

```bash
curl -s "$SP_API/docs"
```

That map is generated from the running code, so when it disagrees with any document, including this one, believe the map. `api-reference.md` in this repository is the detailed contract and is the right place to look for parameters and error semantics; treat it as authoritative for behaviour and never for hosts or ports, which are yours.
