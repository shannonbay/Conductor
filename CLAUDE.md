# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What This Is

Conductor is a **Model Context Protocol (MCP) server** that provides persistent, hierarchical task management for LLM agents, paired with a **Next.js web UI** for visual monitoring and management. Agents decompose goals into a task tree, track progress, handle failures by branching to alternatives, and resume work across sessions — all without holding the full plan in context.

## Repository Structure

```
Conductor/
  package.json        — monorepo root (npm workspaces: ["mcp", "web"])
  mcp/                — MCP server (standalone tool, communicates over stdio)
    src/
      index.ts        — MCP entry point; registers all tools and dispatches calls
      schema.ts       — Zod schemas for every tool's input parameters
      db.ts           — SQLite layer via better-sqlite3
      session.ts      — In-memory open-plan cursor
      context.ts      — Builds context view objects
      tools/          — One file per MCP tool handler
    package.json
    tsconfig.json
    vitest.config.ts
  web/                — Next.js web app (shares the same tasks.db)
    app/              — Next.js App Router pages and API routes
    components/       — React components (TreePanel, DetailPane, ActivityFeed, etc.)
    lib/              — DB layer, planning, agent-runner, WebSocket broadcaster
    __tests__/        — Vitest test suites
    server.ts         — Custom HTTP + WebSocket server
    package.json
    tsconfig.json
    vitest.config.ts
  specs/
```

Both `mcp/` and `web/` connect to the same `~/.conductor/tasks.db` (SQLite WAL mode for concurrent access). Override with `CONDUCTOR_DB` env var.

## Commands

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

### Web App (`cd web`)

```bash
npm run dev         # Start Next.js dev server (port 3000)
npm run build       # Production build
npm run typecheck   # Type-check without emitting
npm test            # Run all tests (vitest)
node server.ts      # Start custom HTTP + WebSocket server
```

Tests live in `web/__tests__/`. `vitest.config.ts` sets `CONDUCTOR_DB=:memory:`. Each test gets a clean slate via `beforeEach` in `__tests__/setup.ts` which calls `clearAllData()` and `resetDb()`.

To run a single test file: `npm test -- __tests__/api/plans.test.ts`

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

**Database layer** (`web/lib/db.ts`): Superset of `mcp/src/db.ts`. Adds `getFullTree()`, `lockSubtree()`, `unlockSubtree()`, `deleteTaskTree()`, session CRUD, and event log. Runs migrations on startup via `web/lib/migrate.ts`.

**Migrations** (`web/lib/migrate.ts`): Creates base `plans`/`tasks` tables (idempotent), adds UI-layer columns (`locked_by`, `requires_approval`, `created_by`, `assigned_to`, `notes`), creates `agent_sessions` and `events` tables. Adding a column uses try/catch around `ALTER TABLE` (SQLite lacks `IF NOT EXISTS` for ALTER). New columns added to the base CREATE TABLE must also get an ALTER TABLE block for existing databases, plus an UPDATE to backfill any NOT NULL semantics.

**Real-time updates**: `web/lib/ws-broadcaster.ts` pushes events to connected browsers. Custom server (`web/server.ts`) routes WebSocket upgrades for `/api/plans/:id/ws`.

**Planning** (`web/lib/planning.ts`): `generatePlan()` and `modifyPlan()` use Anthropic SDK for single API calls. Never write to DB — callers use `/plan/accept` and `/modify-plan/accept` routes to commit results.

**Agent runner** (`web/lib/agent-runner.ts`): `startAgent()` creates a session, locks the subtree, and runs an async Anthropic SDK tool-use loop. Tool implementations call DB functions directly (in-process, no IPC). `cancelAgent()`, `pauseAgent()`, `resumeAgent()` manage lifecycle.

## Key Design Details

**Task IDs are tree addresses**, not random IDs. A task's ID encodes its position: `"1"` is the root, `"1.2"` is the second child of root, `"1.2.3"` is the third child of `"1.2"`. `nextChildId()` in `db.ts` computes the next available child ID by counting direct children.

**`getChildren()` uses a LIKE query** on the ID prefix, then filters to the exact depth. IDs are structural and permanent — renaming/moving tasks is not supported.

**Session state is in-memory only** (`mcp/src/session.ts`). If the MCP server restarts, the client must call `open_plan` again. The focus cursor is also stored on the plan row in SQLite, so `open_plan` restores it.

**`state` updates are shallow-merge patches.** `update_task` with `state_patch` merges at the top level.

**Every mutating MCP tool returns a context view** (result of `buildContext`). Clients never need a follow-up read after a write.

**`set_status` to `active` is blocked** if `depends_on` lists any sibling not yet `completed`.

**`working_dir` is required on every plan** and is never null. MCP's `create_plan` defaults it to `process.cwd()` (the directory Claude Code was launched from). Web UI requires the user to select one. Agents receive it in their system prompt so they know where to operate on the filesystem.

**Two DB layers exist and must stay in sync**: `mcp/src/db.ts` is a minimal standalone layer (no migrations, no UI columns). `web/lib/db.ts` is a superset — it calls `runMigrations()` on startup and adds UI-only columns. When adding a field to `PlanRow` or `TaskRow`, update both files. The MCP `PlanRow` type only needs fields the MCP tools use; the web layer can have more.

## Working in This Repo

**Use Conductor to plan and track your own work** — not the Claude Code `TaskCreate`/`TaskUpdate` tools. Before starting any multi-step task, call `mcp__conductor__list_plans` to check for existing in-progress work, then either resume it with `mcp__conductor__open_plan` or create a new plan with `mcp__conductor__create_plan`. Decompose the work into tasks, record progress with `mcp__conductor__update_task`, and archive the plan when done.

## Adding a New MCP Tool

1. Add a Zod schema to `mcp/src/schema.ts`
2. Create `mcp/src/tools/<tool_name>.ts` with an exported async handler function
3. Import both in `mcp/src/index.ts` and add an entry to the `TOOLS` array
