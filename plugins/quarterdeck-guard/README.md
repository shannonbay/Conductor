# quarterdeck-guard

A Claude Code plugin that keeps each Quarterdeck goal run within its goal. [Quarterdeck](https://github.com/shannonbay/Quarterdeck) gives Claude Code standing goals that run on a schedule in background subagents and ask before they act. This plugin works alongside **quarterdeck-goals**, which starts those runs; without this plugin, quarterdeck-goals starts no runs. On its own it does nothing.

It works in Claude Code only. It runs no program of its own, stores nothing and makes no network requests: it is one hooks module that checks each tool call of a goal run with the quarterdeck server that quarterdeck-goals brings. It does change what a goal run is allowed to do, as described next.

## What it does

For every subagent that quarterdeck-goals started for a goal run:

- **Run tagging.** Each Quarterdeck call the run makes carries its run (`run_scope`), so it acts on that run's goal and never switches the open plan of your own conversation.
- **The goal's autonomy.** Tools the goal maps to an action category (its `tool_map`) go through the goal's guard. An `off` category is refused. A `propose` category is refused until you approve a proposal for it, and from then on the guard doesn't object for as many calls as that action takes (trashing a sender's threads, the clicks of an unsubscribe page), until the run marks the item done. The guard doesn't object to an `auto` category, until the run reads untrusted content: once it has used a tool that reads mail, web pages or the like (web fetch and search, the browsers, Gmail's readers, or any tool the goal maps to the category `untrusted`), or its brief carried watch events or memory an earlier such run wrote (until you Trust that memory in the Goals pane), its `auto` categories need approval like `propose` ones for the rest of the run, so text written to steer it can't take an action you didn't approve. Every decision is recorded.
- **Quarterdeck's own data is off limits.** A run's shell command (Bash, PowerShell) that names Quarterdeck's folder (`~/.quarterdeck`, or `~/.conductor` from before the rename), its database file or the `QUARTERDECK_DB` variable, and a file tool's path inside that folder or at the database, are refused whatever the goal's tool rules say. Writing the database directly would let a run approve its own proposals or change its own autonomy, and the runner folder holds what the standing session starts. For this rule the guard sends the call's command and path fields (nothing else) to `guard_check`. It matches names, so a command that reaches the database without naming it (a script written to another file) gets past it; sandboxing goal runs is what closes that.
- **It refuses, it never allows.** When the guard doesn't object, the call goes on to Claude Code's own permission rules, exactly as if the guard weren't there: an allow rule lets it through, auto mode's safety review judges it, and otherwise Claude Code asks you. So `auto` means "Quarterdeck doesn't object", not "allowed": for a run to act without asking, Claude Code must allow the tool too. The Goals pane lists the allow rules a goal's `auto` tools need ("Claude Code allow rules") and Claude can add them for you. Tools outside the map, and Quarterdeck's own tools, follow your session's permission rules in the same way.
- **Your actions stay yours.** A run can't approve, reject, cancel, pause, change a goal's schedule or settings (`update_goal`), create goals or delete memory, can't queue more runs, and can't start other agents.
- **Stopped runs are reported.** When a run's agent stops on your usage limit or an error, the guard tells Quarterdeck (`report_run_end`): a usage limit skips the run and holds goal runs until the reset, and another error fails the run with its message.
- **What a run is doing, and when it waits for you.** The guard tells Quarterdeck each tool call a run makes (`run_progress`), so the Goals pane's line under the goal shows the run's latest step. When Claude Code puts one of a run's calls to you as a permission prompt, the pane says the run is waiting for your permission and on which call, until the call is answered.
- **Reports stay out of your chat.** A run's report is its `end_run` summary, shown in the Goals pane. The run's final message isn't handed back into your conversation.

It also refuses those person-only Quarterdeck actions to Claude in your conversation and to other agents. quarterdeck-goals itself takes them when you press the pane's buttons.

## Everything it does by itself

Claude Code's plugin directory asks a plugin to say plainly what it does without being asked. This is all of it; the source is `hooks/register.ts`.

**Tools it calls itself.** Only three, both on the local quarterdeck server that quarterdeck-goals brings (under whichever name the session has: `mcp__plugin_quarterdeck-goals_quarterdeck__` or `mcp__quarterdeck__`):

- `guard_check`, for each tool call a goal run's agent makes that the goal's tool rules may cover, with the run id and the tool's name (not its input). The answer is "deny, because …" or "no objection".
- `report_run_end`, when a run agent's turn ends, with the run id, the agent's final message, why the turn ended and its token usage, so the run's tokens are counted and a stop on your usage limit or an error is recorded.
- `run_progress`, when a goal run's agent starts a tool call other than Quarterdeck's own, when Claude Code puts one to you as a permission prompt, and when the call has finished, with the run id and a short label for the call: the tool's name and the first line of its command, file path, address or query, cut to 80 characters (`Bash: npm test`). The Goals pane shows it.

It also reads the engine's list of running agents (`$.agent.list()`) to tell a goal run's subagent (`spawnedBy: quarterdeck-goals`, description `Goal: <name> (<run id>)`) from any other.

**What it fetches, runs and sends.** Nothing outside your computer: it makes no network requests, runs no commands and starts no agents. What it reads (agent records, a run's tool names and call labels, a run agent's final message, messages handed back to your conversation) goes only to the local quarterdeck server, which keeps it in `~/.quarterdeck/tasks.db`.

**The permission hook** (`tool.check`) only ever refuses, or passes the check on to Claude Code's own permission rules; it never allows. It refuses:

- for a goal run's agent: the person-only Quarterdeck tools (`decide_item`, `cancel_run`, `set_goal_status`, `update_goal`, `create_goal`, `delete_goal`, `delete_memory`, `set_schedule`, `run_goal` and the rest), quarterdeck-goals' own tools (`mcp__quarterdeck-goals__*`), and the Agent tool (a run doesn't start other agents);
- for Claude in your conversation and other agents: the same person-only tools, except `run_goal`. The quarterdeck-goals plugin itself still uses them when you press its buttons, and to start and stop runs.

Everything else goes on to your permission rules unchanged.

**Hooks on tool calls** (`tool.call`), for a goal run's agent only:

- **Changes a tool's input**: adds `run_scope` (the run's id) to a Quarterdeck server call that doesn't already carry it, so the call acts on that run's goal and never on the plan open in your own conversation. A call that already carries it is left exactly as it is (auto mode refuses a call whose input changes after its review).
- **The goal's guard**: before any other tool runs, asks `guard_check` (with the call's `command`, `file_path`, `notebook_path`, `path` and `pattern` fields, for the rule on Quarterdeck's own data); on "deny" the call is refused with the reason, and otherwise it goes on unchanged, reported to `run_progress` as it starts and when it has finished.
- **The handback goes on**: `SubagentHandback`, the tool a subagent's report comes back to your conversation through, runs as usual without a guard check, so Claude Code counts the report delivered and doesn't ask the run to send it again; `session.receive` (below) then keeps the report out of your chat, because a run reports in the Goals pane.
- **Answers in place of a tool**: this plugin's own `status` tool (`mcp__quarterdeck-guard__status`, read-only) answers that runs are guarded, with the number of runs it knows and its last few turn ends; quarterdeck-goals starts no run without it.

**Other hooks:**

- `classic.PermissionRequest`: when Claude Code is about to ask you about a run agent's tool call, sends `run_progress` that the run waits for your answer, then passes the request on unchanged (`return next(e)`). It never answers the request itself; Claude Code asks you as usual.
- `turn.complete`: for a run agent, sends `report_run_end` as above. Other turns are passed on untouched.
- `session.send`: stops a run agent's messages to your conversation (the run reports through `end_run`). Other messages go on.
- `session.receive`: reads a message arriving in your conversation only to recognise a run's handed-back report (by the sending agent, or by matching a run agent's last answer) and keep it out of your chat. Everything else goes on unchanged.
- `session.start`: registers the `status` tool.

## Why it is a separate plugin

The engine never shows a plugin the calls that its own timers and buttons cause. quarterdeck-goals starts most runs from its scheduler timer, so its own hooks would never see what those runs do. This plugin sees them.

It recognises a run's subagent by the engine's record of who spawned it (`spawnedBy: quarterdeck-goals`), which a model can't fake, plus the run id in the subagent's description (`Goal: <name> (<run id>)`).

## Install

It is installed with quarterdeck-goals, which depends on it. To install it on its own:

```bash
claude plugin marketplace add shannonbay/Quarterdeck#release
claude plugin install quarterdeck-guard@quarterdeck --scope user
```

Its rules match the quarterdeck server's tools under both names: `mcp__plugin_quarterdeck-goals_quarterdeck__*` (the server quarterdeck-goals brings) and `mcp__quarterdeck__*` (one added by hand). `npm run doctor` reports whether both plugins are installed.

## Development

`hooks/register.ts` holds all of it. Check it with `claude plugin validate plugins/quarterdeck-guard` and `claude plugin test plugins/quarterdeck-guard`.

## License

Apache License 2.0.
