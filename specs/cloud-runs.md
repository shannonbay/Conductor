# Cloud runs: goals that gather while Claude Code is closed

Roadmap 1.15 (research) and the first design for 1.2 (runs with Claude Code closed). Status: research done, design proposed, not built.

## Why

Goals run only while Claude Code is open on the person's computer: it's the limit every reader asks about first. Claude Code's cloud **scheduled tasks** (formerly routines, `/schedule`) run on Anthropic's infrastructure with the laptop closed. Can a goal use one, without giving up the approval gate?

## What a scheduled task can do (research, 2026-11-09)

From the official page (code.claude.com/docs/en/routines) and the `RemoteTrigger` tool:

- **What it is:** a saved Claude Code configuration (a prompt, one or more GitHub repositories, connectors, a cloud environment) run as a full cloud session, autonomously, in auto mode. It stops for a person only when auto mode blocks repeatedly or an ask rule matches.
- **Triggers:** a schedule (recurring, or once at a set time), an API call (POST to the task's own endpoint with a bearer token; the token is made on the web only), or a GitHub event.
- **What it can reach:**
  - **Repositories it clones** on every run. It pushes to `claude/`-prefixed branches unless the prompt names another branch; branch protection rules apply to the person's GitHub access.
  - **claude.ai connectors** (Gmail, Slack, Linear…), routed through Anthropic, so they need no network allowlisting. All connected connectors are included by default; remove the ones a task doesn't need.
  - **The network:** the default environment allows a trusted allowlist only (others get 403). A custom environment can add domains or allow everything.
  - **Skills and MCP servers committed in the repository** (`.mcp.json` only for a single-repository task). Local MCP servers (`claude mcp add`) aren't available, so **the local Conductor server and its SQLite database are out of reach.**
- **Programmatic control:** yes. `RemoteTrigger` (the claude.ai routines API with the person's sign-in) can list, get, create, update and run tasks, attach GitHub-event triggers, list runs and read a run's log. `/schedule` does the same conversationally.
- **Limits:** runs use the person's subscription; 100 scheduled runs an hour per account, 30 Run now / API fires an hour per task. Pro, Max, Ultra, Team and Enterprise plans. Research preview: behaviour may change.
- **Identity:** everything a run does through GitHub or a connector appears as the person.

## What this means for goals

1. **The cloud run can't reach Conductor's state** (the MCP server and SQLite stay on the computer). State has to travel some other way: a git repository is the natural carrier, since every run clones its repositories and can push.
2. **The guard doesn't exist in the cloud.** The guard is a local plugin; a cloud run is held only by its prompt, the connectors it's given, and auto mode's checks. So **a cloud run must only gather and propose**; acting stays local, behind the guard, after approval. This keeps the approval gate whatever runs the goal.
3. **Connectors in the cloud carry their write tools** (Gmail's send and trash among them), and Conductor can't take them away. Mitigations: give a cloud goal only the connectors it reads from, say "propose only, never act" in its prompt, and rely on auto mode's check, which blocked an unapproved Gmail send in exactly this situation (a background run, roadmap 1.18). The README should say this plainly.

## Design: version 1

**A private state repository** (e.g. `<you>/conductor-state`), created once, holds per cloud goal:

```
goals/<goal-id>/brief.md        written locally: objective, instructions, memory, open items, recent decisions
goals/<goal-id>/seen.json       written locally: external_refs already handled (so the cloud never re-proposes)
inbox/<goal-id>/<run-time>.json written in the cloud: proposals and questions, one file per run
```

**Locally (the conductor-goals plugin, while Claude Code is open):**

- `/goal-cloud <goal>` makes a goal a cloud goal: it writes the goal's brief to the state repo and creates the scheduled task with `RemoteTrigger` (`create`): the goal's schedule, the state repo plus the goal's own repositories, only the connectors the goal needs, and a prompt built from a fixed template (below). The goal's local schedule is turned off so it doesn't run twice.
- **Each tick** (every 30 s, throttled to once every few minutes): `git pull` the state repo, import each new inbox file with `add_item` (proposals keep their action and category, so autonomy still applies: `off` is refused, `propose` waits for the person, and a cloud goal never gets `auto` acting in the cloud), move the file to `inbox/<goal-id>/imported/`, then rewrite `brief.md` and `seen.json` and push.
- **Approved proposals are carried out by a local run**, behind the guard, as now (approving already queues one). Alerts and phone pushes work as now, from the moment Claude Code is open.
- Changing the goal (update_goal, Reschedule, Delete) updates or deletes the task with `RemoteTrigger`.

**In the cloud (the scheduled task's prompt):**

> You gather for the Conductor goal "<name>". Read goals/<id>/brief.md and seen.json. Look for new work as the brief says, using only the connectors you have, for reading. **Never send, delete, archive, buy or change anything outside this repository.** Write what you found as one JSON file in inbox/<id>/ (proposals: title, external_ref, action category, summary, params; questions: title), commit it and push to main. If nothing is new, write nothing.

**Who sees what, when:** while the computer is off, cloud runs keep gathering and proposals pile up in the state repo. When Claude Code opens, they're imported, alert as usual, and wait under Needs you.

## Open questions (to settle before building)

1. **Can a plugin call `RemoteTrigger` itself** (`$.tool.call`), or must `/goal-cloud` ask Claude to do it with a submitted prompt? A short spike answers it.
2. **The create body's exact shape** (repositories, cron, connectors, environment): read from a `get` of a task made by hand, then build from that.
3. **Pushing to `main` of the state repo** from a cloud run (the default is `claude/` branches): allowed when the prompt names the branch, but branch protection could refuse it. Fallback: the cloud pushes to `claude/inbox` and the local side merges it.
4. **Approving while away:** v1 only gathers while the computer is off; approving still needs Claude Code open. A later step could open one GitHub issue per proposal in the state repo, so the GitHub app notifies the person and a comment ("approve") is imported as the decision.
5. **Which goals suit the cloud:** ones whose gathering reads from connectors, repositories or the web (job scan, GitHub profile, inbox triage). Not ones about the local computer (tidy Downloads).

## First steps when building

1. Spike: create, get, update and delete a throwaway task with `RemoteTrigger`; check whether a plugin can call it; record the body shape.
2. The state repo format and the local import (pull, `add_item`, archive, push), with tests on a local bare repo.
3. `/goal-cloud`, the prompt template, and the README's honest note on what a cloud run can and can't be stopped from doing.
