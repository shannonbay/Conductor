# quarterdeck-guard

A Claude Code plugin that keeps each Quarterdeck goal run within its goal. It works alongside **quarterdeck-goals**, which starts goal runs in background subagents; without this plugin, quarterdeck-goals starts no runs.

## What it does

For every subagent that quarterdeck-goals started for a goal run:

- **Run tagging.** Each Quarterdeck call the run makes carries its run (`run_scope`), so it acts on that run's goal and never switches the open plan of your own conversation.
- **The goal's autonomy.** Tools the goal maps to an action category (its `tool_map`) go through the goal's guard. An `off` category is refused, a `propose` category is refused until you approve a proposal for it, and then allowed for as many calls as that action takes (trashing a sender's threads, the clicks of an unsubscribe page) until the run marks the item done, and an `auto` category is allowed. Every call is recorded. An allowed call is allowed outright, so Claude Code's own check (auto mode's safety review, or a permission prompt) doesn't block an action you approved: map the tools an action uses, or Claude Code alone decides them. Tools outside the map follow your session's own permission rules.
- **Your actions stay yours.** A run can't approve, reject, cancel, pause, change a goal's schedule or settings (`update_goal`), create goals or delete memory, can't queue more runs, and can't start other agents.
- **Stopped runs are reported.** When a run's agent stops on your usage limit or an error, the guard tells Quarterdeck (`report_run_end`): a usage limit skips the run and holds goal runs until the reset, and another error fails the run with its message.
- **Reports stay out of your chat.** A run's report is its `end_run` summary, shown in the Goals pane. The run's final message isn't handed back into your conversation.

It also refuses those person-only Quarterdeck actions to Claude in your conversation and to other agents. quarterdeck-goals itself takes them when you press the pane's buttons.

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
