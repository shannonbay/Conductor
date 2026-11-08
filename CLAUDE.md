# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What This Is

Conductor runs **persistent goals** for AI agents — standing objectives like "keep my inbox under control" that never finish. A goal's state (instructions, open work items, memory, human decisions, run history) lives in SQLite outside any agent; the conductor-goals Claude Code plugin starts each due run in a background subagent, each run reads a one-call brief (`get_goal_brief`) and ends with a summary (`end_run`), and a human approves proposed actions from the Goals pane (or the goal page in the web app). The main use case is goals; **plans** (finite task trees with verification gates) are the underlying building block and still work on their own for long multi-session projects.

Parts: an **MCP server** (`mcp/`, the tools agents and the plugins call), two **Claude Code plugins** (`plugins/conductor-goals` runs goals and shows the Goals pane; `plugins/conductor-goals-guard` keeps each run within its goal), a **Next.js web app** (`web/`, optional: goal pages, webhooks, plan UI), and a **channel server** (`channel/`, bridges the web app into a running Claude Code session for plan AI features). Shared schema and logic live in `core/`. Design spec: `specs/persistent-goals.md` (phases 1, 2 and 2.5 built).

## Repository Structure

```
Conductor/
  package.json        — monorepo root (npm workspaces: ["core", "channel", "mcp", "web"])
  core/               — @conductor/core: the one schema, migrations and shared plan/task queries
    src/migrate.ts    — runMigrations(): every table, column and trigger lives here
    src/queries.ts    — db-first query functions used by both mcp/ and web/
    src/types.ts      — PlanRow, Task, NewPlan, NewTask, TreeStats
    src/index.ts      — openDatabase() / defaultDbPath()
  channel/            — Claude Code channel server (bridges Conductor UI ↔ Claude Code session)
    src/server.ts     — MCP server (stdio to Claude Code) + HTTP API (port 8789 to web app)
    package.json
    tsconfig.json
  mcp/                — MCP server (standalone tool, communicates over stdio)
    src/
      index.ts        — MCP entry point; registers all tools and dispatches calls
      schema.ts       — Zod schemas for every tool's input parameters
      db.ts           — Binds @conductor/core queries to one connection
      session.ts      — In-memory open-plan ID
      context.ts      — Builds context view objects
      tools/          — One file per MCP tool handler
    package.json
    tsconfig.json
    vitest.config.ts
  web/                — Next.js web app (shares the same tasks.db)
    app/              — Next.js App Router pages and API routes
    components/       — React components (TreePanel, DetailPane, ActivityFeed, etc.)
    lib/              — DB layer, planning, channel client, agent-runner, WebSocket broadcaster
    __tests__/        — Vitest test suites
    server.ts         — Custom HTTP + WebSocket server
    package.json
    tsconfig.json
    vitest.config.ts
  plugins/conductor-goals/ — Claude Code plugin: goal runner (runs in subagents), Goals pane, alerts, /goal* commands, tools for Claude
  plugins/conductor-goals-guard/ — Claude Code plugin: what a goal run may do (run tagging, autonomy guard, reports out of the chat)
  .claude-plugin/marketplace.json — makes the repo a plugin marketplace ("conductor")
  specs/
```

Both `mcp/` and `web/` connect to the same `~/.conductor/tasks.db` (SQLite WAL mode for concurrent access). Override with `CONDUCTOR_DB` env var.

## Commands

**`core/` must be built before `mcp/` or `web/` run or typecheck.** Their `prebuild`, `predev` and `pretypecheck` scripts do it automatically (`npm run build --prefix ../core`). Tests don't need it: both `vitest.config.ts` files alias `@conductor/core` to `core/src`. After changing `core/`, rebuild `mcp/` and reconnect the `conductor` server (`/mcp`) so Claude Code picks it up.

### Core (`cd core`)

```bash
npm run build       # Compile to dist/ (what mcp/ and web/ import at runtime)
npm test            # Schema, migration and revision-trigger tests
```

### MCP Server (`cd mcp`)

```bash
npm run build       # Compile TypeScript to dist/
npm run dev         # Run directly with tsx (no compile step)
npm run typecheck   # Type-check without emitting
npm run start       # Run compiled output from dist/
npm test            # Run all tests (vitest)
npm run test:watch  # Watch mode
```

Tests live in `mcp/src/tests/`. `vitest.config.ts` sets `CONDUCTOR_DB=:memory:`. Each test gets a clean slate via `beforeEach` in `src/tests/setup.ts`. Call tool handlers directly as async functions — no MCP transport needed.

To run a single test file: `npm test -- src/tests/tools/create_plan.test.ts`

When working in this repo, call `mcp__conductor__next_task` after opening a plan or finishing a task to see what to do next.

### Web App (`cd web`)

```bash
npm run dev         # Start custom HTTP + WebSocket server with Next.js (tsx server.ts, port 3000)
npm run build       # Production build
npm run typecheck   # Type-check without emitting
npm test            # Run all tests (vitest)
```

Tests live in `web/__tests__/`. `vitest.config.ts` sets `CONDUCTOR_DB=:memory:`. Each test gets a clean slate via `beforeEach` in `__tests__/setup.ts` which calls `clearAllData()` and `resetDb()`.

To run a single test file: `npm test -- __tests__/api/plans.test.ts`

### Channel Server (`cd channel`)

```bash
npm run dev         # Run directly with tsx src/server.ts
npm run build       # Compile to dist/
npm run typecheck   # Type-check without emitting
```

### Root

```bash
npm install         # Install all workspace dependencies
```

## MCP Server Architecture

**Data flow for every tool call:**
1. `src/index.ts` routes by tool name → calls the handler in `tools/`
2. Handler parses args with the Zod schema from `schema.ts`
3. Reads/writes SQLite via `db.ts` helpers
4. Checks/updates the in-memory open plan via `session.ts`
5. Returns a context view built by `context.ts`

## Web App Architecture

**Database layer** (`web/lib/db.ts`): Shared plan/task queries come from `@conductor/core` via a lazy `getDb()`. Adds web-only queries: `getFullTree()`, `lockSubtree()`, `unlockSubtree()`, `deletePlan()`, session CRUD, event log, transcripts.

**Migrations** (`core/src/migrate.ts`, re-exported by `web/lib/migrate.ts`): The only place the schema is defined; both processes run it on open. Adding a column uses try/catch around `ALTER TABLE` (SQLite lacks `IF NOT EXISTS` for ALTER). New columns added to a CREATE TABLE must also get an ALTER TABLE entry for existing databases, plus an UPDATE to backfill any NOT NULL semantics.

**Real-time updates**: SQLite triggers bump `plans.revision` on every task insert/update/delete and plan update, from any process. `web/lib/mcp-poller.ts` checks each watched plan's revision once a second and broadcasts `mcp_update` through `web/lib/ws-broadcaster.ts` when it changes. Custom server (`web/server.ts`) routes WebSocket upgrades for `/api/plans/:id/ws`.

**Request guard** (`web/lib/request-guard.ts`): `server.ts` rejects HTTP requests (403) and WebSocket upgrades whose `Host` isn't localhost/127.0.0.1/[::1] at the server's port, or whose `Origin` is present but foreign. This stops other websites from driving the local API (which can start agents). Allow extra hosts with `CONDUCTOR_ALLOWED_HOSTS=host:port,...`.

**AI backend — Claude Code Channels**: All AI inference (planning, plan generation, agent execution) routes through a running Claude Code session via the channel server, not a direct Anthropic API call. The web app never holds an API key.

- **`web/lib/channel-client.ts`**: HTTP client that talks to the channel server at `http://127.0.0.1:8789` (override with `CONDUCTOR_CHANNEL_URL`). Exports `requireChannel()` (throws `ChannelNotConnectedError` if no session), plus per-use-case functions (`planTasksViaChannel`, `modifyTasksViaChannel`, `generatePlanViaChannel`, `startAgentViaChannel`, `streamAgentEvents`).
- **`web/lib/planning.ts`**: `generatePlan()` and `modifyPlan()` call the channel client. Zod validation of Claude's response still happens here. Never writes to DB — callers use `/plan/accept` and `/modify-plan/accept` routes to commit.
- **`web/lib/plan-generator.ts`**: `generatePlan()` sends the plan's working directory to the channel; Claude Code explores it and calls `plan_proposal` back.
- **`web/lib/agent-runner.ts`**: `startAgent()` creates a session, locks the subtree, posts a `run_agent` request to the channel server (returns immediately with 202), then streams SSE events from `/stream/:requestId`. `cancelAgent()` is async (sends cancel to channel + updates DB). `pauseAgent()`/`resumeAgent()` update DB only (Claude Code continues running; soft pause).
- **`web/lib/api-utils.ts`**: `serverError()` returns HTTP 503 for `ChannelNotConnectedError` / `ChannelBusyError` automatically.

**Channel server** (`channel/src/server.ts`): Bun/Node.js process spawned by Claude Code over stdio (MCP). Simultaneously listens on HTTP `:8789`. One active request at a time — returns 503 if busy. For agent runs: 202 immediately + SSE stream on `GET /stream/:requestId`. For one-shot planning calls: long-polls until Claude calls the corresponding reply tool (`plan_proposal`, `tasks_proposal`, `tasks_diff`). Timeout: 120s for plan generation, 60s for task planning.

**User setup**: Add `conductor-channel` and `conductor` to `.mcp.json`, then:
```bash
claude --dangerously-load-development-channels server:conductor-channel
```
The settings gear (⚙) in the UI shows a green/red dot for session connection state.

## Key Design Details

**Task IDs are tree addresses**, not random IDs. A task's ID encodes its position: `"1"` is the root, `"1.2"` is the second child of root, `"1.2.3"` is the third child of `"1.2"`. `nextChildId()` in `db.ts` computes the next available child ID by counting direct children.

**`getChildren()` uses a LIKE query** on the ID prefix, then filters to the exact depth. IDs are structural and permanent — renaming/moving tasks is not supported.

**Session state is in-memory only** (`mcp/src/session.ts`). If the MCP server restarts, the client must call `open_plan` again to re-register the open plan. One MCP server serves the whole Claude Code session, subagents included, so a call with `run_scope` (added to every tool's schema; the guard plugin sets it on a goal run's calls) runs in a scope of its own, holding that run's plan and run, and never touches the process-wide open plan.

**`state` updates are shallow-merge patches.** `update_task` with `state_patch` merges at the top level.

**Every mutating MCP tool returns a context view** (result of `buildContext`). Clients never need a follow-up read after a write.

**`set_status` to `active` is blocked** if `depends_on` lists any sibling not yet `completed`.

**Forced decomposition (opt-in):** with `CONDUCTOR_REQUIRE_DECOMPOSE=1` in the MCP server's env, `set_status` to `active` is also blocked for a task with no children unless its `state.atomic` is `true`. This lives in the server (not a hook) because only the server knows which plan is open.

**Strict completion (opt-in):** with `CONDUCTOR_STRICT_COMPLETE=1`, `set_status` to `completed` throws while any child is not completed/abandoned (otherwise it's a warning in the response).

**Verification gates** (`core/src/gates.ts`): a task can carry `acceptance_criteria`, a `verify_command` and `requires_approval`. Completion runs them through `checkCompletion()`, shared by the MCP `set_status` and the web status route:
- Agents must pass `evidence` (one entry per criterion), the command must exit 0 (run in the plan's `working_dir`, default timeout 300s, last 4 KB of output kept), and approval tasks then wait with `review_requested_at` set (status stays `active`).
- A human completing in the UI skips the criteria evidence and counts as the approval, but the command must still pass unless they override with a reason (`/override` route). Agents can't override.
- Agents can only change gate fields while a task is pending (except turning approval on); humans can edit them any time via PATCH.
- Every check result is a `verifications` row (the evidence); the web shows them in `GatesPanel`.

**Using gates in this repo:** when you plan work here, give tasks a `verify_command` where one exists (e.g. `npm test --prefix mcp -- src/tests/tools/gates.test.ts`, `npm run typecheck --prefix web`) and acceptance criteria for behaviour you'll need to show. Run `verify_task` before completing.

**Persistent goals** (spec: `specs/persistent-goals.md`; phases 1, 2 and 2.5 built): a goal is a plan with `kind = 'goal'` plus a `goals` row; its work items are ordinary root-level tasks with `run_id`, `external_ref` (unique per goal) and `archived_at`.
- Storage in `core/src/goals.ts`, behaviour in `core/src/goal-engine.ts` (`addItem`, `buildBrief`, run lifecycle, `archiveResolved`, `decideTick`).
- Autonomy per action category: `off` refused by `addItem`, `propose` → item with `requires_approval` and `review_requested_at` set at creation, `auto` → recorded as completed. Unlisted categories default to `propose`.
- Approving a proposal (`state.action`) does **not** complete it — it stays active with `approved_at` set, and the next run carries it out (`next_task` returns `execute`). The web approve route queues a run. Rejecting on a goal adds a `feedback` memory.
- Runs: the scheduler pass is `schedulerPass` in `core/src/goal-tick.ts`. It takes a lease so one session schedules, expires stale runs, runs due health checks, and claims due runs atomically (`goal_runs.holder`). The conductor-goals plugin calls it through the MCP tool `goals_tick` every 30 s (`plugins/conductor-goals/hooks/runner.ts`) and starts each claimed run in a background subagent (`conductor-goals:goal-runner`, description `Goal: <name> (<run id>)`). The agent calls `get_goal_brief(goal_id, run_id)`, works, and calls `end_run`. A run that ends without `end_run` is marked failed; one past `max_run_minutes` is stopped and timed out.
- The guard plugin exists because the engine hides from a plugin the calls its own timers and buttons cause, so the runner can't see its own timer-started runs. It identifies runs by `$.agent.list()` `spawnedBy` plus the description. It sets `run_scope`, applies the goal guard (`guard_check`), refuses the person-only tools (`decide_item`, `cancel_run`, ...) to agents and the model, and keeps run reports out of the chat. The runner starts nothing unless the guard's `status` tool is present.
- Old path: with `CONDUCTOR_WEB_RUNS=1` the web app runs its own scheduler (`web/lib/goal-scheduler.ts`), starting runs through the channel (`run_goal` request, then `agent_done`). Its state lives on `globalThis` because Next.js API routes load separate module instances from `server.ts`.
- Goals are hidden from plan lists (`/api/plans`, home page, MCP `list_plans`).
- One-off goals (`goals.one_off`): `endRun` retires one whose run leaves nothing open (`finishIfDone`), so "done" is `status 'retired'` with `one_off`. The overview still lists the newest 10 done one-offs; `run_goal` (Run again) revives one (`reviveIfDone`); rejecting a one-off's proposal queues a run to revise it. `/goal-new` and the pane's Set schedule suggest a schedule (Haiku via `$.model.complete`, keyword rules as fallback, `plugins/conductor-goals/hooks/schedule.ts`); `$.ui.ask` takes at most 4 options.
- Schedules (`core/src/schedule.ts`): one per goal, `interval` (+ active hours) or `cron` (5-field, local time, own parser — no dependency); webhooks store only a sha256 of the secret (`/api/goals/:id/trigger`, Bearer or `x-conductor-secret`; repeats coalesce into the open run).
- Health (`core/src/health.ts`): `health_command` exits 0 while the goal is met; the last number printed is the trend value. The scheduler runs due checks each tick; a failure queues a run with trigger `health` if `health_triggers_run`.
- Guard (`core/src/guard.ts`, hook `mcp/src/goal-guard.ts`): `tool_map` maps tool-name patterns to categories. The PreToolUse hook binds the Claude Code `session_id` to the run when it sees `get_goal_brief` with a `run_id`, then denies `off` categories and `propose` categories without an unused approved proposal (one allowed call per approved item, counted in `goal_tool_calls`). Outside goal runs it allows everything; it fails open on errors. Opt-in: `npm run setup-hooks --prefix mcp -- --guard`.
- "Switch to auto" suggestions: a `propose` category whose last 10 decisions were all approvals (`getAutonomySuggestions` in `web/lib/db.ts`).

**Change history**: every mutating MCP tool calls `record()` (`mcp/src/history.ts`) to write an `events` row with `actor: 'agent'`, `via: 'mcp'` and, for edits/status changes, old and new values. The web app writes `actor: 'human'` rows via `recordEvent()`. Both show in the activity feed and in the `get_history` tool. A new mutating MCP tool must call `record()` too.

**`next_task`** walks the open plan in tree order and returns `continue` (active leaf), `start` (pending leaf with dependencies met), `complete` (all children resolved) or `none` with blockers.

**Setup check**: `npm run doctor` from the repo root (rebuilds core/mcp, then runs `mcp/src/doctor.ts`). Add a check there when you add a new piece of setup.

**`working_dir` is required on every plan** and is never null. MCP's `create_plan` defaults it to `process.cwd()` (the directory Claude Code was launched from). Web UI requires the user to select one. Agents receive it in their system prompt so they know where to operate on the filesystem.

**One schema, in `core/`**: `mcp/src/db.ts` and `web/lib/db.ts` are thin wrappers that bind `@conductor/core` queries to their own connection. To add a field to plans or tasks, change `core/src/migrate.ts` (CREATE TABLE + ALTER entry) and `core/src/types.ts` only. Put a query in `core/src/queries.ts` if both sides need it; web-only queries stay in `web/lib/db.ts`.

**Claude Code plugins** (`plugins/conductor-goals` and `plugins/conductor-goals-guard`, READMEs there): the goal runner, a Goals pane, status line, alerts, `/goal*` commands and tools Claude can call, all over the conductor MCP server's tools via `$.tool.call` (mainly `goals_overview`, which answers `changed: false` to a matching etag). No web app needed. The repo root is a plugin marketplace (`.claude-plugin/marketplace.json`, name `conductor`); installed as `conductor-goals@conductor`, it is read straight from the folder, so `/reload-plugins` picks up edits. Check each with `claude plugin validate plugins/<name>` and `claude plugin test plugins/<name>`. Engine rules that bite: functions that take `$` must be top-level and imported by name (no `import * as`), state atoms must be read in the file that declares them (hence `hooks/state.ts` accessors), and every gating hook gets a `.catch`.

**Claude Code hooks**: `mcp/scripts/install-hooks.mjs` runs on `npm install` and installs the Conductor reminder hooks into `~/.claude/settings.json`, updating stale copies in place and removing the obsolete decompose hook. Skip with `CONDUCTOR_SKIP_HOOKS=1`.

**Channel is one-request-at-a-time**: The channel server rejects new requests with 503 while one is active. The web app surfaces this as `ChannelBusyError`. Agent pause is a soft signal (DB-only); Claude Code keeps running until it calls `agent_done` or `agent_cancelled`.

## Working in This Repo

**Use Conductor to plan and track your own work** — not the Claude Code `TaskCreate`/`TaskUpdate` tools. Before starting any multi-step task, call `mcp__conductor__list_plans` to check for existing in-progress work, then either resume it with `mcp__conductor__open_plan` or create a new plan with `mcp__conductor__create_plan`. Decompose the work into tasks, record progress with `mcp__conductor__update_task`, and archive the plan when done.

## Adding a New MCP Tool

1. Add a Zod schema to `mcp/src/schema.ts`
2. Create `mcp/src/tools/<tool_name>.ts` with an exported async handler function
3. Import both in `mcp/src/index.ts` and add an entry to the `TOOLS` array

## Adding a New Channel Reply Tool

When Claude needs a new way to return structured data from a channel request:

1. Add the tool to `ListToolsRequestSchema` handler in `channel/src/server.ts`
2. Add a case to `CallToolRequestSchema` handler that resolves the `pendingOneShot` promise or writes to the SSE stream
3. Add a corresponding function to `web/lib/channel-client.ts`
4. Update the prompt builder in `channel/src/server.ts` (`buildChannelContent`) to instruct Claude to call the new tool
