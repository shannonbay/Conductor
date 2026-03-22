# Task Tree MCP — Persistent Goal Management for Agentic LLMs

A Model Context Protocol server that gives an LLM agent a persistent, hierarchical task tree scoped by project. The agent decomposes complex goals into sub-tasks, tracks progress, records outputs, handles failures by branching to alternatives, and resumes work across sessions — all without holding the full plan in context.

---

## Why a Task Tree?

LLM agents today lose the plot on complex, multi-step work. They either stuff everything into one prompt (and forget earlier steps as context grows) or maintain flat task lists that can't represent hierarchy or dependencies. When something fails mid-plan, they have no structured way to backtrack and try an alternative.

The Task Tree solves this by externalizing the agent's goal structure into a server-managed tree. The agent sees only what it needs at each step: the current task, its parent goal, sibling tasks and their status, and any sub-tasks below. This keeps context small, makes progress persistent across sessions, and gives the agent a natural mechanism for decomposition, failure handling, and resumption.

---

## Core Concepts

### Projects

A project is the top-level container that scopes a task tree. Each project holds exactly one tree of tasks, has its own focus cursor, and persists independently on the server. The agent works within one project at a time — all task tools operate on the currently open project.

| Field | Type | Description |
|-------|------|-------------|
| `id` | `string` | Server-generated unique identifier |
| `name` | `string` | Human-readable project name |
| `description` | `string \| null` | Optional summary of the project's purpose |
| `status` | `enum` | `active` · `archived` |
| `created_at` | `string` | ISO 8601 timestamp |
| `updated_at` | `string` | ISO 8601 timestamp of last modification to any task |
| `tree_stats` | `object` | Aggregate task counts (same shape as in context views) |

#### Project Lifecycle

```
active ──→ archived
  ↑            │
  └────────────┘  (can be restored)
```

- **active** — The project appears in default listings and can be opened for work.
- **archived** — Hidden from default listings. The tree is preserved intact but read-only. An archived project can be restored to `active` status, at which point it becomes writable again.

Projects cannot be deleted through the protocol. Archiving is the mechanism for retiring completed or abandoned work while preserving history.

#### Single-Project Focus

The agent works within one project at a time. Opening a project sets it as the active context; all task tools (`create_task`, `navigate`, `update_task`, etc.) implicitly operate on the open project. To access another project's data, the agent must explicitly switch with `open_project`.

### Tasks

A task is one unit of work in a goal hierarchy:

| Field | Type | Description |
|-------|------|-------------|
| `id` | `string` | Tree-address (`"1"`, `"1.2"`, `"1.2.3"`) |
| `goal` | `string` | What this task aims to accomplish |
| `plan` | `string[]` | Ordered steps or sub-task descriptions |
| `step` | `integer` | Index into `plan` for the current step |
| `status` | `enum` | `active` · `pending` · `completed` · `abandoned` |
| `result` | `string \| null` | Human-readable summary of outcome or progress |
| `abandon_reason` | `string \| null` | Explanation when `status` is `abandoned` |
| `state` | `object` | Freeform scratch space — structured data the agent carries forward |
| `depends_on` | `string[] \| null` | IDs of sibling tasks that must complete before this one can activate |

### Status Lifecycle

```
pending ──→ active ──→ completed
  │            │
  │            └──→ abandoned (with reason)
  │
  └── blocked by depends_on until dependencies complete
```

- **pending** — Created but not yet started. If `depends_on` is set, the server prevents activation until all dependencies are `completed`.
- **active** — Currently being worked on. Only one task should typically be active at a time, though the server does not enforce this.
- **completed** — Finished. `result` and `state` carry the output.
- **abandoned** — Dead end. `abandon_reason` explains why so sibling alternatives can learn from the failure.

### The `state` Field

Every task carries an arbitrary `state` object for structured intermediate data — file paths, API responses, computed values, flags, partial results. Updates are applied as a **shallow-merge patch** so setting one key never clobbers another.

```
result: "Generated 3 migration scripts"               ← narrative
state:  { "scripts": ["001.sql","002.sql","003.sql"],
          "tables_migrated": 12,
          "dry_run_passed": true }                     ← data
```

Use `result` for what a human would want to read. Use `state` for what the agent (or a downstream task) needs programmatically.

### Task Tree & IDs

Tasks form a tree within a project. IDs encode lineage:

```
1                     ← root goal
├─ 1.1                ← first sub-task
│  ├─ 1.1.1           ← sub-sub-task
│  └─ 1.1.2
├─ 1.2                ← depends_on: ["1.1"]
└─ 1.3
```

A child's ID is always `<parent_id>.<n>` where `n` is a 1-based sequence among siblings. Task IDs are unique within a project but not globally — two projects can each have a task `"1.2"`.

### Dependencies

A task can declare `depends_on: ["1.1", "1.3"]` — a list of sibling task IDs that must reach `completed` status before this task can be activated. The server enforces this: attempting to set a blocked task to `active` returns an error listing the incomplete dependencies.

Dependencies are strictly between siblings (children of the same parent). Cross-branch dependencies are not supported — if two distant tasks are related, restructure the tree so they share a parent.

### Context View

The agent never sees the full tree. On every tool call, the server returns a **context view** scoped to the current focus task within the open project:

```json
{
  "project": { "id": "proj_abc123", "name": "Legacy DB Migration" },
  "focus": { /* full task object */ },
  "parent": { "id": "1", "goal": "...", "status": "active" },
  "siblings": [
    { "id": "1.2", "goal": "...", "status": "pending", "depends_on": ["1.1"] },
    { "id": "1.3", "goal": "...", "status": "completed", "result": "..." }
  ],
  "children": [
    { "id": "1.1.1", "goal": "...", "status": "completed", "result": "..." },
    { "id": "1.1.2", "goal": "...", "status": "pending" }
  ],
  "tree_stats": {
    "total_tasks": 9,
    "active": 1,
    "completed": 4,
    "pending": 3,
    "abandoned": 1
  }
}
```

Summaries include `id`, `goal`, `status`, `result` (if completed), `abandon_reason` (if abandoned), and `depends_on` (if set). `tree_stats` gives a bird's-eye progress count without serializing the full tree. The `project` field identifies which project the context belongs to.

---

## Tools

### Project Management

#### `create_project`

Create a new project. The project starts with an empty task tree and becomes the currently open project.

**Input:**

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `name` | `string` | ✓ | Human-readable project name |
| `description` | `string` | | Optional summary of the project's purpose |

**Returns:** The new project object. The project is now open and ready for task creation.

**Example:**

```json
{
  "tool": "create_project",
  "input": {
    "name": "Legacy DB Migration",
    "description": "Migrate all tables from v1 to v2 schema with zero downtime"
  }
}
```

---

#### `list_projects`

List projects on the server. By default, returns only active projects. Use the `status` filter to include archived projects.

**Input:**

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `status` | `enum` | | Filter by status: `active` (default), `archived`, or `all` |

**Returns:** An array of project summaries, each including `id`, `name`, `description`, `status`, `created_at`, `updated_at`, and `tree_stats`. Projects are ordered by `updated_at` descending (most recently active first).

**Example:**

```json
{
  "tool": "list_projects",
  "input": { "status": "active" }
}
```

**Response:**

```json
{
  "projects": [
    {
      "id": "proj_abc123",
      "name": "Legacy DB Migration",
      "description": "Migrate all tables from v1 to v2 schema with zero downtime",
      "status": "active",
      "created_at": "2025-03-01T10:00:00Z",
      "updated_at": "2025-03-20T14:32:00Z",
      "tree_stats": { "total_tasks": 9, "active": 1, "completed": 4, "pending": 3, "abandoned": 1 }
    },
    {
      "id": "proj_def456",
      "name": "Market Entry Analysis",
      "description": null,
      "status": "active",
      "created_at": "2025-03-10T08:00:00Z",
      "updated_at": "2025-03-18T11:15:00Z",
      "tree_stats": { "total_tasks": 5, "active": 0, "completed": 3, "pending": 2, "abandoned": 0 }
    }
  ]
}
```

---

#### `open_project`

Open an existing project, making it the active context for all subsequent task operations. If the project has a previous focus cursor, it is restored. If the project has no tasks yet, the context view will indicate an empty tree.

**Input:**

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `project_id` | `string` | ✓ | ID of the project to open |

**Returns:** Context view of the project's current focus task (or an empty-tree indicator if no tasks exist).

**Behavior:**
- Opening an `archived` project restores it to `active` status automatically.
- If another project was previously open, it is closed (its focus cursor is persisted).

**Example:**

```json
{
  "tool": "open_project",
  "input": { "project_id": "proj_abc123" }
}
```

---

#### `archive_project`

Archive a project, removing it from default listings. The task tree is preserved intact but becomes read-only. Use `open_project` to restore an archived project to active status.

**Input:**

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `project_id` | `string` | ✓ | ID of the project to archive |

**Returns:** The updated project object with `status: "archived"`.

**Behavior:**
- If the archived project is currently open, it is closed and the agent has no open project until they open or create one.
- Archiving is reversible — `open_project` on an archived project restores it.

**Example:**

```json
{
  "tool": "archive_project",
  "input": { "project_id": "proj_def456" }
}
```

---

### Task Operations

All task tools operate on the currently open project. Calling any task tool without an open project returns an error.

#### `create_task`

Create a new child task under the current focus (or a root task if the tree is empty). Focus moves to the new task.

**Input:**

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `goal` | `string` | ✓ | What this task should accomplish |
| `plan` | `string[]` | ✓ | Ordered steps to achieve the goal |
| `initial_state` | `object` | | Freeform starting state (default `{}`) |
| `depends_on` | `string[]` | | Sibling task IDs that must complete first |
| `status` | `enum` | | Initial status: `active` (default) or `pending` |

**Returns:** Context view focused on the new child task.

**Example:**

```json
{
  "tool": "create_task",
  "input": {
    "goal": "Migrate user table to new schema",
    "plan": [
      "Generate migration script",
      "Run dry migration on staging",
      "Validate row counts match",
      "Apply to production"
    ],
    "initial_state": { "table": "users", "target_schema": "v2" }
  }
}
```

---

#### `update_task`

Record progress on the current focus task. Does **not** change focus.

**Input:**

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `result` | `string` | ✓ | Human-readable summary of progress or outcome |
| `state_patch` | `object` | | Shallow-merge patch applied to `state` |
| `advance_step` | `boolean` | | Increment `step` to the next plan item (default `false`) |

**Returns:** Context view with the updated task.

**Example:**

```json
{
  "tool": "update_task",
  "input": {
    "result": "Migration script generated. 3 columns added, 1 renamed, 0 dropped.",
    "state_patch": {
      "script_path": "/migrations/001_users_v2.sql",
      "columns_added": ["email_verified", "mfa_enabled", "last_login_at"],
      "columns_renamed": { "name": "display_name" }
    },
    "advance_step": true
  }
}
```

---

#### `navigate`

Move focus to any task by ID within the open project. Use to return to a parent after completing a sub-task, jump to the next sibling, or drill into a child.

**Input:**

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `target_id` | `string` | ✓ | Task ID to navigate to |

**Returns:** Context view focused on the target task.

**Example:**

```json
{
  "tool": "navigate",
  "input": { "target_id": "1.2" }
}
```

---

#### `set_status`

Change a task's status. Use to mark work as completed, abandon a dead end, or activate a pending task.

**Input:**

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `target_id` | `string` | | Task to update (defaults to current focus) |
| `status` | `enum` | ✓ | `active` · `pending` · `completed` · `abandoned` |
| `reason` | `string` | | **Required** when status is `abandoned` |

**Behavior:**
- Setting `active` on a task with unmet `depends_on` returns an error.
- Setting `completed` on a task whose children are not all `completed` or `abandoned` returns a warning (but proceeds).

**Returns:** Context view (focus unchanged).

**Example:**

```json
{
  "tool": "set_status",
  "input": {
    "target_id": "1.1.1",
    "status": "abandoned",
    "reason": "pg_dump approach fails on tables >10GB — need streaming migration instead"
  }
}
```

---

#### `synthesize`

Gather the results and state from all children of a task into a single summary. Useful when returning to a parent task after completing (or abandoning) its sub-tasks, so the agent can see consolidated outcomes without navigating each child individually.

**Input:**

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `target_id` | `string` | | Task to synthesize (defaults to current focus) |

**Returns:** Context view of the target task, plus a `synthesis` object:

```json
{
  "synthesis": {
    "completed": [
      { "id": "1.1", "goal": "...", "result": "...", "state": { ... } },
      { "id": "1.2", "goal": "...", "result": "...", "state": { ... } }
    ],
    "abandoned": [
      { "id": "1.3", "goal": "...", "abandon_reason": "..." }
    ],
    "pending": [
      { "id": "1.4", "goal": "..." }
    ]
  }
}
```

---

#### `get_context`

Read-only. Returns the context view for the current focus task without modifying anything. Useful for re-orienting at the start of a new session.

**Input:** _(none)_

**Returns:** Context view, including the `project` identifier. If no project is open, returns an error directing the agent to use `list_projects` and `open_project` first.

---

## Worked Examples

### Example 1: Starting a New Project

An agent begins a new database migration effort:

```
Step  Tool              Result
────  ────────────────  ──────────────────────────────────────────
 1    create_project    → proj_abc123  "Legacy DB Migration"
 2    create_task       → 1            "Migrate legacy DB to v2 schema"
 3    create_task       → 1.1          "Migrate user table"
 4    create_task       → 1.1.1        "Try pg_dump approach"
      ...continues with task work...
```

The agent creates a project first, then builds out the task tree within it.

### Example 2: Database Migration with Backtracking

Working within an open project, the agent encounters a failure and pivots to an alternative approach:

```
Step  Tool          Result
────  ────────────  ──────────────────────────────────────────
 1    update_task   → 1.1.1   result: "pg_dump OOM on users table (14GB)"
 2    set_status    → 1.1.1   abandoned: "OOM — table too large for pg_dump"
 3    navigate      → 1.1     back to parent
 4    create_task   → 1.1.2   "Try streaming migration with pgloader"
 5    update_task   → 1.1.2   result: "pgloader migrated 2.1M rows, validated"
 6    set_status    → 1.1.2   completed
 7    navigate      → 1.1     back to parent
 8    synthesize    → 1.1     sees: 1.1.1 abandoned (OOM), 1.1.2 completed
 9    update_task   → 1.1     result: "User table migrated via pgloader"
10    set_status    → 1.1     completed
11    navigate      → 1       back to root
12    create_task   → 1.2     "Migrate orders table" (depends_on: ["1.1"])
      ...continues...
```

Key moments: the agent hits a concrete failure at step 1, abandons with a reason at step 2, creates an alternative sibling at step 4, and uses `synthesize` at step 8 to consolidate sub-task outcomes before reporting to the parent.

### Example 3: Resuming Across Sessions

An agent picks up a multi-day research project mid-stream. The session begins without knowing which project to resume:

```
Step  Tool              Result
────  ────────────────  ──────────────────────────────────────────
 1    list_projects     → 2 active projects:
                           proj_abc123 "Legacy DB Migration" (updated 2h ago)
                           proj_def456 "Market Entry Analysis" (updated 2d ago)
 2    open_project      → proj_def456, restores focus to 1.2
 3    get_context       → sees focus on 1.2 "Analyze competitor pricing"
                           parent 1 "Market entry analysis" (active)
                           sibling 1.1 completed: "TAM is $2.3B"
                           sibling 1.3 pending, depends_on: ["1.1","1.2"]
                           children: 1.2.1 completed, 1.2.2 pending
 4    navigate          → 1.2.2   "Compare enterprise tier pricing"
 5    update_task       → 1.2.2   result: "Enterprise range $800-2400/mo"
 6    set_status        → 1.2.2   completed
 7    navigate          → 1.2     back to parent
 8    synthesize        → 1.2     consolidate pricing findings
 9    set_status        → 1.2     completed
10    navigate          → 1.3     now unblocked (1.1 and 1.2 both completed)
11    set_status        → 1.3     active
      ...continues...
```

The agent starts with `list_projects` to see what's available, opens the relevant project, and the tree's persisted focus cursor puts it right back where it left off.

### Example 4: Completing and Archiving a Project

After all work is done, the agent wraps up and archives:

```
Step  Tool              Result
────  ────────────────  ──────────────────────────────────────────
 1    navigate          → 1       back to root
 2    synthesize        → 1       all children completed
 3    update_task       → 1       result: "Market analysis complete. Report in state."
 4    set_status        → 1       completed
 5    archive_project   → proj_def456 archived
 6    list_projects     → 1 active project remaining
```

---

## Design Principles

1. **Projects scope work.** Every task tree lives inside a project. This keeps unrelated efforts isolated, enables clean session resumption, and allows completed work to be archived without interfering with active projects.

2. **Tasks, not thoughts.** The tree manages units of work, not units of reasoning. The agent is free to think fluidly within each task — the tree structures *what to do*, not *how to think about it*.

3. **Narrative + data separation.** `result` is for human-readable outcomes; `state` is for structured data that downstream tasks or external tools may consume.

4. **Minimal context window.** The server sends only the focus task, neighbor summaries, and tree stats. Context stays bounded regardless of tree size, making this viable for projects with hundreds of tasks.

5. **Explicit lifecycle management.** `set_status` is a dedicated tool so that completing or abandoning a task is always a deliberate act, never a side effect of creating the next one. Similarly, `archive_project` is an explicit act, not a side effect of completing all tasks.

6. **Dependencies enforce ordering.** `depends_on` prevents the agent from starting work that requires outputs from unfinished tasks. The server enforces this so the agent doesn't have to remember.

7. **Synthesis over re-reading.** The `synthesize` tool lets the agent consolidate child outcomes without navigating each one, reducing round trips when rolling up to a parent.

8. **Persistence across sessions.** Projects and their trees live on the server. An agent starting a new session calls `list_projects`, opens the relevant one, and picks up exactly where it left off. No state is lost between conversations.

9. **Failure as a first-class concept.** Abandoned tasks with reasons are visible to siblings. When the agent creates an alternative approach, it can see *why* the previous one failed and avoid repeating the mistake.

10. **Archive, don't delete.** Projects are archived rather than destroyed. This preserves historical context — abandoned approaches, intermediate state, and decision rationale — that may be valuable for future work.

11. **Shallow-merge state updates.** `state_patch` prevents accidental overwrites and keeps update payloads small.

12. **Every mutation returns context.** The agent never needs a follow-up read after a write — reducing round trips.

13. **Single-project focus.** The agent works within one project at a time, keeping the mental model simple. Cross-project information sharing requires explicit switching, which prevents accidental state pollution between unrelated efforts.
