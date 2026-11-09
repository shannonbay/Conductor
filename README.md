# Conductor

Standing goals for AI agents — "keep my inbox under control", "triage new issues", "keep dependencies current" — run by Claude Code, checked by you.

An agent session ends; the work doesn't. Conductor keeps everything a long-lived goal needs **outside** the agent: its instructions, what's open, what you approved or rejected, and the rules it has learned. On a schedule (or a webhook, or a failing health check) it starts a fresh run in a background Claude Code subagent, hands it a one-call brief, and records what the run did for the next one. You stay in charge from the **Goals pane** beside your Claude Code chat: approve or reject proposed actions, and let the agent act on its own one category at a time once you trust it.

It's an **MCP server** (the tools agents use) and two **Claude Code plugins**: `conductor-goals` runs goals and shows the Goals pane, and `conductor-goals-guard` keeps each run within its goal. An optional **web app** adds goal pages in a browser and webhook triggers. Everything lives in one local SQLite database.

What a scheduled prompt (Claude Code's `/schedule`) can't give you: a goal remembers between runs (its items, memory and your past decisions), and it can't act beyond what you've approved, because the approval gate is enforced outside the model, not just asked for in the prompt.

![The Goals pane: five goals with their last and next runs and Reschedule, Run now and Pause, then the to-do lists, with an expanded to-do showing Ask, Plan and Start](docs/goals-pane.png)

## Persistent goals

A goal is an objective that never finishes. Type `/goal-new` alone to start from a ready-made goal (unsubscribe from mailing lists, a weekly job scan, tidy your Downloads, inbox triage, keep your GitHub profile current), each with its rules and schedule set. Or create your own with `/goal-new <name>: <objective>` (it works in the session's directory, and asks how often it should run, suggesting a schedule from the objective), or from the web app's home page (**+ New goal**) with standing instructions too. A goal can also be a **one-off**: it runs once and, when nothing is left open, moves to the pane's **Done** section.

The pane also keeps **your to-do list** for the project (`/todo <text>`, or ask Claude to add something): the ideas and decisions of a long conversation, kept where a context compaction can't lose them. Any to-do can be brought into the conversation with **Plan** (plan mode, for you to review) or **Start**.

- **Runs.** Each run is a fresh background subagent in your Claude Code session, with its own context: it doesn't interrupt your conversation, and its report goes to the Goals pane, not your chat. It calls `get_goal_brief` — objective, instructions, memory, your decisions since the last run, open items, recent run summaries, latest health — handles what's new, and ends with `end_run` and a summary for the next run.
- **Triggers.** Every N minutes (with optional active hours), a cron expression, **Run now**, a **webhook** with a per-goal secret, or a failing **health check**.
- **Work items.** Each thing the agent handles is an item, deduplicated by an external ID (e.g. an email's ID) so it's never handled twice. Resolved items are hidden after 7 days.
- **Autonomy per action category** (e.g. `email.archive`, `email.send`): *off*, *propose* (the agent asks first — the default), or *auto*. Proposals wait under **Needs you**; approve and the next run carries the action out; reject with feedback and the feedback becomes **memory** later runs follow. After 10 approvals in a row, the page suggests switching that category to *auto*.
- **Enforcement.** With tool rules (`mcp__gmail__send*` → `email.send`), the **conductor-goals-guard** plugin blocks a run's tool call that the goal's autonomy doesn't allow, e.g. sending mail without an approved proposal. A run also can't approve its own proposals or change the goal's settings.
- **Health.** A command that exits 0 while the goal is being met; the last number it prints is charted (e.g. unread mail older than a day). A failure can start a run.
- **Memory.** Rules, facts and preferences — written by you, learned by the agent, or taken from your feedback. Pin what must always be included.

Goals run while Claude Code is open with both plugins installed. With several sessions open, one at a time runs them. `npm run doctor` tells you when they can't run. Design: [`specs/persistent-goals.md`](specs/persistent-goals.md).

## Under the hood: plans

A goal's work items are tasks in a **plan**, the task tree Conductor started with, and your to-do lists are plans too. Each item has a status (`pending` → `active` → `completed` | `abandoned`), a result, structured `state` and notes, and can carry checks that must pass before it's completed: **acceptance criteria** (the agent gives evidence for each), a **verify command** that must exit 0, and **human approval**. Every check result is kept.

The tools for building plans by hand (`create_plan`, `provision_tasks`, `next_task`, ...) are hidden from Claude by default, so they cost nothing in your sessions. Set `CONDUCTOR_TOOLS=all` on the MCP server to list them, e.g. to track a long multi-session project as a task tree.

## MCP tools

**Goals**

| Tool | Description |
|---|---|
| `list_goals` | Persistent goals with open items and items waiting for review |
| `get_goal_brief` | Start of a run: everything a fresh agent needs, in one call |
| `add_item` | Add a work item (deduplicated by `external_ref`); actions are proposed, recorded or refused per the goal's autonomy |
| `remember` / `forget` | Add a fact, rule or preference to the goal's memory; deactivate one an agent added |
| `end_run` | Finish a run with a summary for the next one |
| `run_goal` | Queue a run now |

The plugins also use `goals_overview`, `goals_tick` (one scheduler pass), `decide_item`, `cancel_run`, `set_goal_status`, `create_goal`, `delete_memory`, `attach_agent`, `fail_run` and `guard_check`. The guard plugin refuses the person's actions among them (approving, cancelling, pausing...) to agents and to Claude.

**Goal items**

| Tool | Description |
|---|---|
| `update_task` | Record progress on an item: result, structured state patch, notes |
| `set_status` | `active`, `completed` (runs its checks) or `abandoned` (with a reason) |

The plan tools are listed only with `CONDUCTOR_TOOLS=all`: `list_plans`, `create_plan`, `open_plan`, `archive_plan`, `create_task`, `provision_tasks`, `get_context`, `next_task`, `synthesize`, `verify_task` and `get_history`. Hidden tools still answer calls.

## Web app (optional)

The Next.js app shares the database and shows each goal as a page: items waiting for you (approve or reject), open items, runs, memory, the health chart, the guard's decisions, and settings (instructions, autonomy, tool rules, schedule, limits). It also takes **webhooks** (`/api/goals/:id/trigger`). Goals don't need it: they run from the Claude Code plugins.

## Quickstart

### MCP server (Claude Code)

```bash
git clone https://github.com/shannonbay/Conductor
cd Conductor
npm install
cd mcp && npm run build
```

Add the server for your user, so goals work in every Claude Code session, whatever folder it starts in:

```bash
claude mcp add --scope user conductor -- node /path/to/Conductor/mcp/dist/index.js
```

Or add it to one project's `.mcp.json`. Goals then work only in sessions started in that project:

```json
{
  "mcpServers": {
    "conductor": {
      "command": "node",
      "args": ["/path/to/Conductor/mcp/dist/index.js"]
    }
  }
}
```

Or run without compiling using `tsx` (macOS/Linux):

```json
{
  "mcpServers": {
    "conductor": {
      "command": "npx",
      "args": ["tsx", "/path/to/Conductor/mcp/src/index.ts"]
    }
  }
}
```

On Windows, use `cmd /c`:

```json
{
  "mcpServers": {
    "conductor": {
      "command": "cmd",
      "args": ["/c", "npx", "tsx", "C:/path/to/Conductor/mcp/src/index.ts"]
    }
  }
}
```

### Goals in Claude Code (the plugins)

The repository is a Claude Code plugin marketplace. From a terminal:

```bash
claude plugin marketplace add /path/to/Conductor
claude plugin install conductor-goals@conductor --scope user
claude plugin install conductor-goals-guard@conductor --scope user
```

Start (or `/reload-plugins` in) Claude Code with the `conductor` MCP server configured as above, then type `/goals` to open the Goals pane. That's all goals need; the web app is optional. Due runs start on their own while Claude Code is open. conductor-goals starts no run without the guard plugin, and the pane says so.

See [`plugins/conductor-goals`](plugins/conductor-goals/README.md) for the pane, commands, settings and how runs work, and [`plugins/conductor-goals-guard`](plugins/conductor-goals-guard/README.md) for what a run may do.

### Web app (optional)

```bash
cd web && npm run dev
```

Open [http://localhost:3000](http://localhost:3000) for goal pages and webhooks. It uses the same database (`~/.conductor/tasks.db`) and doesn't start goal runs: queued runs (Run now, a webhook, a failing health check) are started by the conductor-goals plugin within 30 seconds.

### Your first goal

1. Give your Claude Code session the tools the goal needs (e.g. a mail MCP server for an inbox goal). Runs are subagents of that session, so they get the same tools.
2. In the goal's directory, type `/goal-new` and pick a ready-made goal, or run `/goal-new Inbox: keep my inbox under 20 unread` and pick how often it runs (it suggests one: hourly, for an inbox). The first run starts within a minute. Change it later with `/goal-schedule inbox every 6h`. In the web app you can also give it standing instructions.
3. Set each action category to *off*, *propose* or *auto* (in the web app's goal **Settings**). Keep anything irreversible at *propose* or *off* to start. Unlisted categories are *propose*.
4. Optional: add **tool rules** (tool name → category) so the guard plugin blocks actions the goal doesn't allow, and a **health check** command to chart how the goal is doing.
5. Approve or reject what the Goals pane shows under **Needs you** (`/goals`). Your rejections become memory, so the agent improves run by run.

## Checking your setup

```bash
npm run doctor
```

Rebuilds `core/` and `mcp/`, then checks Node.js, the SQLite native module, the database and schema, `.mcp.json` and whether `conductor` is added for your user, leftover hooks from older versions, both goal plugins, the optional web app, and whether your active goals can run. Anything wrong comes with the command to fix it.

## Database

Both the MCP server and web app write to `~/.conductor/tasks.db` (SQLite, WAL mode). Override the path with the `CONDUCTOR_DB` environment variable — set it to `:memory:` in tests for an isolated in-memory database. The schema lives in one place, `core/src/migrate.ts`, and every change made by Claude or by you is recorded in the `events` table.

## Project structure

```
Conductor/
  core/              Shared schema, migrations and queries (@conductor/core)
  mcp/               MCP server (stdio transport, no HTTP)
    src/
      index.ts       Entry point — registers tools and dispatches calls
      cli.ts         `conductor doctor` setup checker
      schema.ts      Zod schemas for all tool inputs
      db.ts          Binds @conductor/core queries to one connection
      history.ts     Records MCP changes in the events log
      session.ts     In-memory open-plan tracking
      context.ts     Builds the context view returned by every tool
      tools/         One file per tool handler
  web/               Next.js goal pages and webhooks (optional)
    app/             App Router pages and API routes
    components/      React UI components
    lib/             DB layer, request guard, WebSocket broadcaster
    __tests__/       Vitest test suites
    server.ts        Custom HTTP + WebSocket server
  plugins/
    conductor-goals/        Claude Code plugin: goal runner (subagents), Goals pane, /goal* commands
    conductor-goals-guard/  Claude Code plugin: what a goal run may do
  .claude-plugin/    marketplace.json: makes the repo a plugin marketplace ("conductor")
  specs/             Original design specs
```

## Running tests

```bash
npm test             # all packages, from the repo root

cd core && npm test  # schema and migrations
cd mcp && npm test   # MCP tools and doctor
cd web && npm test   # goal API, poller, request guard

claude plugin test plugins/conductor-goals        # the plugins (Claude Code's test kit)
claude plugin test plugins/conductor-goals-guard
```

The packages use Vitest with `CONDUCTOR_DB=:memory:` so tests are isolated and leave no files behind.

## Configuration

| Env var | Default | Description |
|---|---|---|
| `CONDUCTOR_DB` | `~/.conductor/tasks.db` | Path to SQLite database; use `:memory:` for tests |
| `CONDUCTOR_TOOLS` | goals | MCP server: `all` also lists the plan tools (hidden by default) |
| `CONDUCTOR_REQUIRE_DECOMPOSE` | off | MCP server, plan tools: `1` blocks activating a task with no sub-tasks unless `state.atomic` is true |
| `CONDUCTOR_STRICT_COMPLETE` | off | MCP server, plan tools: `1` blocks completing a task while any child is unresolved (otherwise a warning) |
| `CONDUCTOR_ALLOWED_HOSTS` | — | Web server: extra `host:port` values to accept besides localhost (comma-separated) |

## License

Apache License 2.0. See [LICENSE](LICENSE).
