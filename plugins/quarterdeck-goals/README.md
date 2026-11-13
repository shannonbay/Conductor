# Quarterdeck

Quarterdeck gives Claude Code standing goals: things you want kept true, like "unsubscribe me from mailing lists I never read", "find me the three best new job ads each week" or "clear old installers out of Downloads". Each goal runs on its own schedule in the background of your Claude Code session, on your Claude plan. When it wants to act, it proposes, and you approve or reject from the Goals pane beside your chat. It remembers what you decided, so a rejection with "too formal" shapes later runs.

Start with `/goal-new`: pick a ready-made goal or type your own.

This plugin, `quarterdeck-goals`, runs the goals and shows the pane. While Claude Code is open it starts each due goal run in a background subagent of its own. You approve or reject proposals, run, pause and inspect goals, and get alerts, all without leaving Claude Code. Claude can also check on your goals and act on them, always asking you first before it changes anything.

It works in Claude Code only (the pane and the runner are a Claude Code mod), and needs Node 22.13 or later on your `PATH` for its server.

It brings the `quarterdeck` MCP server with it (`.mcp.json` starts the bundled `server/quarterdeck-mcp.mjs`; Claude Code names its tools `mcp__plugin_quarterdeck-goals_quarterdeck__*`), and depends on its companion plugin **quarterdeck-guard**, which keeps each run within its goal. The web app is optional: it gives goal pages in a browser and webhook triggers.

## Install

```bash
claude plugin marketplace add shannonbay/Quarterdeck#release
claude plugin install quarterdeck-goals@quarterdeck --scope user
```

quarterdeck-guard is installed with it. Turn on auto-update for the marketplace (`/plugin` → Marketplaces → quarterdeck → Enable auto-update) to get new versions, server included, then `/reload-plugins` when Claude Code says one arrived. Without it, the pane says when a newer version is published and offers **Ask Claude to install it**. Without the guard plugin no run starts, and the pane says so. An older hand-added `quarterdeck` server (`mcp__quarterdeck__*`) still works, but remove it once the plugin's is running (`claude mcp remove quarterdeck --scope user`) so two copies don't run.

For development, add your checkout as the marketplace instead (`claude plugin marketplace add <path to the Quarterdeck repo>`). Claude Code then reads the plugins straight from `plugins/`: after an edit run `npm run build` (which bundles the server into `server/`) and `/reload-plugins`. `npm run doctor` reports what's installed.

## What it runs, stores and sends

- **A local server.** `.mcp.json` starts `node server/quarterdeck-mcp.mjs` on your computer. That file is one bundle built with esbuild (not minified) from `mcp/` and `core/` in the [repository](https://github.com/shannonbay/Quarterdeck), where the source is.
- **Your data stays on your computer.** Goals, their items, memory, run history and to-do lists are in one SQLite file, `~/.quarterdeck/tasks.db`. Quarterdeck has no service of its own and sends none of it anywhere.
- **Two network requests of its own.** At most every 6 hours the server reads this plugin's `plugin.json` from the `release` branch on GitHub to see whether a newer version is published. It sends nothing about you. Turn it off with `QUARTERDECK_UPDATE_CHECK=0`. And when a goal carries out a one-click unsubscribe you approved (or set to auto), the server sends that one request to the mailing list's own unsubscribe link (below).
- **Background subagents.** Each goal run is a Claude Code subagent on your Claude plan. It can use the tools, MCP servers and connectors your session has, within the goal's rules: a kind of action is off, waits for your approval, or is auto, as you set it (the quarterdeck-guard plugin holds a run to that). The guard only ever refuses: what it doesn't refuse, including an auto action, still goes through Claude Code's own permission rules, which may ask you. A small model call (Haiku) suggests a schedule and title for a new goal.
- **Commands you give it.** A goal can have a health command and watches, and an item a check command. The server runs them in the goal's directory. A goal has none unless you set one, and a watch is set only after you have read its whole command and confirmed it.
- **Connector calls you set up.** A tool watch calls one connector tool (for example a Gmail search for thread ids) every few minutes from the session that runs goals, with the input you confirmed. Only the ids in the answer are kept. A goal has none unless you set one.
- **Messages into your conversation.** Discuss, a to-do's Ask, Plan and Start, and phone alerts submit a prompt to your chat, each when you press the button (alerts: when you have been away 5 minutes, see below).
- **Only if you ask: the standing session.** `quarterdeck-cli.mjs runner install` adds a scheduled task (Windows) or a systemd user timer (Linux) that keeps one Claude Code session running so goals run with no window open. Nothing installs it for you, and `runner uninstall` removes it.

## Everything it does by itself

Claude Code's plugin directory asks a plugin to say plainly what it does without being asked. This is all of it. The source of every line is in `hooks/` here and in `mcp/` and `core/` in the [repository](https://github.com/shannonbay/Quarterdeck).

### Tools it calls itself

- **Quarterdeck's own server** (`mcp__plugin_quarterdeck-goals_quarterdeck__*`, or `mcp__quarterdeck__*` for a server added by hand). Every 30 seconds `goals_tick`, the scheduler pass (it runs due health checks and watches, and claims due runs). For the runs it starts and stops, `attach_agent`, `fail_run` and `cancel_run`. For the pane, `goals_overview` every `poll_seconds` (5 s while a run is going, up to a minute while the server doesn't answer). When you press a pane button, run a command or confirm one of the tools below, the server tool that does it (`decide_item`, `run_goal`, `set_goal_status`, `set_schedule`, `update_goal`, `create_goal`, `delete_memory`, `todo_list`, `todo_add`, `todo_set`). After checking a tool watch, `watch_report` with what it found.
- **`PushNotification`** (Claude Code's phone push), when an alert comes up, with the alert's one line (`Quarterdeck: Inbox asks: "Reply to Alice". Reply "approve" or …`). Claude Code answers whether a push can reach your phone right now, which decides whether the phone relay below goes ahead. With the `phone_push` setting on (off by default), this is the push itself.
- **A tool watch's tool**, only for a watch you set and confirmed: the connector tool and input you saw (a Gmail search for thread ids, say), every few minutes, with a 30-second limit. Your permission deny rules still apply. Its answer goes to the server, which keeps only the ids.
- **`TaskStop`**, to stop a run's agent when you cancel the run or it passes its time limit.

### Hooks, and what they do with what they see

- `session.start`, `prompt.submit`, `session.receive`, `turn.complete`: start the plugin (the pane's polling and the runner) if it hasn't started. `prompt.submit` and `session.receive` look at where a prompt came from (typed, from your phone through Remote Control, or automatic), never at its text, to note when you last typed (the phone relay waits until you have been away 5 minutes) and that Remote Control is connected. `turn.complete` notices a run agent finishing, so the run is closed within 2 seconds instead of at the next tick. All of them pass the event on unchanged.
- `session.end`: stops the timers and gives up the scheduler lease, so another open session takes over.
- `tool.call` on the server's `get_goal_brief` and `end_run`: after the call has run, notes that a goal run is going in this conversation itself (for the band above the prompt) and refreshes the pane. The call and its answer are left as they are.
- `tool.call` on its own tools (`mcp__quarterdeck-goals__*`, under "Tools Claude can call"): answers them.
- `agent.offer`: hides the `goal-runner` agent type from Claude's Agent tool, so only the plugin starts runs.
- `command.run` for its slash commands, and `ui.render` for the pane and the band.

What a run may do is decided by the quarterdeck-guard plugin, not by these hooks.

### Commands and programs it runs

- **Slash commands**, each only when you press its button: `/plan` when you press **Plan** on a to-do (only Claude Code's built-in one), and `/remote-control` when you press **Connect** on the pane's "alerts can't reach your phone" line.
- **Commands you set**: a goal's health command, its watches' commands and an item's check command, run by the server in the goal's directory with your user's rights. There are none unless you set them, and a watch is set only after you've read its whole command and confirmed it.
- **The standing session**, only when you run `node server/quarterdeck-cli.mjs runner install` yourself: it adds a scheduled task (Windows: `schtasks`, PowerShell's `Start-Process`, `conhost --headless`) or a systemd user timer and a tmux session (Linux) that keep one Claude Code session running. `runner uninstall` removes them.

### Network: what it fetches, what it sends, and where

- **The plugin's hooks make no network requests.**
- **The update check**: at most every 6 hours, a plain GET of this plugin's public `plugin.json` from `raw.githubusercontent.com/shannonbay/Quarterdeck/release/…`. It uses no credential and sends nothing about you. `QUARTERDECK_UPDATE_CHECK=0` turns it off.
- **One-click unsubscribe** (the server's `unsubscribe_one_click` tool): when a goal run carries out an unsubscribe you approved, or one in a category you set to `auto`, the server sends one POST to the `https` unsubscribe link in that mailing list's own message, with the body `List-Unsubscribe=One-Click` that the email standard (RFC 8058) defines, and nothing else. It goes only to that link, which must be `https`. The quarterdeck-guard plugin holds the call to the goal's rules like any other action.
- **`quarterdeck-cli.mjs doctor`**, when you run it, asks `http://localhost:3000/api/health` whether the optional web app is running.
- **A small model call** (Haiku, through Claude Code on your plan) when you create a goal or press **Set schedule**: the goal's name and objective, to suggest a title and a schedule.
- **Prompts into your conversation** (below), which go to Claude like anything you type, and **phone alerts**, which go to the Claude app through Claude Code's own push.
- **Run agents** are Claude Code subagents on your plan. Like Claude in your conversation, they reach whatever tools, MCP servers and connectors your session has, within the goal's rules and Claude Code's permission rules.

Everything it reads stays on your computer: the database, which way a prompt arrived, the list of running agents, and your unsent prompt (only to check whether you have started typing, below). It doesn't read your conversation.

### Prompts it submits

Each goes into your conversation as a prompt when you press the button. If you have started typing a prompt, a short note is added to your draft instead (`(discuss goal "Inbox" …)`), so nothing you typed is lost.

| Button | What the prompt holds |
| --- | --- |
| **Discuss**, **Discuss this goal…** | The goal's name and id, your question if you typed one, and a request to read the goal with `goal_detail` and make agreed changes with `update_goal` or `set_schedule` (which ask you first) |
| **Discuss this run…** | The same, plus the run's id, status, trigger, time and summary, and its agent id with where its transcript is (`agent-<id>.jsonl` under `~/.claude/projects`) |
| A to-do's **Ask…** | The to-do's list, id, text and notes, and your question (or a request for Claude's opinion), with "don't change anything" |
| A to-do's **Plan**, **Start** | The to-do's list, id, text and notes; plan it in plan mode for you to review, or begin; tick it off with `complete_todo` when done |
| **Ask Claude to install it** (update notice) | The installed and new versions, and the three `claude plugin … update` commands to run |
| **Ask Claude to add them** (allow rules) | The goal's name and id and its allow rules; show you the change to your settings and wait for your yes |

One prompt is sent without a press: the **phone relay** (setting `phone_relay`, on by default). When an alert comes up, you haven't typed for 5 minutes, and Claude Code says a push could reach your phone, it sends:

> [Quarterdeck alert, sent automatically while you're away] Send me this phone notification with the PushNotification tool (status "proactive"), word for word, then end your turn without doing anything else:
> Quarterdeck: Inbox asks: "Reply to Alice". Reply "approve" or "reject, because ..." in Claude.

### What it gives the run agents

Each due run starts one background subagent of the plugin's own type, `quarterdeck-goals:goal-runner`, in the goal's working directory. Its instructions say to work within the goal's autonomy, pass its run id (`run_scope`) on every Quarterdeck call, keep to its time and finish with `end_run`. Its prompt holds the goal's name, goal and run ids, working directory and time limit, and the steps of a run (`goalRunPrompt` in `core/src/goal-tick.ts`). Nothing from your conversation goes with it. The agent reads the rest with `get_goal_brief`: the goal's objective, standing instructions, memory, your decisions since the last run, open items, recent run summaries and any new watch lines.

A run agent can't use the person-only tools (`decide_item`, `cancel_run`, `update_goal`, `create_goal`, `delete_memory`, `run_goal` and the like) or this plugin's tools: Claude Code leaves them out of its tool list, and the guard refuses them too.

### Notes on the directory's findings

- **"Uses a credential" near `raw.githubusercontent.com`** (`server/quarterdeck-mcp.mjs`): the update check above. It reads no token or file.
- **"Uses a credential" near `schemas.microsoft.com`** (`server/quarterdeck-cli.mjs`): the XML namespace of the Windows Task Scheduler task the standing session installs. It is never fetched.
- **"Reads the installer's pat"** (`hooks/model.ts`): `pat` and `pattern` there are tool-name patterns from a goal's tool rules (`mcp__claude_ai_Gmail__*`), used to work out allow rules. Not a token.
- **`fetch()` in the goal-watches skill**: example watch commands that read a public feed or web page the person names. Claude suggests one only when asked, and the person reads and confirms the whole command before it is set.
- **"Download and run" in `server/quarterdeck-cli.mjs`**: nothing in it downloads anything. The nearest shape is the standing session's launcher: `runner install` writes `~/.quarterdeck/runner/launch.mjs` (its text is the `LAUNCHER` constant, in `mcp/src/runner-session.ts`), and the scheduled task or timer runs it every 5 minutes. It reads `runner/cli-path`, the path of this plugin's own `quarterdeck-cli.mjs` that the server writes at start-up (an installed plugin's folder changes with its version), and runs `node <that file> runner ensure`. Its only other network call is the doctor's check of `http://localhost:3000/api/health` (the optional web app).
- **The server bundle** (`server/quarterdeck-mcp.mjs`, about 830 KB) is too large for the directory to read. It is built with esbuild, not minified, from `mcp/` and `core/` in the repository (`npm run build`).

## How runs work

- Every 30 seconds the plugin asks the quarterdeck server for a scheduler pass (`goals_tick`). The pass runs due health checks and watches, and claims the runs that are due: scheduled ones, ones you queued with "Run now", the one an approval queues, and the one a watch queues when it sees something new.
- **Watches** start a run when something happens, not only on a timer. A watch is a command that prints one line per current item (an open issue's number, a feed entry's id, a file name). It is checked every few minutes; a line it hasn't printed before queues a run, whose brief lists the new lines. The first check only records what is there, and a check that fails starts nothing. For mail and other things only a connector reaches, a watch names a read-only connector tool (a Gmail search, say) with its input instead of a command; this session calls it every few minutes without a model turn and without asking, and the ids in its answer are the items. Ask Claude to add one ("start a run when octo/site gets a new issue", "…when new mail arrives from my accountant"): the `goal-watches` skill has the recipes, and you confirm the command, or the tool and its input, before it is set. An expanded goal lists its watches; one that can't check keeps the goal's card open and says why.
- Each claimed run starts in a background subagent (`quarterdeck-goals:goal-runner`, hidden from Claude's own Agent tool) in the goal's working directory. Its description is `Goal: <name> (<run id>)`.
- It runs on the goal's model: Haiku, Sonnet, Opus or a full model id. A new goal gets one that suits what it does, and the message after `/goal-new` says which and why: Haiku for a goal that only checks something and tells you, Sonnet for one that sorts things and proposes actions (the usual choice, and what you get when no suggestion is available), Opus for one that writes something people will read or makes hard calls. Ready-made goals come with their own. A goal set to "the session's model" runs on the model of whichever session starts the run, so it can change from run to run. `CLAUDE_CODE_SUBAGENT_MODEL`, when set, overrides every goal's choice.
- The run reads its brief, works, and ends with `end_run`. Its summary shows in the pane; it isn't handed back into your chat.
- A run past its time limit (`max_run_minutes`) is stopped and marked timed out. A run whose agent ends without `end_run` is marked failed. Cancelling a run in the pane stops its agent.
- Several Claude Code sessions can be open: one at a time holds the scheduler (a lease in the database) and starts runs; the others just show the pane.
- With no window open, the **standing session** runs them: a Claude Code session with Remote Control on, in a hidden console (Windows) or a tmux session (Linux), set up with `node server/quarterdeck-cli.mjs runner install` (see the main README, "Running with Claude Code closed"). While it is the one starting runs, the pane says so.
- At most `max_concurrent_runs` runs go at once (default 2).

## The Goals pane

Open it with `/goals`. It opens on its own at start-up when something is waiting for you. With no goals or to-dos yet, it says what a goal is and how to start one (`/goal-new`) or add a to-do (`/todo`).

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
▸ Release watch · 31k tokens · next in 4d
▸ Job matches · 112k tokens · next in 6d

Last change just now  Refresh
```

- A goal with nothing for you is **one line**: its name, the tokens its last run used (when it ran, if they weren't recorded) and when it runs next. That is a goal with no proposal or question waiting, no run going, a last run that didn't fail, a health check that isn't failing and no suggestion. Press its name (or its number) for the full card with its buttons. Goals stay in the same order either way.
- Under each goal's name is one line saying what its agent is doing. While a run is going, that's the agent's latest step: the tool it is using, an item it added or finished, or a note it saved. When Claude Code has asked you to allow one of the run's tool calls, the line turns yellow and says the run is waiting for your permission, on which call and for how long, and the status line says so too; answer the prompt where Claude Code shows it (the window the run is in, the Claude app or claude.ai/code). Otherwise it says the run is queued, the goal is paused, what the next run will carry out, or the last run's summary. Claude's `goals_status` tool reports the same line.
- Below that: the last run, what it used (`· Sonnet 5.5 · 48k tokens · 2m`: the model the run actually ran on, the new tokens the run's agent used, not counting re-reads of the cached prompt, and how long it took) and when the next automatic one is due (`· next in 12m`), `· one-off`, or `· no schedule` with a **Set schedule** button (it suggests one, as `/goal-new` does).
- **Model: Sonnet · Change…** in an expanded goal: the model its runs use. **Change…** offers the session's model, Haiku, Sonnet or Opus, or you can type a full model id under Other. Smaller models cost less and use up your plan's limits more slowly; pick a larger one if the goal's runs miss things. If the last run used a different model (because you changed it since, or `CLAUDE_CODE_SUBAGENT_MODEL` overrides it), a yellow note says which.
- **Your to-do lists** for this project, each collapsed to its name and count (see below).
- **Claude Code allow rules**: an expanded goal whose tool rules put a tool in an `auto` category shows "Claude Code allow rules (N)". Quarterdeck never lets a call through on its own: Claude Code's own permission rules decide, so outside auto mode Claude Code asks before each of those calls. Open the line to see the allow rules that would stop that, one per tool rule (a tool rule Claude Code can't take as an allow rule, such as `mcp__*`, is listed apart). **Ask Claude to add them** brings them into the conversation; Claude shows the change to your settings and writes nothing until you say yes. An allow rule applies to all of Claude Code, not only goal runs. `goal_detail` lists them too.
- **Discuss**: next to a goal whose last run failed, and in every expanded goal (the goal as a whole, or each run). It brings that goal or run into this conversation: its summary, and the run's agent id so Claude can read what the run actually did. In an expanded goal, "Discuss this goal…" and "Discuss this run…" first open a box for your question; Enter on an empty box asks the usual one (what's working, or why the run failed). Then talk it over, and Claude makes any changes you agree with `update_goal` (below), asking you to confirm each one.
- While your Claude usage limit is reached, a line says goal runs are on hold until it resets. A run that hit the limit is recorded as skipped, not failed, and due runs start after the reset.
- **Done (n)** at the bottom, collapsed: one-off goals that have finished, each with its last run's summary and **Run again**.
- **Approve** or **Reject…** each proposal. Rejecting asks what should change, and your answer is saved to the goal's memory.
- **Run now**, **Cancel run** (asks you to confirm), **Pause** and **Resume**.
- **▸ name** expands a goal to show its objective, its schedule, open items, last five runs with summaries, and memory. Each memory entry can be deleted (asks you to confirm). A memory a run wrote after reading untrusted content (mail, web pages, watch events) shows a yellow ⚠ and **Trust**: until you trust it, any run whose brief includes it needs your approval for its auto actions, in case that content asked for the memory.
- When you have approved a category every time lately, a hint suggests switching it to auto on the goal page.
- **Open in browser** opens the goal page.

Hotkeys while the pane has focus: `a`/`r` approve or reject the first proposal, `n` runs the first goal that can run, `g` refreshes, and `1`–`9` expand a goal.

## Commands

| Command | What it does |
| --- | --- |
| `/goals` | Open the Goals pane |
| `/goal-new` | Pick a ready-made goal: unsubscribe from mailing lists, a weekly job scan (it asks what to look for, and for your CV to rank against: a path, or it finds the latest), tidy your Downloads, inbox triage, keeping your GitHub profile README current, fixing failing CI (it asks which branch to keep green), or working on new GitHub issues: bugs, features and enhancements (the last four under More…). Each comes with instructions, a schedule, autonomy and tool rules (`hooks/templates.ts`). The two GitHub fixers have no schedule: a watch (`gh`, run in the session's folder, which must be a clone of the repo) starts a run when CI fails or an issue is opened, and each works in a clone of its own next to yours and proposes every pull request before opening it. Or type your own. |
| `/goal-new <objective>` | Create a goal that works in the current directory. It suggests a title (or give one: `/goal-new <name>: <objective>`) and asks how often it should run, with a suggestion first (see below). |
| `/goal-run <goal>` | Queue a run now |
| `/goal-pause <goal>`, `/goal-resume <goal>` | Pause or resume a goal |
| `/todo <text>`, `/todo done <id>`, `/todo` | Add to your to-do list for this project, tick one off, or show the list |
| `/goal-schedule <goal> <when>` | Set when it runs on its own: `every 30m`, `every 6h`, `every 1d`, optionally `between 08:00-20:00`; `cron 0 9 * * 1-5`; `one-off`; or `off` for on demand only. An interval's first run starts within a minute. |

Goal names match by exact name, then prefix, then any part of the name. If more than one goal matches, the command lists them.

### Your to-do list

Goals look after things in the background; the to-do list is the backlog for what you build with Claude yourself. Working on a project, ideas and decisions pile up to come back to, and a `/clear` or a context compaction loses them. The to-do list keeps them beside the chat, outside the conversation, and you pick one up later with **Plan** or **Start**. A list can hold anything, not only code work.

- `/todo <text>` adds to this project's **To do** list (made the first time). Or ask Claude: "add that to the list". Claude only adds when asked, or offers when an idea is clearly being put off.
- In the pane, open a list to see its open to-dos, each with its id (`☐ 1.3 Set autonomy…`). Press ☐ to tick one off; a toast says how to undo. **n done** shows the ticked ones, and pressing one puts it back.
- Press a to-do's text to expand it: the full text, any notes, and **Ask…**, **Plan**, **Start** and **Edit**. All three bring it into this conversation, where Claude can ask you things. **Ask…** opens a box for your question about the to-do; Claude answers with nothing changed. Press Enter on an empty box to get Claude's opinion and trade-offs instead. **Plan** turns plan mode on with Claude Code's `/plan` (or, without it, asks Claude to enter plan mode) and asks Claude to plan it for you to review; if the session already has a plan, `/plan` shows it first. In plan mode Claude Code doesn't let Quarterdeck change anything, so ticking, editing, approving and the like wait until it ends (Shift+Tab). **Start** asks it to begin. The to-do shows ◐ until it's ticked off (Claude ticks it with `complete_todo` when it's done). **Edit** opens a box holding the to-do's text: change it and press Enter, and a toast shows the old wording. To-dos don't run in the background; goals do.
- **+ Add** under an open list opens a box (already focused): type the to-do and press Enter. Or use `/todo <text>`.
- After a compaction, say "check my list": Claude reads it with the `todos` tool. Nothing is added to the conversation otherwise: no hooks, no reminders.

A list is any active Quarterdeck plan in the project's directory, and its to-dos are the plan's tasks, so a plan made earlier (like a roadmap) shows up as a list. A plan with one top task over several (`1` over `1.1`, `1.2`, ...) shows the inner ones. Archive a plan to remove its list.

### Schedules and one-off goals

Goals lean towards running on a schedule: most are ongoing work. When you create one (or press **Set schedule**), a small model (Haiku) reads the name and objective and suggests how often it should run, and a title if you didn't give one (the objective's first words stand in when the model isn't available). "maintain", "keep" or "check" suggest daily, an inbox or triage hourly, monitoring every 6 hours, a report weekly, and "install", "set up" or "migrate" a one-off. Keyword rules stand in when the model isn't available. You pick from four choices with the suggestion first, or type your own (`12h`, `30d`, `2 weeks`, `weekly`, `monthly`, `cron 0 9 * * 1-5`, `off`). Dismissing the question keeps the suggestion. For a goal about reacting to things that arrive (new issues, new mail, a new release; or an objective that says "watch for …"), `/goal-new` suggests **When something happens (watch)** first, with the timer it would otherwise use next. Choosing it creates the goal with a daily run as a backstop and then asks Claude, in the conversation, to set up the watch with the goal-watches skill: Claude writes and tries the command, and you confirm it before it is set.

A **one-off** goal runs once, straight away. When its run ends with nothing left open (no proposals waiting, no open items), it's done and moves to **Done**. If it proposed something, it stays until you decide: approving runs it again to carry the action out, and rejecting runs it again to revise. **Run again** brings a done one-off back for another run.

## Tools Claude can call

| Tool | |
| --- | --- |
| `goals_status` | Every goal: what waits for approval (with item ids), runs, health. Read-only. |
| `goal_detail` | One goal's open items, recent runs and memory. Read-only. |
| `approve_item`, `reject_item` | Approve or reject a proposal. **Asks you first.** |
| `run_goal` | Queue a run. **Asks you first.** |
| `todos`, `add_todo`, `complete_todo`, `edit_todo` | Read your to-do lists, add to one (when you ask, or after offering), tick one off (when you say it's done), reword one (when you ask; a toast shows the old wording). |
| `update_goal` | Change a goal's name, objective, standing instructions, autonomy per category, tool rules, memory, watches or model, or pause it. **Shows you each change and asks you first.** Runs can't use it. |
| `set_schedule` | Set or clear a goal's schedule (same forms as `/goal-schedule`). **Asks you first.** |

Ask things like "what do my goals need?" or "approve the Alice reply".

## Alerts and status line

- The status line shows `Quarterdeck: 2 need you · Inbox running`, or `Quarterdeck: offline`.
- A toast appears for each new proposal or failed run. If several arrive at once, they become one toast.
- With system notifications on, you also get a notification through your Claude Code notification channel, at most once a minute per goal.
- **Questions from a run:** when a run needs something only you can give or do (which job sites, connecting Gmail, allowing a site in Chrome), it asks under **Needs you** with **Answer…** and **Done**, and alerts you like a proposal. Your answer goes to the goal's memory and the run carries on. From the conversation, just reply; Claude answers it with `answer_item`.
- **On your phone:** with Remote Control connected and mobile push on in `/config`, an alert reaches the Claude app when you haven't typed (at the terminal or from the phone) for 5 minutes. The plugin passes it to Claude, which sends the push; reply "approve" or "reject, because ..." in the session, and confirm. Each relayed alert is a short turn, so the plugin first tries the push itself: if Claude Code answers that you're at the terminal, that Remote Control isn't connected or that mobile push is off, nothing is relayed (the toast already told you). In the last two cases the pane says alerts can't reach your phone, with **Connect** to run `/remote-control`; a new goal's message reminds you too, until a message from your phone shows it's connected. (A push the plugin sends itself is reported as sent but doesn't arrive in Claude Code 2.1.319, so that path, the `phone_push` setting, is off until it's fixed.) `goals_status` shows what happened to the last alert and its push.
- While goal runs are going, a band above the prompt shows which (`● Goal run: Inbox · in the background`).

## Settings

Set these in `/config` → quarterdeck-goals, or under `pluginConfigs` in `~/.claude/settings.json`:

| Setting | Default | |
| --- | --- | --- |
| `url` | `http://localhost:3000` | The web app's address, only for "Open in browser" links |
| `poll_seconds` | `15` | How often the pane checks for changes. It checks every 5 s while a run is open, and backs off to a minute while Quarterdeck isn't connected. Each check is one `goals_overview` call, answered `changed: false` when nothing changed. |
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
hooks/api.ts        the quarterdeck MCP tools it calls, and the settings
hooks/model.ts      pure functions: cards, matching, alert diffing, formatting
hooks/state.ts      session state accessors (contract in types/index.d.ts)
```

To check it: `claude plugin validate plugins/quarterdeck-goals` and `claude plugin test plugins/quarterdeck-goals`. The tests run each drawing on the terminal and desktop surfaces against a fake quarterdeck server and fake subagents (`tests/fixtures.ts`).

What a run may do lives in the guard plugin, not here: the engine never shows a plugin the calls its own timers and buttons cause, so this plugin's hooks can't see a run its scheduler started.

## License

Apache License 2.0.
