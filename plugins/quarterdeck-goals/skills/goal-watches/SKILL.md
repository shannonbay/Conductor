---
name: goal-watches
description: Use when a Quarterdeck goal should start a run because something happened (a new GitHub issue or pull request, a new feed entry, a new file, a changed web page, a new email) and not only on a timer. Explains what a watch is, how to write and test its command, recipes for common sources, and when a schedule or a webhook fits better.
---

# Watches for Quarterdeck goals

A goal runs on a schedule. A **watch** also starts a run when something new appears. You set one with `update_goal` (`watches`); the person sees the whole command and confirms it.

## How a watch works

- A watch is a shell command (or, for a connector, a tool: see below), run every few minutes (`every_minutes`, default 5, at least 1) in the goal's working directory.
- The command prints **one line per current item**: an issue number, a feed entry's id, a file name. It exits 0.
- A line it has not printed before is new. New lines queue a run, and that run's brief lists them under `watch_events`.
- The first check only records what is there. It starts nothing.
- A check that fails (non-zero exit or longer than 30 seconds) changes nothing and starts nothing. After three failures in a row the Goals pane shows the watch as failing.
- Several new lines, or lines that arrive while a run is going, make one run, not one each.
- With `fires: "change"` (default `"new"`), the watch compares each check only with the one before: see "Watching a state" below.

So print **stable identifiers**, not text that changes. A line with a comment count or a "2 hours ago" in it looks new at every check.

## Writing the command

1. Run the command yourself first, in the goal's directory, and read what it prints.
2. Check it prints nothing but item lines on stdout. Stderr is ignored, except to explain a failure.
3. Check it exits non-zero when the source can't be reached. Otherwise an outage reads as "no items", which is harmless, but a half-printed list is not.
4. Keep it to at most 200 lines of at most 300 characters. More are ignored.
5. Commands run under `cmd.exe` on Windows and `sh` elsewhere. Quote with double quotes, and avoid `$( )`, pipes into `grep`/`awk`, and single quotes around arguments. When it needs more than one program, write it as `node -e "..."` (Node is always there) or put a script file in the goal's directory and run that.
6. The command runs unattended with the person's own access. Keep it read-only.

After `update_goal`, the answer says how the first check went: how many items it found, or the error.

## Recipes

Open issues in a GitHub repository (needs `gh`, signed in):

```
gh issue list --repo OWNER/REPO --state open --limit 100 --json number --jq ".[].number"
```

Open pull requests:

```
gh pr list --repo OWNER/REPO --state open --limit 100 --json number --jq ".[].number"
```

Releases:

```
gh release list --repo OWNER/REPO --limit 20 --json tagName --jq ".[].tagName"
```

An RSS or Atom feed (prints each entry's link or id):

```
node -e "fetch(process.argv[1]).then(r=>{if(!r.ok)process.exit(1);return r.text()}).then(t=>{for(const m of t.matchAll(/<(?:guid|id)[^>]*>([^<]+)</g))console.log(m[1].trim())}).catch(()=>process.exit(1))" https://example.com/feed.xml
```

Files in a folder (a new file is a new line):

```
node -e "for(const f of require('fs').readdirSync(process.argv[1]))console.log(f)" inbox
```

A web page or file that changes (one line: a hash of its content, so any change is new):

```
node -e "fetch(process.argv[1]).then(r=>{if(!r.ok)process.exit(1);return r.text()}).then(t=>console.log(require('crypto').createHash('sha256').update(t).digest('hex'))).catch(()=>process.exit(1))" https://example.com/status
```

## Watching a state: `fires: "change"`

A normal watch fires once per line it has never printed, so a state that flips back and forth (a working tree clean, then dirty, then clean again; a health check up, then down) fires only the first time. For a state, set `fires: "change"`:

- A check whose lines differ from the last check's (the same lines in another order are no change) is an event; each line that wasn't in the last check is listed in `watch_events`.
- Output that becomes empty is one `(none)` event.
- Only the last check is remembered. Changing a watch's `fires` starts it over, like changing its command.

A repository's working tree (one line: the commit, with `-dirty` while there are uncommitted changes):

```
git describe --always --dirty
```

Whether a service answers (one line: its status code, or `down`):

```
node -e "fetch(process.argv[1]).then(r=>console.log(r.status)).catch(()=>console.log('down'))" https://example.com/health
```

```
watches: { "working tree": { command: "git describe --always --dirty", fires: "change" } }
```

## Tool watches: what only a connector reaches

Mail, calendars and cloud files have no command to run: only a Claude Code session can reach their connectors. For those a watch names a **tool** instead of a command. The session that runs goals calls it every few minutes, with no model turn and nobody asked, and Quarterdeck reads the items out of its answer.

- `tool`: the tool's full name, as your tool list has it (`mcp__claude_ai_Gmail__search_threads`). It must be a connector or MCP tool that only reads. Quarterdeck's own tools are refused, and so is a tool the goal's rules put in a category that is `propose` or `off`.
- `input`: the tool's arguments. Ask for ids only and for few results: the answer is read, not kept.
- `match` (optional): a regular expression over the answer's text; each match's first group is one item. Left out, every `"id": "…"` in a JSON answer is an item, which suits most searches.
- Call the tool yourself first with the same input and look at the answer: check the ids are there and are stable.
- The first call is made within a minute by the session running goals. `goal_detail` shows the watch as failing, with the reason, if the connector isn't signed in there or the call is refused.
- A call that takes over 30 seconds, is refused by a permission rule, or answers an error is a failed check: nothing starts.

New mail in the inbox (Gmail connector):

```json
{ "goal": "Inbox", "watches": { "new mail": { "tool": "mcp__claude_ai_Gmail__search_threads", "input": { "query": "in:inbox newer_than:2d", "pageSize": 25, "view": "THREAD_VIEW_IDS_ONLY" }, "every_minutes": 5 } } }
```

Keep the search narrow and recent (`newer_than:2d`, a sender, a label), so a thread that scrolls off the first page and comes back isn't taken for new. The run is told thread ids; say in the goal's instructions to read each with the connector's `get_thread`.

## When not to use a watch

- **The source can call out** (a service with webhooks, a CI job): use the goal's webhook, `/api/goals/<id>/trigger` on the Quarterdeck web app. It needs the web app running and reachable from the sender.
- **The work is periodic anyway** ("every morning, summarise…"): a schedule alone is enough.
- **The connector has no tool that lists items by id**: give the goal a short schedule, and have its instructions say to check for what is new and to `remember` the last thing it handled.

A goal can have both a schedule and watches. The watch brings the run forward; the schedule still catches whatever the watch can't see.

## Setting, changing and removing

```json
{ "goal": "Triage issues", "watches": { "new issues": { "command": "gh issue list --repo OWNER/REPO --state open --limit 100 --json number --jq \".[].number\"", "every_minutes": 5 } } }
```

- Giving an existing name changes that watch. A new command starts over with a new first check.
- `null` removes a watch: `{ "watches": { "new issues": null } }`.
- `goal_detail` lists a goal's watches and says when one is failing and why.
- Tell the goal what to do with the news: add a line to its instructions such as "watch_events lists new issue numbers: read each with `gh issue view` and propose a label".
