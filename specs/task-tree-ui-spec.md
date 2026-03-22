# Task Tree UI — Visual Agent Orchestration Platform

A web application that serves as the primary interface for managing AI agent work. Humans create projects, define goals, sketch task hierarchies, and selectively delegate work to AI agents — or do everything manually. The tree is the shared workspace; the agent is an optional accelerant.

---

## Vision

Today's agentic AI forces a false choice: chat with an AI and hope it stays on track, or micromanage every step through a conversation. Both approaches put the AI at the center and the human at the periphery. The human types a prompt, then watches — or worse, discovers ten minutes later that the agent went off the rails five steps ago.

Task Tree UI inverts this relationship. **The human is the project manager. The tree is the plan. The agent is one way to execute it.**

A user opens the app, creates a project, and sketches out their goals as a task hierarchy — the same way they'd outline a project in a document or whiteboard. They can work the tasks entirely by hand, delegate specific subtrees to an AI agent, or mix both freely. The tree persists, tracks progress, and gives the human a complete picture of what's done, what's in flight, and what's blocked — whether the work was done by a human or an agent.

This is not a chat wrapper with a tree view bolted on. The tree _is_ the primary artifact and the primary interaction surface. Chat is secondary — scoped to individual tasks when clarification is needed. The UI is a complete, first-class channel for managing complex work, with AI as an accelerant rather than a prerequisite.

---

## Target Users

**Primary: Knowledge workers** — analysts, researchers, project managers, content teams — who need AI to execute multi-step work but want visibility and control over the process.

**Secondary: Developers** — who benefit from the same orchestration layer for code-heavy tasks but will tolerate a more complex interface.

The design philosophy: if a marketing analyst can use it, a developer will find it powerful. Not the reverse.

---

## System Architecture

### Overview

A single Next.js application that embeds the Task Tree MCP server, serves the web UI, manages agent sessions, and pushes real-time updates to connected browsers.

```
┌─────────────────────────────────────────────────────────┐
│                     Next.js Application                  │
│                                                          │
│  ┌──────────────┐  ┌──────────────┐  ┌───────────────┐  │
│  │   React UI   │  │  API Routes  │  │  Agent Runner  │  │
│  │  (Frontend)  │◄─┤  (Backend)   │◄─┤   Service      │  │
│  └──────┬───────┘  └──────┬───────┘  └───────┬───────┘  │
│         │                 │                   │          │
│         │ WebSocket       │                   │          │
│         │ (live updates)  │                   │          │
│         ▼                 ▼                   ▼          │
│  ┌─────────────────────────────────────────────────┐     │
│  │          Task Tree MCP Server (embedded)         │     │
│  │              TypeScript + SQLite                  │     │
│  └─────────────────────────────────────────────────┘     │
│                          │                               │
│                          ▼                               │
│                   ┌─────────────┐                        │
│                   │   SQLite DB  │                        │
│                   └─────────────┘                        │
└─────────────────────────────────────────────────────────┘
                           │
                           │ Agent SDK / Anthropic API
                           ▼
                  ┌──────────────────┐
                  │   Claude Models   │
                  └──────────────────┘
```

### Component Responsibilities

**React UI (Frontend)**
Renders the tree panel, detail pane, and agent activity feed. Receives real-time tree mutations via WebSocket. Sends human actions (create task, approve plan, run agent, edit goal) to the API routes.

**API Routes (Backend)**
REST endpoints that wrap the embedded MCP server. Validates human input, applies authorization (which tasks can be edited while an agent is working), and forwards mutations to the MCP layer. Also exposes WebSocket upgrade endpoint for live updates.

**Agent Runner Service**
Manages agent lifecycle. When a human triggers "Run agent" on a task, this service constructs the prompt from the task's context view, spawns a Claude Agent SDK session with the Task Tree MCP tools available, and monitors the session. Every MCP tool call the agent makes flows through the same SQLite database, so the UI sees changes immediately.

**Task Tree MCP Server (Embedded)**
The core data layer. Implements the full MCP tool protocol from the original spec (create_project, create_task, update_task, navigate, set_status, synthesize, get_context, etc.). Embedded as a TypeScript module within the Next.js app rather than run as a separate process — simplifying deployment and eliminating inter-process communication overhead.

**SQLite Database**
Single-file persistence for all projects, tasks, agent sessions, and event logs. The database schema extends the original MCP spec with UI-specific tables (agent sessions, event log, task locks).

---

## Human-First Workflow

The UI is designed so that a user never needs to invoke an agent at all. The complete project and task management workflow is available through the interface — agents are a power feature layered on top, not a prerequisite.

### Project Creation

The user creates a project from the top-level dashboard — a "New Project" action that prompts for a name and optional description. The new project opens immediately with an empty tree and the cursor in a "create first task" state, inviting the user to define their top-level goal.

No agent is involved. The human owns project creation.

### Manual Task Management

Once inside a project, the human can build out the entire task hierarchy by hand:

**Creating tasks**: Click "Add Task" at the root level, or "Add Child" on any existing task. A lightweight inline form appears (goal + optional plan steps). Tasks are created with status `pending` by default. The user can also create a task and immediately set it to `active` if they're starting work.

**Editing tasks**: All task fields are directly editable in the detail pane — goal, plan steps (add, remove, reorder), status, dependencies, and human notes. The plan is an ordered checklist that the human can work through manually, checking off steps as they go.

**Moving tasks**: Drag-and-drop in the tree panel to reparent a task. The system recalculates tree-address IDs and updates dependencies automatically. A confirmation dialog appears if the move would break existing dependency relationships.

**Setting dependencies**: From the detail pane or context menu, the user can declare that a task depends on one or more siblings. Blocked tasks show a lock icon and cannot be set to `active` until their dependencies are complete.

**Completing and abandoning tasks**: Explicit actions via the detail pane. Completing a task prompts for an optional result summary. Abandoning prompts for a reason. Both are recorded in the event log.

**Bulk operations**: Select multiple tasks in the tree (Shift+click or Ctrl+click) for bulk status changes, bulk delete, or bulk "assign to agent."

### The Spectrum of Agent Involvement

The UI supports a continuous spectrum from fully manual to fully delegated:

**Fully manual** — The human creates the project, builds the tree, works every task, and records results. The app is a structured project tracker, no AI involved. This is a valid and complete use case.

**AI-assisted planning** — The human creates the project and a top-level goal, then clicks "Plan" on a task. The agent proposes a set of child tasks. The human reviews, edits, approves, or rejects. As work progresses, the human uses "Modify Plan" to restructure subtrees based on what they've learned. The human works the tasks manually. AI was used only for planning, not execution.

**Selective delegation** — The human builds part of the tree manually, then delegates specific subtrees to an agent. For example: "I'll handle tasks 1.1 and 1.3 myself, but let the agent run 1.2." The agent works within its assigned subtree while the human works elsewhere in the tree simultaneously.

**Full delegation with oversight** — The human creates a project with a single top-level goal and delegates the entire thing to the agent. The agent decomposes, executes, and reports. The human monitors via the tree and activity feed, intervening only when needed. This is closest to the traditional "autonomous agent" pattern, but with full visibility and the ability to pause, redirect, or take over at any point.

### AI Planning Tools

The UI provides two distinct AI planning actions, separate from "Run Agent" (which executes work). These are single Claude API calls for planning assistance — no Agent SDK session is spawned. The human retains full control over what enters the tree.

#### "Plan" — Decompose a Task

Available on any task that has no children (or whose children the user wants to replace). The user clicks "Plan" and the system:

1. Sends the task's goal, plan, notes, parent context, and any sibling results to Claude with a planning-specific system prompt.
2. Returns a proposed set of child tasks, each with a goal, plan steps, and suggested dependencies.
3. Displays the proposal in the UI as a **draft overlay** on the tree — proposed nodes appear with a dashed border and a distinct color, clearly marked as uncommitted.
4. The human can accept all, accept selectively, edit any proposed task inline, add their own tasks to the draft, reorder, or dismiss entirely.
5. Accepted tasks are created as normal tasks (`created_by: agent`) in `pending` status until the human activates or delegates them.

The "Plan" action can also be invoked with an optional **instruction** — a free-text prompt that gives the AI additional context or constraints. For example, clicking "Plan" on "Build marketing website" might include the instruction: "Use Next.js and keep it to 3 pages max. We need this done in 2 weeks." This instruction is sent alongside the task context but is not persisted as part of the task (it's a one-shot planning input, distinct from the persistent `notes` field).

#### "Modify Plan" — Restructure an Existing Subtree

Available on any task that already has children. This is for when the human looks at a subtree (whether built manually or by a previous Plan action) and wants to reshape it with AI assistance rather than manually moving tasks around. The user clicks "Modify Plan" and:

1. A prompt input appears, asking the user to describe how the plan should change. Examples:
   - "Split task 1.2 into separate frontend and backend tasks"
   - "Add a testing phase after each development task"
   - "This is taking too long — consolidate into fewer, broader tasks"
   - "Reorder so we tackle the riskiest items first"
   - "1.3 failed because the API doesn't support batch operations. Restructure to use individual calls instead."
2. The system sends the full subtree structure (goals, statuses, results, dependencies) plus the user's instruction to Claude.
3. Claude returns a proposed modified subtree. The proposal respects completed and in-progress work — it will not propose deleting or modifying tasks that are `completed` or `active`. It can propose adding new tasks, reordering pending tasks, splitting tasks, merging tasks, or changing dependencies.
4. The UI shows a **diff view**: existing tasks that would be removed are highlighted in red, new tasks in green, moved tasks with an arrow indicator, and unchanged tasks in their normal style.
5. The human reviews, edits the proposal, and accepts or rejects. Accepted changes are applied atomically.

"Modify Plan" is particularly powerful for recovering from failures. When an agent abandons a task with a reason, the human can select the parent, click "Modify Plan," and say "the pg_dump approach failed because of OOM on large tables — restructure to use a streaming approach." The AI sees the abandoned task's reason and proposes an alternative decomposition that avoids the same failure.

#### Planning Prompt Construction

Both planning tools use a distinct system prompt from the execution agent:

```
You are a planning assistant helping a human structure their work into a task tree.
You do NOT execute tasks. You propose task decompositions that the human will review.

Project: "{project_name}"
Task being planned: {task_id} — "{task_goal}"

{parent_and_sibling_context}

Rules:
- Propose concrete, actionable child tasks with clear goals.
- Each proposed task should include a goal and 2-5 plan steps.
- Suggest dependencies between siblings where ordering matters.
- Keep decompositions to 3-7 children — enough detail to be useful, not so many
  as to be overwhelming.
- If any sibling tasks have been abandoned, note their reasons and avoid
  proposing approaches that would hit the same problems.
{modify_plan_section}

Respond with a JSON array of proposed tasks.
```

For "Modify Plan," the `{modify_plan_section}` adds:

```
The task already has children. The human wants to modify the existing plan.
Current subtree:
{current_children_with_statuses}

Human's modification request: "{user_instruction}"

Rules for modifications:
- NEVER propose removing or modifying tasks with status "completed" or "active".
- You may propose removing, splitting, merging, or reordering "pending" tasks.
- You may propose new tasks to add.
- Clearly indicate which existing tasks are unchanged, which are modified,
  and which are new.
```

### Task Assignment Model

Every task carries a `created_by` field (`human` or `agent`), but this only records origin. A new field `assigned_to` captures intent:

| Value | Meaning |
|-------|---------|
| `null` | Unassigned — anyone can work it |
| `human` | Explicitly reserved for human execution |
| `agent` | Delegated to an agent session |

Assignment is advisory, not enforced by the server. It helps the UI communicate intent: tasks assigned to humans show a person icon; tasks assigned to agents show a bot icon; unassigned tasks show neither. When a user clicks "Run Agent" on a task, the task and its unassigned children are automatically set to `assigned_to: agent`.

---

## Data Model Extensions

The original Task Tree MCP spec defines the core data model for projects and tasks. The UI layer adds the following extensions. Fields from the original spec are not repeated here — refer to the MCP spec for the canonical definitions of projects, tasks, status lifecycle, dependencies, state, and context views.

### Task Extensions

Additional fields on the task object to support human-agent collaboration:

| Field | Type | Description |
|-------|------|-------------|
| `locked_by` | `string \| null` | Agent session ID that currently holds the write lock |
| `locked_at` | `string \| null` | ISO 8601 timestamp when lock was acquired |
| `requires_approval` | `boolean` | If true, agent pauses and waits for human approval before executing |
| `approved_by` | `string \| null` | User ID that approved this task (if approval was required) |
| `approved_at` | `string \| null` | ISO 8601 timestamp of approval |
| `created_by` | `enum` | `human` · `agent` — who created this task |
| `assigned_to` | `enum \| null` | `human` · `agent` · `null` — who is intended to work this task |
| `notes` | `string \| null` | Human-authored notes visible to the agent in context |

### Agent Sessions

| Field | Type | Description |
|-------|------|-------------|
| `id` | `string` | Unique session identifier |
| `project_id` | `string` | Project this session operates within |
| `root_task_id` | `string` | The task subtree this agent is scoped to |
| `status` | `enum` | `running` · `paused` · `completed` · `failed` · `cancelled` |
| `started_at` | `string` | ISO 8601 timestamp |
| `ended_at` | `string \| null` | ISO 8601 timestamp when session terminated |
| `model` | `string` | Claude model identifier used for this session |
| `token_usage` | `object` | `{ input_tokens, output_tokens, total_cost }` |
| `error` | `string \| null` | Error message if status is `failed` |

### Event Log

Every mutation to the tree — whether by human or agent — is recorded as an immutable event. This powers the activity feed, visual diffs, undo history, and audit trail.

| Field | Type | Description |
|-------|------|-------------|
| `id` | `string` | Unique event identifier |
| `project_id` | `string` | Project this event belongs to |
| `task_id` | `string` | Task that was affected |
| `event_type` | `enum` | `task_created` · `task_updated` · `status_changed` · `task_locked` · `task_unlocked` · `approval_requested` · `approval_granted` · `agent_started` · `agent_completed` · `agent_failed` |
| `actor` | `enum` | `human` · `agent` |
| `session_id` | `string \| null` | Agent session ID (if actor is `agent`) |
| `timestamp` | `string` | ISO 8601 timestamp |
| `payload` | `object` | Event-specific data (previous state, new state, diff) |

---

## UI Design

### Layout

A two-panel layout with a collapsible activity sidebar. The top bar includes project management controls that the human uses directly — no agent interaction needed.

```
┌─────────────────────────────────────────────────────────────┐
│  [Project Selector ▼] [+ New Project]  Task Tree  [⚙]      │
├──────────────────────┬──────────────────────────────────────┤
│                      │                                      │
│   TREE PANEL         │         DETAIL PANE                  │
│                      │                                      │
│   ▼ 1 Migrate DB     │  ┌────────────────────────────────┐  │
│     ● 1.1 Users ✓    │  │  1.2 Migrate orders table      │  │
│     ◉ 1.2 Orders 🤖  │  │  Status: ◉ active              │  │
│       ○ 1.2.1 Schema │  │  Assigned to: 🤖 Agent         │  │
│       ○ 1.2.2 Data   │  │  Depends on: 1.1 ✓             │  │
│     ○ 1.3 Reports 👤 │  │                                │  │
│       (blocked)      │  │  Plan:                         │  │
│                      │  │  ✓ 1. Analyze schema diffs     │  │
│   [+ Add Task]       │  │  ► 2. Generate migration       │  │
│                      │  │  ○ 3. Validate on staging      │  │
│                      │  │  ○ 4. Apply to production      │  │
│                      │  │                                │  │
│                      │  │  Result:                       │  │
│                      │  │  "Schema analysis found 4 new  │  │
│                      │  │   columns, 2 type changes..."  │  │
│                      │  │                                │  │
│                      │  │  State: { table: "orders", ... }│  │
│                      │  │                                │  │
│                      │  │  Human Notes:                  │  │
│                      │  │  [editable text area]          │  │
│                      │  │                                │  │
│                      │  │  ┌──────────┐ ┌─────────────┐  │  │
│                      │  │  │ Run Agent│ │   Plan  ▼   │  │  │
│                      │  │  └──────────┘ └─────────────┘  │  │
│                      │  │  ┌──────────┐ ┌─────────────┐  │  │
│                      │  │  │Edit Task▼│ │Modify Plan  │  │  │
│                      │  │  └──────────┘ └─────────────┘  │  │
│                      │  │  ┌──────────┐                  │  │
│                      │  │  │Add Child │                  │  │
│                      │  │  └──────────┘                  │  │
│                      │  └────────────────────────────────┘  │
│                      │                                      │
│                      │  ┌────────────────────────────────┐  │
│                      │  │  ACTIVITY FEED (collapsible)   │  │
│                      │  │  12:03 Agent created 1.2.1     │  │
│                      │  │  12:02 Agent started on 1.2    │  │
│                      │  │  11:58 You approved 1.2        │  │
│                      │  │  11:55 You created 1.3         │  │
│                      │  │  11:45 Agent completed 1.1     │  │
│                      │  └────────────────────────────────┘  │
├──────────────────────┴──────────────────────────────────────┤
│  Agent: ◉ Running on 1.2  │  4/9 tasks complete  │  $0.12  │
└─────────────────────────────────────────────────────────────┘
```

### Empty States

The UI must feel inviting when there's nothing in it yet — this is where every user starts.

**No projects**: The dashboard shows a welcome message, a prominent "Create your first project" button, and optionally a template gallery (Phase 3). No mention of agents or AI — just "What do you want to work on?"

**Empty project (no tasks)**: The tree panel shows a single input field: "What's the goal of this project?" Typing and pressing Enter creates the root task. Below it, a secondary prompt: "Break this into steps" with an option to add children manually or click "Plan" to get AI-suggested decomposition.

**Task with no children**: The detail pane shows the task's goal and plan. Clear CTAs for "Add child task" (manual) and "Plan" (AI-assisted decomposition). "Run Agent" is available but secondary — the UI doesn't push users toward agent delegation by default.

### Tree Panel

A vertical tree with indentation, similar to a file explorer. Each node shows:

- **Status icon**: ○ pending, ◉ active (pulsing when agent is working), ✓ completed, ✗ abandoned, 🔒 blocked
- **Task ID and goal** (truncated to fit)
- **Progress indicator** for parent tasks: a small bar or fraction showing child completion (e.g., "2/4")
- **Agent activity indicator**: a subtle animation or icon when an agent session is actively working on this task

**Interactions:**
- Click a node to select it (loads detail pane)
- Double-click a node's goal text to edit it inline
- Right-click for context menu: Add Child Task, Plan, Modify Plan, Run Agent, Set Status, Add Dependency, Assign To, Mark Requires Approval
- Click "+ Add Task" at the bottom of the tree to create a new root-level sibling
- Click "+ Add Child" that appears on hover below any expanded node to create a child
- Drag a node to reparent it (with confirmation)
- Keyboard navigation: arrow keys to move through the tree, Enter to select, Space to expand/collapse, N to create a new sibling, Shift+N to create a child

### Detail Pane

Shows the full context for the selected task. Sections:

**Header**: Task ID, goal (editable by human), status badge, dependency indicators with links to dependency tasks.

**Plan**: Ordered step list with checkmarks for completed steps, a pointer for the current step, and the ability for humans to add/remove/reorder steps.

**Result**: The human-readable outcome. Read-only when set by agent; human can append notes.

**State**: Collapsible JSON viewer with syntax highlighting. Read-only (state is for programmatic use, but humans should be able to inspect it).

**Human Notes**: A free-text area where the human can write notes that will be included in the agent's context when it works on this task. This is the primary mechanism for humans to inject knowledge or constraints into a specific task without restructuring the tree.

**Actions**:
- **Add Child**: Quick-create a child task manually via an inline form
- **Plan**: AI-assisted decomposition — proposes child tasks as a draft for human review (single API call, not an agent session). Available when the task has no children.
- **Modify Plan**: AI-assisted restructuring — the human describes how an existing subtree should change, and the AI proposes modifications as a diff. Available when the task already has children.
- **Run Agent**: Spawns an agent session scoped to this task's subtree (clearly labeled as delegating execution to AI)
- **Approve**: Appears when `requires_approval` is true and the agent is waiting
- **Edit Task**: Dropdown with options to edit goal, plan, status, dependencies, assignment
- **Abandon**: Mark the task as abandoned with a reason
- **Delete**: Remove a task and its children (only for human-created tasks that have no agent history)

### Activity Feed

A chronological log of events for the selected task (or the whole project if no task is selected). Each entry shows:

- Timestamp
- Actor (human or agent, with agent model identified)
- Action description
- For state changes: a visual diff (see below)

The feed is filterable by actor (human only, agent only, all) and by event type.

### Visual Diff System

Tree mutations are visualized in real time without requiring the user to read JSON diffs:

**New nodes** appear in the tree with a green highlight that fades over 3 seconds. The activity feed shows "Agent created 1.2.3: [goal]".

**Status changes** are shown by the status icon transitioning with a brief animation. Completed nodes get a subtle green tint. Abandoned nodes grey out and optionally collapse. The activity feed shows the transition: "pending → active" or "active → abandoned: [reason]".

**Field updates** (result, state, plan changes) are shown in the detail pane with inline highlighting. Changed text gets a yellow background that fades. New state keys get a green indicator. The activity feed shows a summary: "Agent updated result and advanced to step 3".

**Structural changes** (new children, reparenting) are animated in the tree panel — nodes slide into position rather than appearing abruptly.

### Dependency Visualization

When a task with dependencies is selected, the tree panel draws subtle connector lines between the selected task and its dependencies. Color-coded: green for completed dependencies, amber for in-progress, red for blocked/abandoned.

For a focused view, the detail pane header shows dependency status as clickable chips: "Depends on: 1.1 ✓ 1.3 ◉" — clicking navigates to that task.

### Focused Dependency Graph

When a parent task with complex inter-child dependencies is selected, a toggle in the detail pane switches to a **mini graph view** showing just that level's children as a directed acyclic graph with dependency arrows. This is the one concession to canvas-style layout, scoped to a single level where it's most useful. The graph is rendered inline in the detail pane, not as a full-screen takeover.

---

## Human-Agent Interaction Model

### The Approval Gate Pattern

The core interaction pattern is **plan-then-approve**. When an agent decomposes a task into children, it can (or the user can configure it to) mark the children as `requires_approval: true`. The agent pauses, the UI shows the proposed plan, and the human can:

1. **Approve all** — agent proceeds with all children
2. **Approve selectively** — approve some, edit or delete others
3. **Edit and approve** — modify goals, reorder, add new children, then approve
4. **Reject** — abandon the proposed decomposition, optionally with guidance in human notes

This creates a natural checkpoint cadence: the agent proposes a plan at each level of depth, the human blesses it, the agent executes, reports results, and the cycle repeats.

### Configurable Autonomy Levels

Users configure how much autonomy the agent has, per-project or per-task:

| Level | Behavior |
|-------|----------|
| **Full autonomy** | Agent works through the entire subtree without pausing. Human can observe and intervene but the agent doesn't wait. |
| **Approve decompositions** | Agent pauses whenever it creates child tasks, waits for human approval before executing them. Does not pause for updates or status changes within approved tasks. |
| **Approve each step** | Agent pauses before each plan step, showing what it intends to do and waiting for approval. Most controlled mode. |
| **Manual** | Agent proposes but does not execute. Human manually triggers each action. Useful for learning how the agent thinks about decomposition. |

The default for new projects is **Approve decompositions** — enough control for knowledge workers to feel safe, enough autonomy to be useful.

### Invoking an Agent

When the user clicks "Run Agent" on a task, the system:

1. Checks for an active agent session on the project. If one exists and is working on a different subtree, warns the user about potential conflicts (MVP: one agent per project).
2. Acquires a write lock on the target task and its subtree.
3. Constructs the agent prompt:
   - System prompt defining the agent's role and available tools
   - The task's context view (from `get_context`)
   - Any human notes on the task
   - The configured autonomy level as behavioral instructions
   - Results and state from completed sibling tasks (for context on what's already been done)
4. Spawns a Claude Agent SDK session with the Task Tree MCP tools registered.
5. Streams agent activity to the UI via WebSocket.
6. When the agent reaches an approval gate, the session pauses and the UI notifies the human.
7. On human approval (or rejection with notes), the session resumes.
8. When the agent completes or fails, the session is recorded and the lock is released.

### Human Interventions During Agent Execution

While an agent is running, the human can:

- **Watch**: See the tree update in real time via the activity feed and tree panel.
- **Pause**: Suspend the agent session. The agent finishes its current tool call, then stops. Can be resumed.
- **Cancel**: Terminate the agent session immediately. Tree state is preserved as-is (partially completed work remains).
- **Redirect**: Add a human note to the currently active task. The note is injected into the agent's context on its next tool call, allowing mid-execution course correction.
- **Edit other tasks**: Humans can freely edit tasks that are not locked by the agent (i.e., tasks outside the agent's current subtree).

### Agent Conflict Prevention

**MVP (single agent per project):** Only one agent session can be active per project at a time. Attempting to start a second returns an error. This eliminates all concurrency issues and is sufficient for the initial product.

**Future (multi-agent):** Multiple agents can work on the same project if their subtrees don't overlap. The locking system enforces this:

- When an agent session starts on task X, the server acquires write locks on X and all of X's descendants.
- Any MCP tool call that would modify a locked task from a different session is rejected with an error identifying the conflicting session.
- Locks are released when the session ends (completes, fails, or is cancelled).
- For code-specific tasks, a file-level lock registry can prevent two agents from editing the same file, even if they're in different subtrees. This is a future extension and out of scope for MVP.

---

## API Design

### REST Endpoints

The API routes wrap the embedded MCP server, adding authentication, authorization, WebSocket broadcasting, and UI-specific operations.

#### Projects

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/api/projects` | List projects (query param: `status=active\|archived\|all`) |
| `POST` | `/api/projects` | Create a new project |
| `GET` | `/api/projects/:id` | Get project details and tree stats |
| `PATCH` | `/api/projects/:id` | Update project name/description |
| `POST` | `/api/projects/:id/archive` | Archive a project |
| `POST` | `/api/projects/:id/restore` | Restore an archived project |

#### Tasks

All task endpoints are scoped to a project: `/api/projects/:projectId/tasks/...`

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/tasks` | Get full tree structure (for initial render) |
| `GET` | `/tasks/:id` | Get task detail and context view |
| `POST` | `/tasks` | Create a task (body includes `parent_id`, `goal`, `plan`, etc.) |
| `PATCH` | `/tasks/:id` | Update task fields (goal, plan, notes, result, assigned_to) |
| `DELETE` | `/tasks/:id` | Delete a task and its children (blocked if agent-locked) |
| `POST` | `/tasks/:id/status` | Change task status |
| `POST` | `/tasks/:id/approve` | Approve a task awaiting human approval |
| `POST` | `/tasks/:id/plan` | AI-assisted decomposition — returns proposed children without committing (body: optional `{ instruction }`) |
| `POST` | `/tasks/:id/plan/accept` | Accept proposed children from Plan (selectively, with edits) |
| `POST` | `/tasks/:id/modify-plan` | AI-assisted restructuring — returns proposed subtree modifications (body: `{ instruction }`) |
| `POST` | `/tasks/:id/modify-plan/accept` | Accept proposed modifications from Modify Plan (selectively, with edits) |
| `GET` | `/tasks/:id/synthesize` | Get synthesis of a task's children |
| `GET` | `/tasks/:id/events` | Get event history for a task |

#### Agent Sessions

| Method | Path | Description |
|--------|------|-------------|
| `POST` | `/api/projects/:id/agent/run` | Start an agent session (body: `{ task_id, autonomy_level }`) |
| `POST` | `/api/projects/:id/agent/pause` | Pause the active session |
| `POST` | `/api/projects/:id/agent/resume` | Resume a paused session |
| `POST` | `/api/projects/:id/agent/cancel` | Cancel the active session |
| `GET` | `/api/projects/:id/agent/status` | Get current session status and token usage |

#### Real-Time

| Protocol | Path | Description |
|----------|------|-------------|
| `WebSocket` | `/api/projects/:id/ws` | Subscribe to real-time events for a project |

WebSocket messages are JSON-encoded events matching the event log schema. The client receives every tree mutation as it happens, whether from a human action or an agent tool call.

---

## Tech Stack

| Layer | Technology | Rationale |
|-------|-----------|-----------|
| **Framework** | Next.js 14+ (App Router) | Full-stack React with API routes, server components for initial tree render, client components for interactivity |
| **Language** | TypeScript throughout | Type safety across MCP server, API routes, and frontend |
| **Database** | SQLite via better-sqlite3 | Single-file persistence, no external dependencies, fast for tree queries, sufficient for single-user / small-team use |
| **Real-time** | WebSocket (ws library or Socket.io) | Push tree mutations to browser instantly |
| **Agent SDK** | @anthropic-ai/claude-code (Agent SDK for TypeScript) | Spawns agent sessions with built-in tool execution, file access, and command running |
| **UI Components** | React + Tailwind CSS + shadcn/ui | Clean, accessible component primitives with utility-first styling |
| **Tree Rendering** | Custom React component | Built on top of a headless tree library (e.g., react-arborist) for virtualization and keyboard navigation |
| **State Management** | Zustand or React context | Lightweight client state for tree selection, UI preferences; server is source of truth |
| **JSON Viewer** | react-json-view or custom | For displaying task `state` objects with syntax highlighting |

---

## SQLite Schema

```sql
-- Projects
CREATE TABLE projects (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  description TEXT,
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'archived')),
  focus_task_id TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Tasks
CREATE TABLE tasks (
  id TEXT NOT NULL,                    -- tree address: "1", "1.2", "1.2.3"
  project_id TEXT NOT NULL REFERENCES projects(id),
  parent_id TEXT,                      -- null for root tasks
  goal TEXT NOT NULL,
  plan TEXT NOT NULL DEFAULT '[]',     -- JSON array of strings
  step INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('pending', 'active', 'completed', 'abandoned')),
  result TEXT,
  abandon_reason TEXT,
  state TEXT NOT NULL DEFAULT '{}',    -- JSON object
  depends_on TEXT,                     -- JSON array of sibling task IDs
  locked_by TEXT,                      -- agent session ID
  locked_at TEXT,
  requires_approval BOOLEAN NOT NULL DEFAULT 0,
  approved_by TEXT,
  approved_at TEXT,
  created_by TEXT NOT NULL DEFAULT 'human' CHECK (created_by IN ('human', 'agent')),
  assigned_to TEXT CHECK (assigned_to IN ('human', 'agent')),  -- null = unassigned
  notes TEXT,                          -- human-authored notes for agent context
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (project_id, id)
);

CREATE INDEX idx_tasks_parent ON tasks(project_id, parent_id);
CREATE INDEX idx_tasks_status ON tasks(project_id, status);
CREATE INDEX idx_tasks_locked ON tasks(locked_by) WHERE locked_by IS NOT NULL;

-- Agent Sessions
CREATE TABLE agent_sessions (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id),
  root_task_id TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'running' CHECK (status IN ('running', 'paused', 'completed', 'failed', 'cancelled')),
  autonomy_level TEXT NOT NULL DEFAULT 'approve_decompositions' CHECK (autonomy_level IN ('full', 'approve_decompositions', 'approve_steps', 'manual')),
  model TEXT NOT NULL,
  input_tokens INTEGER NOT NULL DEFAULT 0,
  output_tokens INTEGER NOT NULL DEFAULT 0,
  total_cost REAL NOT NULL DEFAULT 0.0,
  error TEXT,
  started_at TEXT NOT NULL DEFAULT (datetime('now')),
  ended_at TEXT
);

CREATE INDEX idx_sessions_project ON agent_sessions(project_id, status);

-- Event Log
CREATE TABLE events (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id),
  task_id TEXT NOT NULL,
  event_type TEXT NOT NULL,
  actor TEXT NOT NULL CHECK (actor IN ('human', 'agent')),
  session_id TEXT REFERENCES agent_sessions(id),
  payload TEXT NOT NULL DEFAULT '{}',  -- JSON
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX idx_events_task ON events(project_id, task_id, created_at);
CREATE INDEX idx_events_project ON events(project_id, created_at);
```

---

## Agent Prompt Construction

When the Agent Runner spawns a session, it constructs a system prompt and initial user message from the task tree state. This is the bridge between the visual UI and the agent's execution.

### System Prompt Template

```
You are an AI agent working within a task tree project management system.
You have access to MCP tools for managing your work:
create_task, update_task, navigate, set_status, synthesize, get_context.

Your current assignment is task {task_id} in project "{project_name}".
Your autonomy level is: {autonomy_level}.

Rules:
- Work only within your assigned subtree (task {task_id} and its descendants).
- Do not navigate above task {task_id}.
- Update your progress via update_task after meaningful work.
- When decomposing a task into subtasks, create them as children.
- If a subtask fails, abandon it with a clear reason and create an alternative sibling.
- Use the state field to store structured data for downstream tasks.
- Use the result field for human-readable summaries.
{approval_instructions}
{human_notes_section}
```

The `{approval_instructions}` section varies by autonomy level:

- **Full autonomy**: "Proceed without pausing. The human will intervene if needed."
- **Approve decompositions**: "After creating child tasks, pause and wait. Do not begin executing children until the human approves. You will receive a message when approval is granted."
- **Approve steps**: "Before each plan step, describe what you intend to do and pause for approval."
- **Manual**: "Propose actions but do not execute them. Describe what you would do at each step."

### Initial User Message

```
Here is your current context:

{context_view_json}

{sibling_results_summary}

Begin working on this task. Your goal: {task_goal}
Your plan:
{numbered_plan_steps}

You are currently on step {current_step}.
```

---

## Worked Examples

### Example 1: Fully Manual Project

A marketing analyst plans a product launch campaign entirely by hand.

```
Action    Actor     Result
────────  ────────  ──────────────────────────────────────────
 1  Create project   Human   → "Q3 Product Launch Campaign"
 2  Create task      Human   → 1 "Plan and execute Q3 product launch"
 3  Add child        Human   → 1.1 "Market research" (status: active)
 4  Add child        Human   → 1.2 "Content creation" (depends_on: ["1.1"])
 5  Add child        Human   → 1.3 "Channel distribution" (depends_on: ["1.2"])
 6  Work on 1.1      Human   → updates result: "TAM is $4.2B, 3 competitors..."
 7  Complete 1.1     Human   → status: completed
 8  Activate 1.2     Human   → now unblocked, starts working
 9  ...continues entirely manually...
```

No agent was involved. The app functioned as a structured project tracker.

### Example 2: Human Plans, Agent Executes

A researcher outlines a literature review, then delegates execution to an agent.

```
Action               Actor     Result
───────────────────  ────────  ──────────────────────────────────────────
 1  Create project    Human    → "ML Fairness Literature Review"
 2  Create task       Human    → 1 "Review fairness in ML hiring systems"
 3  Add child         Human    → 1.1 "Find key papers (2020-2025)"
 4  Add child         Human    → 1.2 "Summarize methodologies"
 5  Add child         Human    → 1.3 "Identify gaps in current research"
 6  Add child         Human    → 1.4 "Write synthesis" (depends_on: ["1.1","1.2","1.3"])
 7  Add notes to 1.1  Human   → "Focus on NeurIPS, ICML, FAccT venues"
 8  Run Agent on 1.1  Human   → agent session starts
 9  Agent works 1.1   Agent   → creates 1.1.1, 1.1.2, 1.1.3 (sub-searches)
10  Agent completes   Agent   → 1.1 completed, result: "Found 23 key papers..."
11  Review results    Human   → reads result, satisfied
12  Run Agent on 1.2  Human   → agent picks up where 1.1 left off
13  ...continues with selective delegation...
```

The human controlled the structure. The agent did the legwork within each subtree.

### Example 3: AI-Assisted Planning with "Plan"

A project manager knows the goal but not the steps. They use "Plan" to get AI suggestions, then curate.

```
Action                    Actor     Result
────────────────────────  ────────  ──────────────────────────────────────────
 1  Create project         Human    → "Migrate to Kubernetes"
 2  Create task            Human    → 1 "Move production services to k8s"
 3  Plan on task 1         Human    → instruction: "We have 12 microservices
                                       on EC2. Prioritize by risk."
                                    → AI proposes 5 children as draft:
                                       1.1 "Audit current infrastructure"
                                       1.2 "Set up k8s cluster"
                                       1.3 "Containerize services"
                                       1.4 "Deploy to staging"
                                       1.5 "Production cutover"
 4  Edit proposed 1.3      Human    → changes goal to "Containerize top 3 services"
 5  Delete proposed 1.5    Human    → removes it (too early to plan cutover)
 6  Add own task           Human    → 1.5 "Set up monitoring and alerting"
 7  Accept plan            Human    → 5 tasks created in tree
 8  Run Agent on 1.1       Human    → delegates audit to agent
 9  Work on 1.2 manually   Human    → starts cluster setup by hand
```

AI helped with the plan. The human shaped it. Execution is mixed.

### Example 4: Recovering from Failure with "Modify Plan"

An agent fails partway through a subtree. The human uses "Modify Plan" to restructure.

```
Action                    Actor     Result
────────────────────────  ────────  ──────────────────────────────────────────
 1  (Earlier) Plan on 1.1  Human   → accepted decomposition:
                                      1.1.1 "Export users via pg_dump" (active)
                                      1.1.2 "Transform to new schema"
                                      1.1.3 "Import to new database"
 2  Run Agent on 1.1       Human   → agent starts on 1.1.1
 3  Agent fails 1.1.1      Agent   → abandoned: "OOM — users table is 14GB,
                                      pg_dump can't handle it"
 4  Review failure          Human   → sees abandoned task and reason
 5  Modify Plan on 1.1     Human   → instruction: "pg_dump failed on large
                                      tables. Restructure to use streaming
                                      migration with pgloader. Keep the
                                      schema transform step."
                                    → AI proposes modified subtree:
                                      1.1.1 [keep, abandoned] no change
                                      1.1.2 "Stream users via pgloader" (NEW)
                                      1.1.3 "Transform to new schema" (UNCHANGED)
                                      1.1.4 "Validate row counts" (NEW)
 6  Review diff             Human   → sees: 1.1.1 stays (historical record),
                                      1.1.2 is new (replaces failed approach),
                                      1.1.3 unchanged, 1.1.4 is new
 7  Accept modifications    Human   → tree updated
 8  Run Agent on 1.1.2     Human   → agent tries the new approach
```

The human didn't need to manually restructure the tree or remember why the first approach failed — the AI proposed an alternative that accounts for the failure reason, and the human approved it.

---

## MVP Scope

### Phase 1: Human-First Tree Management + Agent Invocation

Build the foundation: a fully functional tree-based project manager that works entirely without AI, plus basic agent delegation.

**Included:**
- Project CRUD (create, list, open, archive) via the UI — no agent needed
- Full manual task management: create, edit, delete, reorder, reparent tasks
- Full tree visualization with status icons, expand/collapse, and inline editing
- Detail pane with all task fields (goal, plan, result, state, notes)
- Human can manually work through plan steps (check off, advance)
- Human can change task status via the UI
- Empty states that guide new users through project creation without mentioning AI
- Single-click "Run Agent" that spawns an Agent SDK session on a selected subtree
- "Plan" for AI-assisted task decomposition (single API call, returns draft for human review)
- "Modify Plan" for AI-assisted subtree restructuring with user instructions (single API call, returns diff for human review)
- Real-time tree updates via WebSocket while agent runs
- Pause and cancel agent sessions
- Activity feed showing human and agent actions
- Single agent per project constraint
- SQLite persistence

**Excluded from Phase 1:**
- Approval gate pattern (agent runs with full autonomy only)
- Visual diffs and animations
- Dependency graph visualization
- Drag-to-reparent
- Multi-agent support
- Authentication / multi-user
- Task assignment model (assigned_to field)

### Phase 2: Approval Gates + Assignment + Visual Polish

Add the human-in-the-loop approval system, task assignment model, and visual refinements.

**Included:**
- Configurable autonomy levels per project and per task
- Approval gate UI (agent pauses, human reviews, approves/rejects)
- Task assignment model (assigned_to: human / agent / null) with visual indicators
- Human notes injection during agent execution
- Visual diffs: green highlights for new nodes, grey-out for abandoned, status transition animations
- Drag-to-reparent with confirmation
- Activity feed filtering and search
- Keyboard navigation in tree panel
- Bulk operations (multi-select for status changes, assignment, deletion)

### Phase 3: Collaboration + Advanced Features

**Included:**
- Authentication and multi-user support
- Focused dependency graph view for complex sibling relationships
- Drag-to-reparent with conflict detection
- Multi-agent sessions within a project (with subtree locking)
- Export/import project trees (JSON)
- Cost tracking dashboard (token usage per project, per session)
- Template projects (start from a predefined tree structure)

---

## Open Questions

1. **MCP protocol compliance**: Should the embedded MCP server also expose a standard MCP transport (stdio or HTTP+SSE) so that external agents (not spawned by the UI) can connect to the same tree? This would allow the UI to work with agents invoked from Claude Code, Cursor, or other MCP-aware tools. Likely yes, but adds complexity.

2. **Agent model selection**: Should users be able to choose which Claude model runs on each task? Sonnet for routine decomposition, Opus for complex reasoning? This has cost implications that the UI should surface clearly.

3. **Tool access beyond the tree**: Agents often need to read files, run commands, or search the web — not just manage the tree. The Agent SDK provides these built-in, but the UI should give users visibility into what external actions the agent is taking, not just tree mutations. This may require extending the event log to capture non-tree tool calls.

4. **Offline / local-first**: SQLite enables a fully local deployment. Should the MVP support a desktop app (via Electron or Tauri) in addition to the web app? This would appeal to developers who want their task tree data on their machine.

5. **Undo / rollback**: The event log makes undo theoretically possible, but rolling back agent actions that had real-world side effects (file edits, API calls) is complex. For MVP, undo should be limited to human-initiated tree edits, not agent actions.

6. **Non-Claude agents**: The architecture assumes the Claude Agent SDK, but the MCP server is model-agnostic. Should the Agent Runner support pluggable agent backends (OpenAI, local models) from the start, or is Claude-only acceptable for MVP?
