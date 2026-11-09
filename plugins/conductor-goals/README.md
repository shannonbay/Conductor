# conductor-goals

A Claude Code plugin that runs your Conductor goals and puts them beside the chat. While Claude Code is open it starts each due goal run in a background subagent of its own. You approve or reject proposals, run, pause and inspect goals, and get alerts, all without leaving Claude Code. Claude can also check on your goals and act on them, always asking you first before it changes anything.

It needs the `conductor` MCP server, added for your user so it loads in every session (`claude mcp add --scope user conductor -- node <path to Conductor>/mcp/dist/index.js`, see Conductor's README) and its companion plugin **conductor-goals-guard**, which keeps each run within its goal. The web app is optional: it gives goal pages in a browser and webhook triggers.

## Install

From a terminal, with this repository checked out:

```bash
claude plugin marketplace add <path to the Conductor repo>
claude plugin install conductor-goals@conductor --scope user
claude plugin install conductor-goals-guard@conductor --scope user
```

Claude Code reads the plugins straight from `plugins/`, so after an edit run `/reload-plugins`. `npm run doctor` reports whether both are installed. Without the guard plugin no run starts, and the pane says so.

## How runs work

- Every 30 seconds the plugin asks the conductor server for a scheduler pass (`goals_tick`). The pass runs due health checks and claims the runs that are due: scheduled ones, ones you queued with "Run now", and the one an approval queues.
- Each claimed run starts in a background subagent (`conductor-goals:goal-runner`, hidden from Claude's own Agent tool) in the goal's working directory. Its description is `Goal: <name> (<run id>)`.
- The run reads its brief, works, and ends with `end_run`. Its summary shows in the pane; it isn't handed back into your chat.
- A run past its time limit (`max_run_minutes`) is stopped and marked timed out. A run whose agent ends without `end_run` is marked failed. Cancelling a run in the pane stops its agent.
- Several Claude Code sessions can be open: one at a time holds the scheduler (a lease in the database) and starts runs; the others just show the pane.
- At most `max_concurrent_runs` runs go at once (default 2).

## The Goals pane

Open it with `/goals`. It opens on its own at start-up when something is waiting for you.

```
▸ Inbox active · run running
● Drafting a reply to Alice · 1m ago
last run completed 12m ago · 3 open
▸ Invoices active
Last run: filed 2 invoices
last run completed 48m ago · next in 12m
failing 18 ▁▃▅█
● Reply to Alice about Thursday
  email.send: Send: Thursday 2pm works.
[Approve] [Reject…]
Cancel run  Pause

Updated just now  Refresh
```

- Under each goal's name is one line saying what its agent is doing. While a run is going, that's the agent's latest step: a progress update, an item it added or finished, or a note it saved. Otherwise it says the run is queued, the goal is paused, what the next run will carry out, or the last run's summary. Claude's `goals_status` tool reports the same line.
- Below that: the last run and when the next automatic one is due (`· next in 12m`), `· one-off`, or `· no schedule` with a **Set schedule** button (it suggests one, as `/goal-new` does).
- **Your to-do lists** for this project, each collapsed to its name and count (see below).
- **Discuss**: next to a goal whose last run failed, and in every expanded goal (the goal as a whole, or each run). It brings that goal or run into this conversation: its summary, and the run's agent id so Claude can read what the run actually did. Then talk it over, and Claude makes any changes you agree with `update_goal` (below), asking you to confirm each one.
- While your Claude usage limit is reached, a line says goal runs are on hold until it resets. A run that hit the limit is recorded as skipped, not failed, and due runs start after the reset.
- **Done (n)** at the bottom, collapsed: one-off goals that have finished, each with its last run's summary and **Run again**.
- **Approve** or **Reject…** each proposal. Rejecting asks what should change, and your answer is saved to the goal's memory.
- **Run now**, **Cancel run** (asks you to confirm), **Pause** and **Resume**.
- **▸ name** expands a goal to show its objective, its schedule, open items, last five runs with summaries, and memory. Each memory entry can be deleted (asks you to confirm).
- When you have approved a category every time lately, a hint suggests switching it to auto on the goal page.
- **Open in browser** opens the goal page.

Hotkeys while the pane has focus: `a`/`r` approve or reject the first proposal, `n` runs the first goal that can run, `g` refreshes, and `1`–`9` expand a goal.

## Commands

| Command | What it does |
| --- | --- |
| `/goals` | Open the Goals pane |
| `/goal-new` | Pick a ready-made goal: unsubscribe from mailing lists, a weekly job scan (it asks what to look for, and for your CV to rank against: a path, or it finds the latest), tidy your Downloads, inbox triage, or keeping your GitHub profile README current (the last two under More…). Each comes with instructions, a schedule, autonomy and tool rules (`hooks/templates.ts`). Or type your own. |
| `/goal-new <objective>` | Create a goal that works in the current directory. It suggests a title (or give one: `/goal-new <name>: <objective>`) and asks how often it should run, with a suggestion first (see below). |
| `/goal-run <goal>` | Queue a run now |
| `/goal-pause <goal>`, `/goal-resume <goal>` | Pause or resume a goal |
| `/todo <text>`, `/todo done <id>`, `/todo` | Add to your to-do list for this project, tick one off, or show the list |
| `/goal-schedule <goal> <when>` | Set when it runs on its own: `every 30m`, `every 6h`, `every 1d`, optionally `between 08:00-20:00`; `cron 0 9 * * 1-5`; `one-off`; or `off` for on demand only. An interval's first run starts within a minute. |

Goal names match by exact name, then prefix, then any part of the name. If more than one goal matches, the command lists them.

### Your to-do list

Long conversations produce ideas and decisions to come back to, and a context compaction forgets them. The to-do list keeps them outside the conversation, for you:

- `/todo <text>` adds to this project's **To do** list (made the first time). Or ask Claude: "add that to the list". Claude only adds when asked, or offers when an idea is clearly being put off.
- In the pane, open a list to see its open to-dos, each with its id (`☐ 1.3 Set autonomy…`). Press ☐ to tick one off; a toast says how to undo. **n done** shows the ticked ones, and pressing one puts it back.
- Press a to-do's text to expand it: the full text, any notes, and **Ask**, **Plan** and **Start**. All three bring it into this conversation, where Claude can ask you things. **Ask** gets Claude's opinion and trade-offs with nothing changed (if you've started typing a prompt, it adds the to-do to your draft instead of sending). **Plan** asks Claude to plan it in plan mode for you to review. **Start** asks it to begin. The to-do shows ◐ until it's ticked off (Claude ticks it with `complete_todo` when it's done). To-dos don't run in the background; goals do.
- **+ Add** under an open list opens a box (already focused): type the to-do and press Enter. Or use `/todo <text>`.
- After a compaction, say "check my list": Claude reads it with the `todos` tool. Nothing is added to the conversation otherwise: no hooks, no reminders.

A list is any active Conductor plan in the project's directory, and its to-dos are the plan's tasks, so a plan made earlier (like a roadmap) shows up as a list. A plan with one top task over several (`1` over `1.1`, `1.2`, ...) shows the inner ones. Archive a plan to remove its list.

### Schedules and one-off goals

Goals lean towards running on a schedule: most are ongoing work. When you create one (or press **Set schedule**), a small model (Haiku) reads the name and objective and suggests how often it should run, and a title if you didn't give one (the objective's first words stand in when the model isn't available). "maintain", "keep" or "check" suggest daily, an inbox or triage hourly, monitoring every 6 hours, a report weekly, and "install", "set up" or "migrate" a one-off. Keyword rules stand in when the model isn't available. You pick from four choices with the suggestion first, or type your own (`every 12h`, `cron 0 9 * * 1-5`, `off`). Dismissing the question keeps the suggestion.

A **one-off** goal runs once, straight away. When its run ends with nothing left open (no proposals waiting, no open items), it's done and moves to **Done**. If it proposed something, it stays until you decide: approving runs it again to carry the action out, and rejecting runs it again to revise. **Run again** brings a done one-off back for another run.

## Tools Claude can call

| Tool | |
| --- | --- |
| `goals_status` | Every goal: what waits for approval (with item ids), runs, health. Read-only. |
| `goal_detail` | One goal's open items, recent runs and memory. Read-only. |
| `approve_item`, `reject_item` | Approve or reject a proposal. **Asks you first.** |
| `run_goal` | Queue a run. **Asks you first.** |
| `todos`, `add_todo`, `complete_todo` | Read your to-do lists, add to one (when you ask, or after offering), tick one off (when you say it's done). |
| `update_goal` | Change a goal's name, objective, standing instructions, autonomy per category, tool rules, memory, or pause it. **Shows you each change and asks you first.** Runs can't use it. |
| `set_schedule` | Set or clear a goal's schedule (same forms as `/goal-schedule`). **Asks you first.** |

Ask things like "what do my goals need?" or "approve the Alice reply".

## Alerts and status line

- The status line shows `Conductor: 2 need you · Inbox running`, or `Conductor: offline`.
- A toast appears for each new proposal or failed run. If several arrive at once, they become one toast.
- With system notifications on, you also get a notification through your Claude Code notification channel, at most once a minute per goal.
- **Questions from a run:** when a run needs something only you can give or do (which job sites, connecting Gmail, allowing a site in Chrome), it asks under **Needs you** with **Answer…** and **Done**, and alerts you like a proposal. Your answer goes to the goal's memory and the run carries on. From the conversation, just reply; Claude answers it with `answer_item`.
- **On your phone:** with Remote Control connected and mobile push on in `/config`, an alert reaches the Claude app when you haven't typed (at the terminal or from the phone) for 5 minutes. The plugin passes it to Claude, which sends the push; reply "approve" or "reject, because ..." in the session, and confirm. Each relayed alert is a short turn. (A push the plugin sends itself is reported as sent but doesn't arrive in Claude Code 2.1.319, so that path, the `phone_push` setting, is off until it's fixed.) `goals_status` shows what happened to the last alert and its push.
- While goal runs are going, a band above the prompt shows which (`● Goal run: Inbox · in the background`).

## Settings

Set these in `/config` → conductor-goals, or under `pluginConfigs` in `~/.claude/settings.json`:

| Setting | Default | |
| --- | --- | --- |
| `url` | `http://localhost:3000` | The web app's address, only for "Open in browser" links |
| `poll_seconds` | `15` | How often the pane checks for changes. It checks every 5 s while a run is open, and backs off to a minute while Conductor isn't connected. Each check is one `goals_overview` call, answered `changed: false` when nothing changed. |
| `max_concurrent_runs` | `2` | How many goal runs this session starts at once, each in its own subagent |
| `alerts` | `all` | `all`, `proposals`, `failures` or `off` |
| `os_notifications` | `true` | Also send alerts as system notifications |

## Development

```
hooks/register.tsx  wiring: events, commands, tool hooks, pane and band
hooks/runner.ts     the scheduler tick, starting runs in subagents, time limits, cancelling
hooks/pane.tsx      the Goals pane
hooks/tools.ts      tools Claude can call, and the commands
hooks/sync.ts       reading the overview, polling, running actions
hooks/alerts.ts     toasts, notifications, status line
hooks/api.ts        the conductor MCP tools it calls, and the settings
hooks/model.ts      pure functions: cards, matching, alert diffing, formatting
hooks/state.ts      session state accessors (contract in types/index.d.ts)
```

To check it: `claude plugin validate plugins/conductor-goals` and `claude plugin test plugins/conductor-goals`. The tests run each drawing on the terminal and desktop surfaces against a fake conductor server and fake subagents (`tests/fixtures.ts`).

What a run may do lives in the guard plugin, not here: the engine never shows a plugin the calls its own timers and buttons cause, so this plugin's hooks can't see a run its scheduler started.

## License

Apache License 2.0.
