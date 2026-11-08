# Conductor

Standing goals for AI agents — "keep my inbox under control", "triage new issues", "keep dependencies current" — run by Claude Code, checked by you.

An agent session ends; the work doesn't. Conductor keeps everything a long-lived goal needs **outside** the agent: its instructions, what's open, what you approved or rejected, and the rules it has learned. On a schedule (or a webhook, or a failing health check) it starts a fresh run in a background Claude Code subagent, hands it a one-call brief, and records what the run did for the next one. You stay in charge from the **Goals pane** beside your Claude Code chat: approve or reject proposed actions, and let the agent act on its own one category at a time once you trust it.

It's an **MCP server** (the tools agents use) and two **Claude Code plugins**: `conductor-goals` runs goals and shows the Goals pane, and `conductor-goals-guard` keeps each run within its goal. An optional **web app** adds goal pages in a browser, webhook triggers and a UI for plans. Everything lives in one local SQLite database.

## Persistent goals

A goal is an objective that never finishes. Create one in Claude Code with `/goal-new <name>: <objective>` (it works in the session's directory), or from the web app's home page (**+ New goal**) with standing instructions and a schedule too.

- **Runs.** Each run is a fresh background subagent in your Claude Code session, with its own context: it doesn't interrupt your conversation, and its report goes to the Goals pane, not your chat. It calls `get_goal_brief` — objective, instructions, memory, your decisions since the last run, open items, recent run summaries, latest health — handles what's new, and ends with `end_run` and a summary for the next run.
- **Triggers.** Every N minutes (with optional active hours), a cron expression, **Run now**, a **webhook** with a per-goal secret, or a failing **health check**.
- **Work items.** Each thing the agent handles is an item, deduplicated by an external ID (e.g. an email's ID) so it's never handled twice. Resolved items are hidden after 7 days.
- **Autonomy per action category** (e.g. `email.archive`, `email.send`): *off*, *propose* (the agent asks first — the default), or *auto*. Proposals wait under **Needs you**; approve and the next run carries the action out; reject with feedback and the feedback becomes **memory** later runs follow. After 10 approvals in a row, the page suggests switching that category to *auto*.
- **Enforcement.** With tool rules (`mcp__gmail__send*` → `email.send`), the **conductor-goals-guard** plugin blocks a run's tool call that the goal's autonomy doesn't allow, e.g. sending mail without an approved proposal. A run also can't approve its own proposals or touch your conversation's open plan. (Runs started the old way, by the web app through the channel, use the opt-in goal-guard hook instead: `npm run setup-hooks --prefix mcp -- --guard`.)
- **Health.** A command that exits 0 while the goal is being met; the last number it prints is charted (e.g. unread mail older than a day). A failure can start a run.
- **Memory.** Rules, facts and preferences — written by you, learned by the agent, or taken from your feedback. Pin what must always be included.

Goals run while Claude Code is open with both plugins installed. With several sessions open, one at a time runs them. `npm run doctor` tells you when they can't run. Design: [`specs/persistent-goals.md`](specs/persistent-goals.md).

## Plans: long work that outlives one session

The same machinery works for finite projects. A **plan** is a task tree that lives outside the context window: the agent decomposes work into sub-tasks, records results and structured state, and abandons dead ends with a reason so the next attempt — or the next session — doesn't repeat them. Goals are built on plans: a goal's work items are a plan's tasks.

Each task has a goal, a status (`pending` → `active` → `completed` | `abandoned`), a result, structured `state`, an `abandon_reason`, and optional `depends_on`. **Task IDs are tree addresses** — `"1.2.3"` is the third child of `"1.2"` — so structure is legible in every response. Each tool call returns only the immediate context (task, parent, siblings, children, stats), so calls stay small however big the tree grows.

### Verification gates

A task (or goal item) can carry checks that must pass before it's completed:

- **Acceptance criteria** — the agent gives evidence for each one (`set_status` with `evidence`).
- **Verify command** — e.g. `npm test -- auth`; Conductor runs it in the working directory and refuses completion unless it exits 0 (default timeout 5 minutes, last 4 KB of output kept).
- **Human approval** — the task waits for you to approve or reject in the web UI.

Agents can't weaken gates once a task has started. You can edit them, run checks, approve or reject, or complete a task anyway with a recorded reason. Every check result is kept as evidence.

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

**Plans and tasks** (also used on goal items)

| Tool | Description |
|---|---|
| `list_plans` / `create_plan` / `open_plan` / `archive_plan` | Manage plans |
| `create_task` / `provision_tasks` | Add one task, or a whole sub-tree in one call |
| `get_context` | Current task with parent, siblings, children and stats |
| `update_task` | Record progress: result, structured state patch, notes |
| `set_status` | `active`, `completed` (runs gates) or `abandoned` (with a reason) |
| `next_task` | What to do next: continue, start, complete, fix a failed check, or carry out an approved proposal |
| `synthesize` | Summarise a task's children before completing it |
| `verify_task` | Run a task's verify command without completing it |
| `get_history` | Recent changes, by agents or in the UI, with old and new values |

## Web UI

The Next.js app shares the SQLite database. Besides the goals pages, it provides:

- **Live task tree** — hierarchical view with status indicators, updates in real time via WebSocket
- **Detail pane** — full task detail, state, result, notes, and inline editing
- **Activity feed** — event log showing what the agent did and when
- **Transcript panel** — full conversation history per session, with collapsible tool call inputs and results
- **Agent controls** — start, pause, resume, cancel; inject messages mid-run via the prompt bar
- **AI plan generation** — generate or modify a task tree with a single prompt

AI features (plan generation, task decomposition, agent execution) run through a **Claude Code Channels** session on your machine — using your claude.ai plan subscription rather than a separate API key.

## Quickstart

### MCP server (Claude Code)

```bash
git clone https://github.com/shannonbay/Conductor
cd Conductor
npm install
cd mcp && npm run build
```

Add to your Claude Code MCP config (`~/.claude/claude_desktop_config.json` or project `.mcp.json`):

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

Start (or `/reload-plugins` in) Claude Code with the `conductor` MCP server configured as above, then type `/goals` to open the Goals pane. That's all goals need: no web app, no channel. Due runs start on their own while Claude Code is open. conductor-goals starts no run without the guard plugin, and the pane says so.

See [`plugins/conductor-goals`](plugins/conductor-goals/README.md) for the pane, commands, settings and how runs work, and [`plugins/conductor-goals-guard`](plugins/conductor-goals-guard/README.md) for what a run may do.

### Web UI (optional)

Goal pages in a browser, webhook triggers (`/api/goals/:id/trigger`), and the plan UI with its AI features. Goals don't need it; the web app doesn't start goal runs unless you set `CONDUCTOR_WEB_RUNS=1` (the old path, through the channel).

The web UI uses [Claude Code Channels](https://code.claude.com/docs/en/channels) for all AI features. You need Claude Code v2.1.80+ with a claude.ai login (Pro or Max plan).

**1. Add both servers to your `.mcp.json`:**

**macOS / Linux:**

```json
{
  "mcpServers": {
    "conductor": {
      "command": "node",
      "args": ["/path/to/Conductor/mcp/dist/index.js"]
    },
    "conductor-channel": {
      "command": "npx",
      "args": ["tsx", "/path/to/Conductor/channel/src/server.ts"]
    }
  }
}
```

**Windows:** `npx` requires a `cmd /c` wrapper:

```json
{
  "mcpServers": {
    "conductor": {
      "command": "node",
      "args": ["C:/path/to/Conductor/mcp/dist/index.js"]
    },
    "conductor-channel": {
      "command": "cmd",
      "args": ["/c", "npx", "tsx", "C:/path/to/Conductor/channel/src/server.ts"]
    }
  }
}
```

**2. Start the web app:**

```bash
cd web && npm run dev
```

**3. Launch Claude Code with the channel enabled:**

```bash
claude --dangerously-load-development-channels server:conductor-channel
```

Open [http://localhost:3000](http://localhost:3000). The settings gear (⚙) shows a green dot when Claude Code is connected. The web app, MCP server, and channel server all share the same database (`~/.conductor/tasks.db`).

> **Note:** `--dangerously-load-development-channels` is required during the Channels research preview (Claude Code v2.1.80+). Custom channel plugins are not yet on the approved allowlist.

### Your first goal

1. Give your Claude Code session the tools the goal needs (e.g. a mail MCP server for an inbox goal). Runs are subagents of that session, so they get the same tools.
2. In the goal's directory, run `/goal-new Inbox: keep my inbox under 20 unread`, then `/goal-run inbox` (or **Run now** in the pane). In the web app you can also give it standing instructions and a schedule.
3. Set each action category to *off*, *propose* or *auto* (in the web app's goal **Settings**). Keep anything irreversible at *propose* or *off* to start. Unlisted categories are *propose*.
4. Optional: add **tool rules** (tool name → category) so the guard plugin blocks actions the goal doesn't allow, and a **health check** command to chart how the goal is doing.
5. Approve or reject what the Goals pane shows under **Needs you** (`/goals`). Your rejections become memory, so the agent improves run by run.

## Checking your setup

```bash
npm run doctor
```

Rebuilds `core/` and `mcp/`, then checks Node.js, the SQLite native module, the database and schema, `.mcp.json`, the Claude Code hooks, both goal plugins, the channel server, the web UI, and whether your active goals can run. Anything wrong comes with the command to fix it.

## Database

Both the MCP server and web app write to `~/.conductor/tasks.db` (SQLite, WAL mode). Override the path with the `CONDUCTOR_DB` environment variable — set it to `:memory:` in tests for an isolated in-memory database. The schema lives in one place, `core/src/migrate.ts`, and every change made by Claude or in the UI is recorded in the `events` table (shown in the activity feed and by `get_history`).

## Project structure

```
Conductor/
  core/              Shared schema, migrations and queries (@conductor/core)
  channel/           Claude Code channel server (MCP over stdio + HTTP :8789)
    src/server.ts    Entry point — MCP server + HTTP bridge
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
  web/               Next.js monitoring and control UI
    app/             App Router pages and API routes
    components/      React UI components
    lib/             DB layer, channel client, agent runner, WebSocket broadcaster, planning
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
cd web && npm test   # web API, poller, request guard

claude plugin test plugins/conductor-goals        # the plugins (Claude Code's test kit)
claude plugin test plugins/conductor-goals-guard
```

The packages use Vitest with `CONDUCTOR_DB=:memory:` so tests are isolated and leave no files behind.

## Configuration

| Env var | Default | Description |
|---|---|---|
| `CONDUCTOR_DB` | `~/.conductor/tasks.db` | Path to SQLite database; use `:memory:` for tests |
| `CONDUCTOR_CHANNEL_URL` | `http://127.0.0.1:8789` | URL of the channel server (web app → channel) |
| `CONDUCTOR_CHANNEL_PORT` | `8789` | Port the channel server listens on |
| `CONDUCTOR_REQUIRE_DECOMPOSE` | off | MCP server: `1` blocks activating a task with no sub-tasks unless `state.atomic` is true |
| `CONDUCTOR_STRICT_COMPLETE` | off | MCP server: `1` blocks completing a task while any child is unresolved (otherwise a warning) |
| `CONDUCTOR_WEB_RUNS` | off | Web server: `1` makes the web app start goal runs itself, through the channel (the old path; otherwise the conductor-goals plugin runs them) |
| `CONDUCTOR_ALLOWED_HOSTS` | — | Web server: extra `host:port` values to accept besides localhost (comma-separated) |
| `BRAVE_SEARCH_API_KEY` | — | Optional; enables `web_search` tool in agent runs |

## License

Apache License 2.0. See [LICENSE](LICENSE).
