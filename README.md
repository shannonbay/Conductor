# Conductor

A persistent, hierarchical task tree for LLM agents — built as an MCP server with an optional web UI for monitoring and control.

When Claude Code (or any MCP-capable agent) works on anything beyond a single session, it loses the plot. No memory of what it already tried, no structured way to decompose goals, no way to recover from failures without starting over. And when context fills up and gets compacted, it forgets earlier attempts and retries the same failed approaches.

Conductor gives the agent a task tree that lives **outside the context window entirely**. The agent decomposes work into sub-tasks, tracks progress in each, records results and structured state, and handles failures by abandoning dead ends with a reason. When it branches to an alternative approach, it can see exactly why the previous one failed — so it doesn't repeat the same mistake even if the original attempt has long since been compacted away.

## How it works

The agent operates on a **plan** — a named project with a working directory. A plan contains a tree of **tasks**, where each task has:

- A **goal** (what it's trying to do)
- A **status** (`pending` → `active` → `completed` | `abandoned`)
- A **result** (human-readable summary when done)
- A **state** (structured JSON for passing data between tasks)
- An **abandon_reason** (why this approach failed, visible to sibling alternatives)
- Optional **depends_on** (blocks activation until dependencies complete)

**Task IDs are tree addresses**, not random identifiers. `"1"` is the root, `"1.2"` is the second child of root, `"1.2.3"` is the third child of `"1.2"`. This makes the tree structure legible in every tool response without needing a separate tree-fetch.

At each turn, the agent sees only its **immediate context**: the current task, its parent, siblings, children, and tree-wide stats. This keeps each API call small regardless of how large the overall plan grows.

## MCP tools

| Tool | Description |
|---|---|
| `list_plans` | List active (or all) plans |
| `create_plan` | Create a new plan with a name and working directory |
| `open_plan` | Resume an existing plan; restores archived plans automatically |
| `archive_plan` | Mark a completed plan as archived |
| `create_task` | Create a child task under the current focus task |
| `get_context` | Read current task + parent, siblings, children, and tree stats |
| `update_task` | Record progress: result summary, structured state patch, notes |
| `set_status` | Transition a task to `active`, `completed`, or `abandoned` |
| `provision_tasks` | Bulk-create a list of child tasks in one call |
| `synthesize` | Summarise direct children grouped by completion status |

## Web UI

An optional Next.js app connects to the same SQLite database and provides:

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

### Web UI

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

## Database

Both the MCP server and web app write to `~/.conductor/tasks.db` (SQLite, WAL mode). Override the path with the `CONDUCTOR_DB` environment variable — set it to `:memory:` in tests for an isolated in-memory database.

## Project structure

```
Conductor/
  channel/           Claude Code channel server (MCP over stdio + HTTP :8789)
    src/server.ts    Entry point — MCP server + HTTP bridge
  mcp/               MCP server (stdio transport, no HTTP)
    src/
      index.ts       Entry point — registers tools and dispatches calls
      schema.ts      Zod schemas for all tool inputs
      db.ts          SQLite helpers (minimal, no migrations)
      session.ts     In-memory open-plan tracking
      context.ts     Builds the context view returned by every tool
      tools/         One file per tool handler
  web/               Next.js monitoring and control UI
    app/             App Router pages and API routes
    components/      React UI components
    lib/             DB layer, channel client, agent runner, WebSocket broadcaster, planning
    __tests__/       Vitest test suites
    server.ts        Custom HTTP + WebSocket server
  specs/             Original design specs
```

## Running tests

```bash
# MCP server
cd mcp && npm test

# Web app
cd web && npm test
```

Both use Vitest with `CONDUCTOR_DB=:memory:` so tests are isolated and leave no files behind.

## Configuration

| Env var | Default | Description |
|---|---|---|
| `CONDUCTOR_DB` | `~/.conductor/tasks.db` | Path to SQLite database; use `:memory:` for tests |
| `CONDUCTOR_CHANNEL_URL` | `http://127.0.0.1:8789` | URL of the channel server (web app → channel) |
| `CONDUCTOR_CHANNEL_PORT` | `8789` | Port the channel server listens on |
| `BRAVE_SEARCH_API_KEY` | — | Optional; enables `web_search` tool in agent runs |
