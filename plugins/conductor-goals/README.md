# conductor-goals

A Claude Code plugin that puts your Conductor goals beside the chat. You can approve or reject proposals, run, pause and inspect goals, and get alerts, all without leaving Claude Code. Claude can also check on your goals and act on them, always asking you first before it changes anything.

It talks only to the Conductor web app (default `http://localhost:3000`), so start that with `npm run dev --prefix web`.

## Install

From a terminal, with this repository checked out:

```bash
claude plugin marketplace add <path to the Conductor repo>
claude plugin install conductor-goals@conductor --scope user
```

Claude Code reads the plugin straight from `plugins/conductor-goals`, so after an edit run `/reload-plugins`. `npm run doctor` reports whether it is installed.

## The Goals pane

Open it with `/goals`. It opens on its own at start-up when something is waiting for you.

```
▸ Inbox active · run running
● Drafting a reply to Alice · 1m ago
last run completed 12m ago · 3 open
failing 18 ▁▃▅█
● Reply to Alice about Thursday
  email.send: Send: Thursday 2pm works.
[Approve] [Reject…]
Cancel run  Pause

Updated just now  Refresh
```

- Under each goal's name is one line saying what its agent is doing. While a run is going, that's the agent's latest step: a progress update, an item it added or finished, or a note it saved. Otherwise it says the run is queued, the goal is paused, what the next run will carry out, or the last run's summary. Claude's `goals_status` tool reports the same line.
- **Approve** or **Reject…** each proposal. Rejecting asks what should change, and your answer is saved to the goal's memory.
- **Run now**, **Cancel run** (asks you to confirm), **Pause** and **Resume**.
- **▸ name** expands a goal to show its objective, open items, last five runs with summaries, and memory. Each memory entry can be deleted (asks you to confirm).
- When you have approved a category every time lately, a hint suggests switching it to auto on the goal page.
- **Open in browser** opens the goal page.

Hotkeys while the pane has focus: `a`/`r` approve or reject the first proposal, `n` runs the first goal that can run, `g` refreshes, and `1`–`9` expand a goal.

## Commands

| Command | What it does |
| --- | --- |
| `/goals` | Open the Goals pane |
| `/goal-new <name>: <objective>` | Create a goal that works in the current directory |
| `/goal-run <goal>` | Queue a run now |
| `/goal-pause <goal>`, `/goal-resume <goal>` | Pause or resume a goal |

Goal names match by exact name, then prefix, then any part of the name. If more than one goal matches, the command lists them.

## Tools Claude can call

| Tool | |
| --- | --- |
| `goals_status` | Every goal: what waits for approval (with item ids), runs, health. Read-only. |
| `goal_detail` | One goal's open items, recent runs and memory. Read-only. |
| `approve_item`, `reject_item` | Approve or reject a proposal. **Asks you first.** |
| `run_goal` | Queue a run. **Asks you first.** |

Ask things like "what do my goals need?" or "approve the Alice reply".

## Alerts and status line

- The status line shows `Conductor: 2 need you · Inbox running`, or `Conductor: offline`.
- A toast appears for each new proposal or failed run. If several arrive at once, they become one toast.
- With system notifications on, you also get a notification through your Claude Code notification channel, at most once a minute per goal.
- While this session is carrying out a goal run, a band above the prompt shows which goal and run.

## Settings

Set these in `/config` → conductor-goals, or under `pluginConfigs` in `~/.claude/settings.json`:

| Setting | Default | |
| --- | --- | --- |
| `url` | `http://localhost:3000` | The web app's address |
| `poll_seconds` | `15` | How often it checks for changes. It checks every 5 s while a run is open, and backs off to a minute while the web app is unreachable. Each check is one request, and the web app answers `304` when nothing changed. |
| `alerts` | `all` | `all`, `proposals`, `failures` or `off` |
| `os_notifications` | `true` | Also send alerts as system notifications |

## Development

```
hooks/register.tsx  wiring: events, commands, tool hooks, pane and band
hooks/pane.tsx      the Goals pane
hooks/tools.ts      tools Claude can call, and the commands
hooks/sync.ts       reading the overview, polling, running actions
hooks/alerts.ts     toasts, notifications, status line
hooks/api.ts        the web app's API and the settings
hooks/model.ts      pure functions: cards, matching, alert diffing, formatting
hooks/state.ts      session state accessors (contract in types/index.d.ts)
```

To check it: `claude plugin validate plugins/conductor-goals` and `claude plugin test plugins/conductor-goals`. The tests run each drawing on the terminal and desktop surfaces against a fake web app (`tests/fixtures.ts`).

## License

Apache License 2.0.
