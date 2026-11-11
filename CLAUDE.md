# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What This Is

Quarterdeck runs **persistent goals** for AI agents — standing objectives like "keep my inbox under control" that never finish. A goal's state (instructions, open work items, memory, human decisions, run history) lives in SQLite outside any agent; the quarterdeck-goals Claude Code plugin starts each due run in a background subagent, each run reads a one-call brief (`get_goal_brief`) and ends with a summary (`end_run`), and a human approves proposed actions from the Goals pane (or the goal page in the web app). The main use case is goals; **plans** (finite task trees with verification gates) are the underlying building block and still work on their own for long multi-session projects.

Parts: an **MCP server** (`mcp/`, the tools agents and the plugins call; bundled into the quarterdeck-goals plugin, which starts it), two **Claude Code plugins** (`plugins/quarterdeck-goals` runs goals and shows the Goals pane; `plugins/quarterdeck-guard` keeps each run within its goal), and a **Next.js web app** (`web/`, optional: goal pages and webhooks). Shared schema and logic live in `core/`. Design spec: `specs/persistent-goals.md` (phases 1, 2 and 2.5 built).

## Repository Structure

```
Quarterdeck/
  package.json        — monorepo root (npm workspaces: ["core", "mcp", "web"])
  core/               — @quarterdeck/core: the one schema, migrations and shared plan/task queries
    src/migrate.ts    — runMigrations(): every table, column and trigger lives here; SCHEMA_VERSION
    src/sqlite.ts     — Database: node:sqlite with the better-sqlite3 calls we use (transaction, pragma)
    src/queries.ts    — db-first query functions used by both mcp/ and web/
    src/types.ts      — PlanRow, Task, NewPlan, NewTask, TreeStats
    src/index.ts      — openDatabase() / defaultDbPath()
  mcp/                — MCP server (standalone tool, communicates over stdio)
    src/
      index.ts        — MCP entry point; registers all tools and dispatches calls
      schema.ts       — Zod schemas for every tool's input parameters
      db.ts           — Binds @quarterdeck/core queries to one connection
      session.ts      — In-memory open-plan ID
      context.ts      — Builds context view objects
      tools/          — One file per MCP tool handler
      tool-filter.ts  — Which tools are listed (plan tools hidden unless QUARTERDECK_TOOLS=all)
    scripts/bundle.mjs — esbuild: mcp + core → plugins/quarterdeck-goals/server/*.mjs (part of `npm run build`)
    package.json
    tsconfig.json
    vitest.config.ts
  web/                — Next.js web app, optional: goal pages and webhooks (shares the same tasks.db)
    app/              — Next.js App Router pages and API routes
    components/       — React components (GoalView, NewGoalButton)
    lib/              — DB layer, goal views, request guard, WebSocket broadcaster
    __tests__/        — Vitest test suites
    server.ts         — Custom HTTP + WebSocket server
    package.json
    tsconfig.json
    vitest.config.ts
  plugins/quarterdeck-goals/ — Claude Code plugin: goal runner (runs in subagents), Goals pane, alerts, /goal* commands, tools for Claude, and the MCP server (.mcp.json → server/, gitignored on main)
  plugins/quarterdeck-guard/ — Claude Code plugin: what a goal run may do (run tagging, autonomy guard, reports out of the chat)
  .claude-plugin/marketplace.json — makes the repo a plugin marketplace ("quarterdeck")
  scripts/release.mjs — `npm run release -- <version> [--push]`: tests, bumps both plugin.json, commits the build to the `release` branch
  specs/
```

Both `mcp/` and `web/` connect to the same `~/.quarterdeck/tasks.db` (SQLite WAL mode for concurrent access) through Node's built-in `node:sqlite` (Node 22.13+; no native build step, which is what lets the server ship inside the plugin). Import `Database` from `@quarterdeck/core`, never a SQLite package. Override the path with `QUARTERDECK_DB` env var.

**Distribution and updates**: people install `claude plugin marketplace add shannonbay/Quarterdeck#release` + `claude plugin install quarterdeck-goals@quarterdeck` (quarterdeck-guard comes as a dependency). The goals plugin's `.mcp.json` starts `${CLAUDE_PLUGIN_ROOT}/server/quarterdeck-mcp.mjs`, so the server updates with the plugin (Claude Code's plugin auto-update, off by default for our marketplace; `/reload-plugins` applies it). The `release` branch holds only what installs, built by `scripts/release.mjs`; main never commits `plugins/*/server/`. Claude Code sees a new version only when plugin.json's `version` changes, which the release script does for both plugins.

**Renamed from Conductor** (Nov 2026). Old names still work on purpose: `CONDUCTOR_*` env vars (read through `envVar()` in `core/src/index.ts`), `~/.conductor/tasks.db` while `~/.quarterdeck` has none (`defaultDbPath`), the `x-conductor-secret` webhook header, and stored goal tool maps get `mcp__conductor__` rewritten by a migration. The doctor's `checkRenameLeftovers` and `install-hooks.mjs` match old names to clean up. Don't "fix" these. The plugin is `quarterdeck-goals`, not `quarterdeck`, because plugin tools are named `mcp__<plugin>__*` and would clash with the MCP server's `mcp__quarterdeck__*`.

**Two names for the server's tools**: the plugin-provided server's tools are `mcp__plugin_quarterdeck-goals_quarterdeck__<tool>` (Claude Code's naming for a plugin's server); an older hand-added server's are `mcp__quarterdeck__<tool>`. Everything accepts both: `canonicalToolName` in `core/src/guard.ts` (tool maps), `hooks/names.ts` + `call()` in `hooks/api.ts` (tries both, caches the one that answers), and `SERVER_PREFIXES`/`serverTool` in the guard plugin. Never hard-code one prefix.

## Commands

**`core/` must be built before `mcp/` or `web/` run or typecheck.** Their `prebuild`, `predev` and `pretypecheck` scripts do it automatically (`npm run build --prefix ../core`). Tests don't need it: both `vitest.config.ts` files alias `@quarterdeck/core` to `core/src`. After changing `core/` or `mcp/`, run `npm run build --prefix mcp` (tsc, then the bundle into the plugin), then **restart the server**: `/mcp` → the plugin's `quarterdeck` server → Reconnect, or restart Claude Code. `/reload-plugins` alone is not enough here: with the plugin read from the folder and its version unchanged, it re-reads the hooks but leaves the running server process (seen Nov 2026: `edit_todo` existed while the server's `todo_set` still had the old schema). To check, compare the server process's start time with `plugins/quarterdeck-goals/server/quarterdeck-mcp.mjs`'s.

### Core (`cd core`)

```bash
npm run build       # Compile to dist/ (what mcp/ and web/ import at runtime)
npm test            # Schema, migration and revision-trigger tests
```

### MCP Server (`cd mcp`)

```bash
npm run build       # Compile TypeScript to dist/, then bundle into plugins/quarterdeck-goals/server/
npm run bundle      # Only the bundle
npm run dev         # Run directly with tsx (no compile step)
npm run typecheck   # Type-check without emitting
npm run start       # Run compiled output from dist/
npm test            # Run all tests (vitest)
npm run test:watch  # Watch mode
```

Tests live in `mcp/src/tests/`. `vitest.config.ts` sets `QUARTERDECK_DB=:memory:`. Each test gets a clean slate via `beforeEach` in `src/tests/setup.ts`. Call tool handlers directly as async functions — no MCP transport needed.

To run a single test file: `npm test -- src/tests/tools/create_plan.test.ts`

### Web App (`cd web`)

```bash
npm run dev         # Start custom HTTP + WebSocket server with Next.js (tsx server.ts, port 3000)
npm run build       # Production build
npm run typecheck   # Type-check without emitting
npm test            # Run all tests (vitest)
```

Tests live in `web/__tests__/`. `vitest.config.ts` sets `QUARTERDECK_DB=:memory:`. Each test gets a clean slate via `beforeEach` in `__tests__/setup.ts` which calls `clearAllData()` and `resetDb()`.

To run a single test file: `npm test -- __tests__/api/goals.test.ts`

### Root

```bash
npm install         # Install all workspace dependencies
npm run build       # Build core, mcp (+ plugin server bundle) and web
npm run release -- 0.12.0 [--push]   # Release (see Distribution and updates)
```

## MCP Server Architecture

**Data flow for every tool call:**
1. `src/index.ts` routes by tool name → calls the handler in `tools/`
2. Handler parses args with the Zod schema from `schema.ts`
3. Reads/writes SQLite via `db.ts` helpers
4. Checks/updates the in-memory open plan via `session.ts`
5. Returns a context view built by `context.ts`

## Web App Architecture

**Database layer** (`web/lib/db.ts`): Shared plan/task queries come from `@quarterdeck/core` via a lazy `getDb()`. Adds web-only queries: approval stats and the event log.

**Migrations** (`core/src/migrate.ts`, re-exported by `web/lib/migrate.ts`): The only place the schema is defined; both processes run it on open. Adding a column uses try/catch around `ALTER TABLE` (SQLite lacks `IF NOT EXISTS` for ALTER). New columns added to a CREATE TABLE must also get an ALTER TABLE entry for existing databases, plus an UPDATE to backfill any NOT NULL semantics. **Bump `SCHEMA_VERSION`** with every schema change: it is stored as `PRAGMA user_version`, and a session running older code (sessions update separately) then sees `schemaOutdated`, claims no runs in `schedulerPass`, and its pane asks for `/reload-plugins` (`goals_overview` `outdated`).

**Real-time updates**: SQLite triggers bump `plans.revision` on every task insert/update/delete and plan update, from any process. `web/lib/mcp-poller.ts` checks each watched plan's revision once a second and broadcasts `mcp_update` through `web/lib/ws-broadcaster.ts` when it changes. Custom server (`web/server.ts`) routes WebSocket upgrades for `/api/plans/:id/ws` (the goal page's live updates; a goal is a plan).

**Request guard** (`web/lib/request-guard.ts`): `server.ts` rejects HTTP requests (403) and WebSocket upgrades whose `Host` isn't localhost/127.0.0.1/[::1] at the server's port, or whose `Origin` is present but foreign. This stops other websites from driving the local API (which can queue goal runs). Allow extra hosts with `QUARTERDECK_ALLOWED_HOSTS=host:port,...`.

**No runs here**: the web app never starts goal runs. Run now, webhooks and failing health checks only queue a run; the quarterdeck-goals plugin starts it at its next tick. Item approve/reject live at `/api/goals/:id/items/:itemId/{approve,reject}`.

## Key Design Details

**Task IDs are tree addresses**, not random IDs. A task's ID encodes its position: `"1"` is the root, `"1.2"` is the second child of root, `"1.2.3"` is the third child of `"1.2"`. `nextChildId()` in `db.ts` computes the next available child ID by counting direct children.

**`getChildren()` uses a LIKE query** on the ID prefix, then filters to the exact depth. IDs are structural and permanent — renaming/moving tasks is not supported.

**Session state is in-memory only** (`mcp/src/session.ts`). If the MCP server restarts, the client must call `open_plan` again to re-register the open plan. One MCP server serves the whole Claude Code session, subagents included, so a call with `run_scope` (added to every tool's schema; the guard plugin sets it on a goal run's calls) runs in a scope of its own, holding that run's plan and run, and never touches the process-wide open plan.

**`state` updates are shallow-merge patches.** `update_task` with `state_patch` merges at the top level.

**Every mutating MCP tool returns a context view** (result of `buildContext`). Clients never need a follow-up read after a write.

**`set_status` to `active` is blocked** if `depends_on` lists any sibling not yet `completed`.

**Forced decomposition (opt-in):** with `QUARTERDECK_REQUIRE_DECOMPOSE=1` in the MCP server's env, `set_status` to `active` is also blocked for a task with no children unless its `state.atomic` is `true`. This lives in the server (not a hook) because only the server knows which plan is open.

**Strict completion (opt-in):** with `QUARTERDECK_STRICT_COMPLETE=1`, `set_status` to `completed` throws while any child is not completed/abandoned (otherwise it's a warning in the response).

**Verification gates** (`core/src/gates.ts`): a task can carry `acceptance_criteria`, a `verify_command` and `requires_approval`. Completion runs them through `checkCompletion()` (MCP `set_status`):
- Agents must pass `evidence` (one entry per criterion), the command must exit 0 (run in the plan's `working_dir`, default timeout 300s, last 4 KB of output kept), and approval tasks then wait with `review_requested_at` set (status stays `active`).
- A human approving counts as the approval (`decideItem`). Agents can't override a failed check.
- Agents can only change gate fields while a task is pending (except turning approval on).
- Every check result is a `verifications` row (the evidence).

**Persistent goals** (spec: `specs/persistent-goals.md`; phases 1, 2 and 2.5 built): a goal is a plan with `kind = 'goal'` plus a `goals` row; its work items are ordinary root-level tasks with `run_id`, `external_ref` (unique per goal) and `archived_at`.
- Storage in `core/src/goals.ts`, behaviour in `core/src/goal-engine.ts` (`addItem`, `buildBrief`, run lifecycle, `archiveResolved`, `decideTick`).
- Autonomy per action category: `off` refused by `addItem`, `propose` → item with `requires_approval` and `review_requested_at` set at creation, `auto` → recorded as completed. Unlisted categories default to `propose`.
- Questions for the person: `add_item` with `ask_person: true` (`state.asks_person`) waits under Needs you like a proposal and alerts. `decide_item` `answer` (with the text in `feedback`) completes it, saves the answer as memory and queues a run; `approve` marks a request done (also queues a run). The pane shows Answer… and Done; Claude answers with the plugin's `answer_item`.
- Approving a proposal (`state.action`) does **not** complete it — it stays active with `approved_at` set, and the next run carries it out (`next_task` returns `execute`). The web approve route queues a run. Rejecting on a goal adds a `feedback` memory.
- Runs: the scheduler pass is `schedulerPass` in `core/src/goal-tick.ts`. It takes a lease so one session schedules, expires stale runs, runs due health checks, and claims due runs atomically (`goal_runs.holder`). The quarterdeck-goals plugin calls it through the MCP tool `goals_tick` every 30 s (`plugins/quarterdeck-goals/hooks/runner.ts`) and starts each claimed run in a background subagent (`quarterdeck-goals:goal-runner`, description `Goal: <name> (<run id>)`). The agent calls `get_goal_brief(goal_id, run_id)`, works, and calls `end_run`. A run that ends without `end_run` is marked failed; one past `max_run_minutes` is stopped and timed out.
- The guard plugin exists because the engine hides from a plugin the calls its own timers and buttons cause, so the runner can't see its own timer-started runs. It identifies runs by `$.agent.list()` `spawnedBy` plus the description. It sets `run_scope`, applies the goal guard (`guard_check`), refuses the person-only tools (`decide_item`, `cancel_run`, ...) to agents and the model, and keeps run reports out of the chat. The runner starts nothing unless the guard's `status` tool is present.
- Goals are hidden from plan lists (`/api/plans`, home page, MCP `list_plans`).
- One-off goals (`goals.one_off`): `endRun` retires one whose run leaves nothing open (`finishIfDone`), so "done" is `status 'retired'` with `one_off`. The overview still lists the newest 10 done one-offs; `run_goal` (Run again) revives one (`reviveIfDone`); rejecting a one-off's proposal queues a run to revise it. `/goal-new` and the pane's Set schedule suggest a schedule (Haiku via `$.model.complete`, keyword rules as fallback, `plugins/quarterdeck-goals/hooks/schedule.ts`); `$.ui.ask` takes at most 4 options.
- Discuss and change (`core/src/goal-changes.ts`): the pane's Discuss (on a goal whose last run failed, and per goal / per run when expanded) sends the goal or run into the conversation (`discussPrompt`, with the run's agent id for its transcript). Expanded, "Discuss this goal…" / "Discuss this run…" open a question box first (`discussing` state, like a to-do's Ask…); the question replaces the stock one, and an empty box sends the stock one. `update_goal` (MCP, person-only; the plugin tool confirms every change with `$.ui.ask` via `describeGoalChanges`) changes name, objective, instructions, autonomy, tool rules, memory and status.
- Usage limit: the guard plugin reports a run agent's final message when it looks like a stop (`report_run_end`). `reportRunEnd` skips a run that hit the usage limit and sets `goal_run_hold` until the reset it names (or 30 min); `schedulerPass` claims nothing while held, and the overview carries `hold` for the pane. Any other error fails the run with its message.
- To-do lists (`core/src/todos.ts`, MCP `todo_list` / `todo_add` / `todo_set`, plugin `hooks/todos.ts`): the person's lists, shown in the Goals pane. A list is an active non-goal plan in the project's directory (paths compared case- and slash-insensitively); a plan with one root over children shows the children. `/todo` and `add_todo` add to the plan named "To do", made on first use. `edit_todo` and the pane's Edit reword one (`todo_set` with `text`). Ask / Plan / Start send the to-do into the conversation with `$.prompt.submit` (Ask… opens a question box in the pane, `askingAbout` state; the question, or an opinion when left empty, goes with the to-do and changes nothing; Plan first runs the built-in `/plan` through `$.command.run` when `$.command.list()` has it, else the prompt asks Claude to enter plan mode); Plan and Start mark it active; to-dos never run in the background. Pressing a to-do's text expands it; ☐ ticks it. No hooks: Claude reads the list only when asked.
- Schedules (`core/src/schedule.ts`): one per goal, `interval` (+ active hours) or `cron` (5-field, local time, own parser — no dependency); webhooks store only a sha256 of the secret (`/api/goals/:id/trigger`, Bearer or `x-quarterdeck-secret`; repeats coalesce into the open run).
- Health (`core/src/health.ts`): `health_command` exits 0 while the goal is met; the last number printed is the trend value. The scheduler runs due checks each tick; a failure queues a run with trigger `health` if `health_triggers_run`.
- Guard (`core/src/guard.ts`, MCP `guard_check`, called by the guard plugin for each run's tool calls): `tool_map` maps tool-name patterns to categories. It denies `off` categories, and `propose` categories unless an approved proposal for that category is still being carried out (active, not completed): an approval covers its whole action however many calls it takes, until the run completes the item. Every decision is recorded in `goal_tool_calls`. Outside goal runs it allows everything.
- "Switch to auto" suggestions: a `propose` category whose last 10 decisions were all approvals (`getAutonomySuggestions` in `web/lib/db.ts`).

**Change history**: every mutating MCP tool calls `record()` (`mcp/src/history.ts`) to write an `events` row with `actor: 'agent'`, `via: 'mcp'` and, for edits/status changes, old and new values. The web app writes `actor: 'human'` rows via `recordEvent()`. Both show in the activity feed and in the `get_history` tool. A new mutating MCP tool must call `record()` too.

**`next_task`** walks the open plan in tree order and returns `continue` (active leaf), `start` (pending leaf with dependencies met), `complete` (all children resolved) or `none` with blockers.

**Standing session** (`mcp/src/runner-session.ts`, CLI `quarterdeck runner install|uninstall|start|stop|status|ensure|attach`; Windows and Linux): runs goals with no Claude Code window open. It is one ordinary Claude Code session (`claude --remote-control --session-id <ours>`) in `~/.quarterdeck/runner`, in a hidden console (`conhost --headless`), which competes for the scheduler lease like any window, so the runner, guard and alerts need nothing special. A Task Scheduler task runs `launch.mjs` → `runner ensure` every 5 minutes: start if missing, restart when the build (`currentBuild`: plugin version + bundle time) differs from `state.json`, never while a run is going. The session is found by the console's process id in `state.json`. The MCP server rewrites `runner/cli-path` at start-up (`recordCliPath`) because an installed plugin's folder changes with its version. `goals_overview` carries `standing: true` while that session holds the lease. The functions take `RunnerDeps`, so tests fake the computer. Three things learned the hard way (Nov 2026): **not `claude --bg`**, because the background service retires a background session minutes after it finishes a turn (`~/.claude/daemon.log`: `bg retire … settled`), which stopped goals after every alert or phone reply; **start it with PowerShell's `Start-Process`**, because started by Node's `spawn` it exits within seconds; and on Windows `install` and `start` go through the task (`startByTask`) so the session isn't a child of the window the command ran in. To restart it while developing, run the task (`schtasks /run /tn "Quarterdeck goals runner"`). **Linux** (spiked Nov 2026 on WSL2: plugins load, the lease and runs work, Remote Control connects, and it outlives turns): `claude` runs as the pane of a detached tmux session on Quarterdeck's own socket (`tmux -L quarterdeck`, session `quarterdeck-goals`, so the person's tmux server and its environment stay out of it); `state.json`'s pid is the pane's, and `pidAlive` checks it is still that pane's. A systemd user timer runs `quarterdeck-runner.service` (oneshot: `launch.mjs` → `ensure`) a minute after it starts and every 5 minutes; `install` and `start` go through `systemctl --user start` like `startByTask`. The tmux server starts in a scope of its own (`systemd-run --user --scope`, plain tmux without a user manager), so it isn't left in the service, which systemd logs as an unclean stop at every check; the service keeps **`KillMode=process`** anyway, because by default systemd ends everything a finished oneshot leaves in its cgroup, the tmux server included. Its `PATH` is the installing shell's with the installing Node first, because the plugin starts its server with plain `node` (an nvm default may be too old for `node:sqlite`). A new folder stops at Claude Code's **workspace trust question** before any plugin loads; `startByTask` reads the pane (`screenText`) and points to `runner attach`. We don't write `hasTrustDialogAccepted` into `~/.claude.json`: Claude Code rewrites that file while running. Windows has the same question and no way to see it. **WSL can't host it**: WSL powers the distro off about a minute after its last window closes (seen Nov 2026, WSL 2.6.3: `systemd-logind: The system will power off now!`), standing session and all; the timer restarts it when a window opens, which is no use. `install` and the doctor warn (`InstallDeps.wsl`, from `/proc/version`) and point to the Windows runner.

**Setup check**: `npm run doctor` from the repo root (rebuilds core/mcp, then runs `mcp/src/doctor.ts`). Add a check there when you add a new piece of setup.

**`working_dir` is required on every plan** and is never null. MCP's `create_plan` defaults it to `process.cwd()` (the directory Claude Code was launched from). A goal run works in its goal's `working_dir`.

**One schema, in `core/`**: `mcp/src/db.ts` and `web/lib/db.ts` are thin wrappers that bind `@quarterdeck/core` queries to their own connection. To add a field to plans or tasks, change `core/src/migrate.ts` (CREATE TABLE + ALTER entry) and `core/src/types.ts` only. Put a query in `core/src/queries.ts` if both sides need it; web-only queries stay in `web/lib/db.ts`.

**Claude Code plugins** (`plugins/quarterdeck-goals` and `plugins/quarterdeck-guard`, READMEs there): the goal runner, a Goals pane, status line, alerts, `/goal*` commands and tools Claude can call, all over the quarterdeck MCP server's tools via `$.tool.call` (mainly `goals_overview`, which answers `changed: false` to a matching etag). No web app needed. The repo root is a plugin marketplace (`.claude-plugin/marketplace.json`, name `quarterdeck`); installed as `quarterdeck-goals@quarterdeck`, it is read straight from the folder, so `/reload-plugins` picks up edits to the plugins' own files (hooks, commands, agents). It does not restart the bundled MCP server: after a server rebuild, reconnect it in `/mcp` or restart Claude Code (see Commands). Check each with `claude plugin validate plugins/<name>` and `claude plugin test plugins/<name>`. In the pane, a goal with nothing for the person (`isQuiet` in `hooks/model.ts`) is one line until expanded, so tests press `toggle-<id>` before a quiet goal's controls. In the pane, a plain button for an action (Pause, Delete, Ask…, Cancel) goes through `action()` in `hooks/pane.tsx`, which draws its label in the one action colour (`Button` has no colour prop; a `Text` child carries it); rows that are content you press (a goal's name, a to-do's text, ☐) stay plain `Button`s. Engine rules that bite: functions that take `$` must be top-level and imported by name (no `import * as`), state atoms must be read in the file that declares them (hence `hooks/state.ts` accessors), and every gating hook gets a `.catch`.

**Claude Code hooks**: goals need none. `mcp/scripts/install-hooks.mjs` runs on `npm install`: it removes hooks earlier versions installed in `~/.claude/settings.json` (the plan reminders, the decompose hook and the old goal-guard hook). Skip with `QUARTERDECK_SKIP_HOOKS=1`.

**Plan tools are hidden** (`mcp/src/tool-filter.ts`): `ListTools` leaves out `create_plan`, `provision_tasks`, `next_task` and the other plan tools unless `QUARTERDECK_TOOLS=all`. They still answer calls. `update_task` and `set_status` stay listed for goal items.

## Working in This Repo

**Goals are the product; plans are plumbing.** Don't track your own work here with Quarterdeck plans (`create_plan`, `provision_tasks`, ...): use plan mode and Claude Code's own task list, as anywhere else. Plans stay as the store under goal items and the person's to-do lists, so keep their code and tests working, but new features go to goals. When the person defers an idea, offer to add it to their to-do list (`add_todo`); the roadmap is the "Goals roadmap" list.

## Adding a New MCP Tool

1. Add a Zod schema to `mcp/src/schema.ts`
2. Create `mcp/src/tools/<tool_name>.ts` with an exported async handler function
3. Import both in `mcp/src/index.ts` and add an entry to the `TOOLS` array
