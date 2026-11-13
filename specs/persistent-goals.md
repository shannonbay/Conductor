# Persistent Goals — Standing Objectives for Long-Lived Agent Work

**Status:** Phases 1, 2 and 2.5 built; phase 3 waits on the platform · **Date:** 2026-11-07 · **Builds on:** `task-tree-mcp.md`, verification gates (`core/src/gates.ts`)

A persistent goal is an objective that never finishes — "keep my inbox under control", "keep dependencies up to date", "triage new GitHub issues". Instead of one task tree that an agent works through and archives, a goal wakes an agent up on a schedule, gives it a short brief, lets it handle whatever is new, and records what it did for the next run. Work items come and go; the goal, its instructions and what it has learned persist.

---

## Why

Quarterdeck's plans assume work that ends: decompose, execute, verify, archive. For a capable model with a large context window, that shape adds little inside a single session — the model can hold the plan itself. Quarterdeck earns its keep when work **outlives the agent doing it**: across sessions, across agents, and under human oversight.

Persistent goals are the extreme case of that. No single agent session ever sees the whole job. Each run is short-lived and starts with an empty context, so everything that makes the goal work over weeks — what's still open, what the human approved or rejected, the rules learned along the way — has to live outside the agent. That is exactly what Quarterdeck stores.

### What changes compared with plans

| | Plan | Persistent goal |
|---|---|---|
| Ends? | Yes — archived when done | No — paused or retired by a human |
| Who starts work | Human or agent, once | A trigger, repeatedly (schedule, event, "Run now") |
| Unit of agent work | One long session | Many short **runs**, each with a fresh context |
| Tasks | One tree, all planned up front | **Work items** created per run, resolved, then archived |
| What carries over | The task tree | Instructions, **memory**, open items, run summaries |
| Human role | Watch, occasionally approve | Approve actions, give feedback that becomes rules |

---

## Goals of this design

1. A run can start cold and be useful within **one tool call** of context (the brief), without walking a tree.
2. Nothing irreversible happens without approval until the human opts in, one action category at a time.
3. Human feedback improves later runs automatically (rejections become memory).
4. Reuse what exists: plans, tasks, verification gates, history, `next_task`, the channel, the web UI.
5. The goal's state stays bounded: resolved items and old runs age out of view instead of growing forever.

### Non-goals (v1)

- Running when the user's machine is off (cloud execution) — see Phase 3.
- Several goals running at the same time — the channel handles one request at a time.
- Enforcing autonomy limits inside third-party tools (e.g. blocking a Gmail "send" call) — v1 relies on instructions plus the harness's permission settings; harness-level enforcement is Phase 2.
- Agents creating new goals. Goals are created by humans; agents may suggest them.

---

## Core Concepts

### Goal

A goal is a plan with `kind = 'goal'`. That reuses the plan's ID, name, working directory, task tree, history, and web page. Goal-specific settings live in a `goals` row keyed by the plan ID.

| Field | Type | Description |
|---|---|---|
| `plan_id` | `string` | The plan this goal extends (PK, FK → `plans.id`) |
| `objective` | `string` | One sentence: what "under control" means. *"Inbox has no unhandled mail older than a day."* |
| `instructions` | `string` | Standing instructions in plain language, written by the human. |
| `status` | `'active' \| 'paused' \| 'retired'` | Paused goals keep their state but triggers don't fire. |
| `autonomy` | `Record<string, 'off' \| 'propose' \| 'auto'>` | Per action category (see [Autonomy](#autonomy-and-action-categories)). Default for every category: `propose`. |
| `limits` | `{ max_run_minutes, max_items_per_run, max_runs_per_day }` | Hard caps. Defaults: 15, 50, 48. |
| `item_retention_days` | `number` | Resolved items are archived (hidden) after this long. Default 7. |
| `last_run_at`, `next_run_at` | `string \| null` | Maintained by the scheduler. |

### Trigger

What wakes the goal up.

| Kind | v1? | Description |
|---|---|---|
| `manual` | ✅ | "Run now" button in the web UI, or `run_goal` from an agent. |
| `interval` | ✅ | Every N minutes, optionally within active hours (`"08:00-20:00"`, local time). |
| `cron` | Phase 2 | Full cron expression. |
| `event` | Phase 2 | `POST /api/goals/:id/trigger` with a per-goal secret (e.g. from a mail webhook). |

Triggers that fire while a run is already in progress, or while the channel is busy, are **coalesced**: one pending run at most per goal, retried on the next scheduler tick, and shown as "skipped — busy" in the run timeline.

### Run

One wake-up = one run = one fresh agent session.

| Field | Type | Description |
|---|---|---|
| `id` | `string` | |
| `plan_id` | `string` | The goal |
| `trigger` | `'manual' \| 'interval' \| 'cron' \| 'event'` | |
| `status` | `'queued' \| 'running' \| 'completed' \| 'failed' \| 'timed_out' \| 'skipped'` | |
| `session_id` | `string \| null` | FK → `agent_sessions.id` (reuses transcripts and agent badges) |
| `summary` | `string \| null` | Written by the agent at the end: what it did, what's waiting, what it learned. |
| `items_created`, `items_resolved` | `number` | |
| `started_at`, `ended_at` | `string` | |

The last few run summaries are the goal's short-term memory: the next run reads them in its brief.

### Work item

A work item is an ordinary **task** in the goal's tree, with three extra columns:

| Column | Description |
|---|---|
| `run_id` | The run that created it |
| `external_ref` | Stable ID of the thing it's about, e.g. `gmail:18c2f…` or `github:issue/412`. Unique per goal, so re-seeing the same email never creates a duplicate — even after the item was archived. |
| `archived_at` | Set when a resolved item ages out. Archived items are hidden from the tree, the brief and `next_task`, but kept in history. |

Items are created as **root-level tasks** (`"1"`, `"2"`, …) so each one is its own small tree. Everything that already works on tasks still applies: sub-tasks, `depends_on`, results, notes, and verification gates.

### Memory

Durable knowledge that isn't a task: facts, preferences and rules.

| Field | Type | Description |
|---|---|---|
| `id` | `string` | |
| `plan_id` | `string` | |
| `kind` | `'fact' \| 'rule' \| 'preference'` | *fact:* "Alice Chen is my manager." *rule:* "Never archive mail from the bank." *preference:* "Drafts should be short and informal." |
| `text` | `string` | One statement. |
| `source` | `'human' \| 'agent' \| 'feedback'` | `feedback` = created from a rejected item's feedback. |
| `source_ref` | `string \| null` | The item or run it came from. |
| `pinned` | `boolean` | Always included in the brief. |
| `active` | `boolean` | Inactive memories are kept for history but ignored. |
| `created_at`, `last_used_at` | `string` | |

Rules:
- Agents can add memories and deactivate their own; they can't edit or deactivate `human` memories.
- Humans can edit, pin, deactivate or delete any memory in the UI.
- When a human **rejects** an item with feedback, Quarterdeck creates a `feedback` memory from it automatically (editable afterwards). This is how the goal learns without anyone writing rules by hand.
- Size is bounded: the brief includes every pinned memory plus the most recently used others, up to `MEMORY_BRIEF_CHARS` (default 4 000). The UI warns when active memories exceed that, so the human can prune or pin.

### Autonomy and action categories

Each goal declares the **action categories** it may take, e.g. for inbox triage:

| Category | Reversible? | Default |
|---|---|---|
| `email.label` | yes | `propose` |
| `email.archive` | yes | `propose` |
| `email.draft_reply` | yes (draft only) | `propose` |
| `email.send` | **no** | `propose` |
| `email.unsubscribe` | **no** | `off` |
| `email.delete` | **no** | `off` |

| Mode | Meaning |
|---|---|
| `off` | The agent must not take this action or propose it. |
| `propose` | The agent creates a work item with `requires_approval` describing the exact action (see below). After approval, the **next run** carries it out and resolves the item. |
| `auto` | The agent takes the action directly and records it on a work item for the audit trail. |

Everything starts at `propose`; irreversible categories start at `off`. The human promotes a category to `auto` once they trust it — the web UI shows, per category, how many proposals were approved vs rejected to support that decision.

**Proposals** are work items whose `state.action` holds the concrete action:

```json
{
  "action": {
    "category": "email.send",
    "summary": "Reply to Alice: confirm Thursday 2pm works",
    "params": { "thread": "gmail:18c2f…", "draft_id": "r-552…" }
  }
}
```

The approval UI shows `summary` and `params`; approving sets `approved_at`, and the next run executes approved actions before anything else. Rejecting with feedback returns the item to the agent *and* becomes memory.

**Enforcement, honestly:** in v1 Quarterdeck cannot stop an agent from calling, say, a Gmail send tool directly — it only controls its own tools. v1 therefore relies on (1) the brief stating each category's mode, (2) the user's Claude Code permission settings denying irreversible tools during goal runs, and (3) the audit trail making violations visible. Phase 2 adds a harness hook that blocks calls in `off`/`propose` categories unless a matching approved item exists.

### Health checks (Phase 2)

Goal-level verify commands that say whether the goal is being met, independent of any one run — e.g. a script printing the count of unread mail older than a day and exiting non-zero above a threshold. Results are stored like verification results and shown as a trend on the goal page; a failing check can trigger an extra run.

### Watches (built after Phase 2.5)

A run starts when something happens, with no listener process per source: a watch is a check the scheduler pass already knows how to run, like a health check.

- A watch (`goal_watches`) is a shell command run in the goal's directory every `every_minutes` (default 5). It prints one line per current item and exits 0.
- Lines not seen before become events (`goal_watch_events`). The first check that works is the baseline and fires nothing; a failed check leaves the seen lines alone and fires nothing, so an outage never reads as "everything is new".
- The pass queues one run (trigger `watch`) for a goal's waiting events. Events that arrive during a run queue one more after it. Each event queues at most one run, so past `max_runs_per_day` a noisy watch gives one skipped run, and its news goes to the next run of any kind.
- The run's brief carries `watch_events` (watch name, the new lines, a count of any left out). A run that fails gives its events back to the next run.
- Only the person sets a watch (`update_goal` / `create_goal` `watches`), after reading the whole command. The server checks a new watch once and answers how that went.
- Push sources still use the webhook.
- **Tool watches** cover what only a connector can reach (Gmail): there is no command to run, and the server can't call a connector. The pass hands due tool watches to the plugin, whose tick calls the tool (a read-only search, with its stored input) and reports the answer with `watch_report`; the server reads one line per match of the watch's `match` (default: every `"id"` in a JSON answer) and the rest is the same. A watch can't call Quarterdeck's own tools, a non-MCP tool, or a tool the goal's rules make a run ask for.

---

## How a Run Works

```
trigger fires
  └─ scheduler: goal active? within limits? channel free? ── no ──► run.status = skipped
        │ yes
        ▼
  create run (queued) → POST run_goal to channel (goal id, run id)
        ▼
  agent: get_goal_brief ──► objective, instructions, autonomy, memory,
        │                   open items, decisions since last run, last summaries
        ▼
  1. carry out approved proposals → resolve those items
  2. apply rejections → revise or abandon those items
  3. look for new work (e.g. read new mail) → add_item (deduped by external_ref)
  4. act within autonomy: auto → do + record; propose → item with requires_approval
  5. remember anything worth keeping
        ▼
  end_run(summary) ──► run completed; resolved items past retention archived
```

A run that exceeds `max_run_minutes` is cancelled through the channel's existing cancel control and marked `timed_out`; its partial work is kept.

### The brief

`get_goal_brief` returns everything a cold agent needs in one compact response:

```json
{
  "goal": { "id": "plan_x", "name": "Inbox", "objective": "…", "instructions": "…" },
  "run": { "id": "run_42", "trigger": "interval", "started_at": "…", "limits": { "max_run_minutes": 15, "max_items_per_run": 50 } },
  "autonomy": { "email.archive": "auto", "email.send": "propose", "email.delete": "off" },
  "memory": [ { "id": "m3", "kind": "rule", "text": "Never archive mail from the bank.", "source": "human" } ],
  "decisions_since_last_run": [
    { "item": "17", "decision": "approved", "action": { "category": "email.send", "summary": "…" } },
    { "item": "19", "decision": "rejected", "feedback": "Too formal — Alice is my manager, keep it casual." }
  ],
  "open_items": [ { "id": "21", "goal": "Reply to vendor invoice question", "status": "active", "external_ref": "gmail:…", "awaiting_review": true } ],
  "recent_runs": [ { "at": "…", "summary": "Archived 12 newsletters; drafted 2 replies awaiting review." } ],
  "counts": { "open": 6, "awaiting_review": 2, "resolved_last_24h": 31 }
}
```

Items in `open_items` are summaries only; the agent calls `get_context` on an item when it needs detail. This keeps the brief small even for busy goals, and reflects the lesson from plans: one compact call beats many bookkeeping calls.

---

## MCP Tools

New tools. Existing task tools (`create_task`, `update_task`, `set_status`, `verify_task`, `get_context`, `get_history`) work unchanged on a goal's items.

| Tool | Description |
|---|---|
| `list_goals` | Active goals with counts (open, awaiting review) and last/next run. |
| `get_goal_brief` | The brief above. Opens the goal as the current plan. Takes optional `run_id`. |
| `add_item` | Create a work item: `goal`, `external_ref`, optional gates and `action` (a proposal). If an item with that `external_ref` exists, returns it instead (`{ existing: true }`), including archived ones. Respects `max_items_per_run`. Rejects actions in `off` categories; forces `requires_approval` for `propose` categories. |
| `remember` | Add a memory (`kind`, `text`, optional `source_ref`). |
| `forget` | Deactivate a memory the agent created. |
| `end_run` | Finish the run with a `summary`. Required; a run that ends without it is marked failed with an empty summary. |
| `run_goal` | Ask Quarterdeck to start a run now (for chaining from an interactive session). |

Changes to existing tools:
- `next_task` on a goal ignores archived items and puts approved proposals first.
- `set_status completed` on a proposal checks it was approved (it is an approval-gated task, so this already holds).

---

## Data Model

All in `core/src/migrate.ts`, following the existing conventions (CREATE + ALTER entries, revision triggers).

```sql
ALTER TABLE plans ADD COLUMN kind TEXT NOT NULL DEFAULT 'plan';   -- 'plan' | 'goal'

ALTER TABLE tasks ADD COLUMN run_id TEXT;
ALTER TABLE tasks ADD COLUMN external_ref TEXT;
ALTER TABLE tasks ADD COLUMN archived_at TEXT;
CREATE UNIQUE INDEX IF NOT EXISTS idx_tasks_external_ref
  ON tasks(plan_id, external_ref) WHERE external_ref IS NOT NULL;

CREATE TABLE IF NOT EXISTS goals (
  plan_id             TEXT PRIMARY KEY REFERENCES plans(id),
  objective           TEXT NOT NULL,
  instructions        TEXT NOT NULL DEFAULT '',
  status              TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'paused', 'retired')),
  autonomy            TEXT NOT NULL DEFAULT '{}',      -- JSON: category → off | propose | auto
  limits              TEXT NOT NULL DEFAULT '{}',      -- JSON
  item_retention_days INTEGER NOT NULL DEFAULT 7,
  last_run_at         TEXT,
  next_run_at         TEXT
);

CREATE TABLE IF NOT EXISTS goal_triggers (
  id           TEXT PRIMARY KEY,
  plan_id      TEXT NOT NULL REFERENCES plans(id),
  kind         TEXT NOT NULL CHECK (kind IN ('manual', 'interval', 'cron', 'event')),
  config       TEXT NOT NULL DEFAULT '{}',             -- { minutes, active_hours } | { cron } | { secret_hash }
  enabled      INTEGER NOT NULL DEFAULT 1
);

CREATE TABLE IF NOT EXISTS goal_runs (
  id             TEXT PRIMARY KEY,
  plan_id        TEXT NOT NULL REFERENCES plans(id),
  trigger        TEXT NOT NULL,
  status         TEXT NOT NULL CHECK (status IN ('queued', 'running', 'completed', 'failed', 'timed_out', 'skipped')),
  session_id     TEXT REFERENCES agent_sessions(id),
  summary        TEXT,
  skip_reason    TEXT,
  items_created  INTEGER NOT NULL DEFAULT 0,
  items_resolved INTEGER NOT NULL DEFAULT 0,
  started_at     TEXT NOT NULL,
  ended_at       TEXT
);
CREATE INDEX IF NOT EXISTS idx_goal_runs_plan ON goal_runs(plan_id, started_at);

CREATE TABLE IF NOT EXISTS goal_memory (
  id           TEXT PRIMARY KEY,
  plan_id      TEXT NOT NULL REFERENCES plans(id),
  kind         TEXT NOT NULL CHECK (kind IN ('fact', 'rule', 'preference')),
  text         TEXT NOT NULL,
  source       TEXT NOT NULL CHECK (source IN ('human', 'agent', 'feedback')),
  source_ref   TEXT,
  pinned       INTEGER NOT NULL DEFAULT 0,
  active       INTEGER NOT NULL DEFAULT 1,
  created_at   TEXT NOT NULL,
  last_used_at TEXT
);
```

Revision triggers are added for `goal_runs` and `goal_memory` so the web page updates live. Archiving an item is an `UPDATE` on `tasks` and is already covered.

**Privacy:** items store a title, an `external_ref` and the agent's notes — not message bodies. The database is local (`~/.quarterdeck/tasks.db`), but instructions to agents say to keep personal content out of item goals and memory beyond what's needed.

---

## Scheduler

*Since phase 2.5 the scheduler runs in the Claude Code plugin (see Phases). This section describes v1, which was removed with the channel server (roadmap 1.6); it's kept for the record.*

v1 runs inside the **web server process** (`web/server.ts`), which is already long-lived, owns the channel client, and starts the revision poller.

- Every 30 seconds: find active goals with `next_run_at <= now` (or a queued manual run).
- Check limits (`max_runs_per_day`, active hours) and channel status (`GET /status`).
- Free → create the run, post `run_goal` to the channel, set `next_run_at`.
- Busy or a run already in progress → record a `skipped` run with the reason, retry next tick (at most one skipped row per goal per hour, to keep the timeline readable).

Consequences the user should know: goals only run while the web app **and** a channel-connected Claude Code session are running, and goal runs share that session with interactive work. The UI shows this clearly ("Paused — Claude Code not connected"). Phase 3 moves execution to scheduled cloud agents.

---

## Web UI

- **Sidebar:** goals listed above plans, each with a "needs you" count.
- **Goal page:**
  - Header: objective, status (active / paused), next run, **Run now**, **Pause**.
  - **Needs you** (top, prominent): proposals awaiting approval, each showing the action summary and params, with Approve / Reject (+ feedback). Bulk approve for a category.
  - **Open items:** the task tree, archived items hidden behind a toggle.
  - **Runs:** timeline with summaries, items created/resolved, duration, skipped reasons; click through to the transcript.
  - **Memory:** list grouped by kind and source; edit, pin, deactivate; warning when over the brief budget.
  - **Settings:** instructions, autonomy table with per-category approval stats, triggers, limits, retention.

---

## Worked Example: Inbox Triage

**Setup (human, in the UI):** objective *"No unhandled mail older than a day"*; instructions *"Archive newsletters and receipts. Flag anything from Alice or the bank. Draft replies to questions addressed to me."*; trigger every 30 min, 08:00–20:00; autonomy: `email.archive: auto`, `email.label: auto`, `email.draft_reply: propose`, `email.send: propose`, everything else `off`. Claude Code permission settings deny Gmail send/delete tools in goal runs.

**Run 1 (08:00):** brief has no memory and no items. Agent reads unread mail; archives 14 newsletters (auto, each recorded on an item, resolved); labels a bank statement; creates item 15 *"Reply to Alice: Thursday meeting"* with a draft and a `email.send` proposal. `end_run`: *"Archived 14, labelled 1, drafted 1 reply for review."*

**Human (09:10):** rejects item 15: *"Too formal — Alice is my manager, keep it casual."* Quarterdeck stores a `feedback` memory.

**Run 2 (09:30):** brief shows the rejection and the new memory. Agent rewrites the draft casually and re-proposes; sees 3 new emails, one of them the same thread as item 15 → `add_item` with the same `external_ref` returns the existing item instead of creating a duplicate.

**Human (10:00):** approves item 15.

**Run 3 (10:00):** brief lists the approval; agent sends the reply first, resolves item 15, then triages new mail. After a week the resolved items are archived; the memory and run summaries remain.

After a few weeks, the approval stats show 40/40 `email.draft_reply` proposals approved; the human switches that category to `auto` while keeping `email.send` at `propose`.

---

## Phases

**Phase 1 — Inbox triage, propose-first** (enough to live with day to day)
- Schema: `plans.kind`, goals, triggers (manual + interval), runs, memory; task `run_id` / `external_ref` / `archived_at`.
- Scheduler in the web server; channel `run_goal` request and prompt.
- MCP: `list_goals`, `get_goal_brief`, `add_item`, `remember`, `forget`, `end_run`, `run_goal`.
- Rejection feedback → memory; retention archiving.
- Goal page: Needs you, items, runs, memory, settings.
- Doctor: checks scheduler and channel are available for active goals.

**Phase 2 — Trust and signals**
- Harness enforcement: a PreToolUse hook (installed by `install-hooks.mjs`) that maps tool names to action categories and blocks `off`/`propose` calls without a matching approved item.
- Health checks with trends; failing checks trigger runs.
- Cron and event triggers (event endpoint behind the request guard plus a per-goal secret).
- Per-category approval stats driving "promote to auto" suggestions.

*As built (later replaced by the guard plugin, phase 2.5):* the guard hook was **opt-in** (`npm run setup-hooks --prefix mcp -- --guard`) because a global PreToolUse hook runs on every tool call (~0.3 s each on Windows). It ties a Claude Code session to its run when the agent calls `get_goal_brief` with a `run_id`, and allows one guarded call per approved proposal. The "promote to auto" threshold is 10 approvals in a row.

**Phase 2.5 — Runs from the Claude Code plugin** (built)
- **Why:** v1 needed three processes (web app, channel server, a Claude Code session started with `--dangerously-load-development-channels`), and runs shared the person's conversation: a run arrived mid-conversation, used up its time limit there, and its report landed in the chat.
- **Scheduler pass in core** (`core/src/goal-tick.ts`): `schedulerPass` takes a lease (`scheduler_lease`, 90 s) so only one Claude Code session starts runs. It expires runs nobody finished, runs due health checks, then claims due runs atomically (`queued` → `running` with `goal_runs.holder`), at most `maxConcurrent` at once. It returns each claimed run with the prompt its agent starts from. `decideItem` (approve/reject) and the overview (`goal-overview.ts`) moved to core too.
- **MCP tools for the runner:** `goals_tick`, `goals_overview`, `decide_item`, `cancel_run`, `set_goal_status`, `attach_agent`, `fail_run`, `guard_check`, `create_goal`, `delete_memory`. Every tool accepts `run_scope`: with it, the call acts on that run's goal in a scope of its own (`AsyncLocalStorage`), so a run never switches the process-wide open plan the person's conversation uses.
- **quarterdeck-goals plugin:** ticks every 30 s and after any pane action. It starts each claimed run in a background subagent (`quarterdeck-goals:goal-runner`, described `Goal: <name> (<run id>)`), stops runs past `max_run_minutes`, and marks a run whose agent ended without `end_run` as failed. It starts nothing unless the guard plugin is loaded.
- **quarterdeck-guard plugin:** what a run may do. It exists separately because the engine hides from a plugin the calls its own timers and buttons cause (the recursion skip), so the runner's hooks never see a timer-started run. It identifies runs by `spawnedBy` (engine-set) plus the description. It handles run tagging, the goal's guard (via `guard_check`), keeping person-only tools from agents and the model, and keeping the run's report out of the chat.
- **Untrusted content (roadmap 1.24):** a run that reads outside text (built-in readers: WebFetch, WebSearch, the browsers, Gmail's readers; or a tool the goal maps to the reserved category `untrusted`; or watch events in its brief) is marked (`goal_runs.untrusted_at`/`untrusted_source`), and its `auto` categories then act as `propose` for the rest of the run, in the guard and in `add_item`. The pane and web page show the mark on the run. **Untrusted memory (roadmap 1.36):** memory a marked run writes carries its mark (`goal_memory.untrusted_source`), and a brief that hands such memory out marks its run, so injected text can't wait one run; the person's memory, feedback and answers stay trusted, and the person can Trust a marked memory (pane, `trust_memory`, web PATCH `trusted`).
- **Web app:** optional. A dashboard plus webhook and health endpoints that only queue runs.
- **Later (roadmap 1.6):** the channel server, the web app's own scheduler (`QUARTERDECK_WEB_RUNS`), its plan UI and the PreToolUse goal-guard hook were removed; the plan tools are hidden from Claude unless `QUARTERDECK_TOOLS=all`.
- **Answers open question 4:** runs no longer share the conversation; each has its own subagent and context.

**Phase 3 — Off-machine**
- **Built meanwhile (2026-11-11): the standing session.** `quarterdeck runner install` keeps one Claude Code session with Remote Control running in a hidden console (Windows only so far), so goals run with no window open while the computer is on (`mcp/src/runner-session.ts`). Off-machine runs are still open.
- **Status: waiting on the platform.** Self-hosting (a VPS, a tunnel, Docker plus auth) would push infrastructure onto users, so phase 3 waits for Anthropic-hosted pieces:
  - Cloud agents on a schedule or trigger (routines exist today).
  - Access to the user's services: **scoped connectors** (OAuth, e.g. Gmail with read and draft but no send) preferred, or a **cloud browser** for services without one. A logged-in cloud browser is riskier: it holds full sessions for many services, it's a high-value target, and an always-on agent reading email is exposed to prompt injection. Scoped tokens keep the blast radius small and can be revoked per service.
  - **Hosted MCP servers with persistent storage**, so Quarterdeck's MCP server and its SQLite file run next to the agent.
  - Hooks in cloud sessions, so the goal-guard can enforce autonomy there. This matters more off-machine: approval gates enforced outside the model are what a prompt-injected agent can't talk its way past.
  - A way to reach the user for approvals (the goal page, or a push notification).
- **What changes in Quarterdeck when those exist:** a runner backend beside the channel (`web/lib/goal-runner.ts` already isolates "start a run / stream events / cancel"). The MCP server gains an HTTP transport. The web UI talks to the hosted database instead of a local file. Concurrency comes free, because runs no longer share one interactive session.
- **Possible bridge, not planned:** a local headless runner (`claude -p --mcp-config … --settings …`) for concurrent runs on the user's machine.

---

## Open Questions

1. **When do approved actions execute?** Next scheduled run (simple, may wait up to an interval) vs. an immediate run on approval (faster, more channel contention). Proposal: immediate run if the channel is free, else next run.
2. **Memory quality.** Feedback-derived memories may be too specific ("this email was too formal"). Should the next run be asked to generalise a new feedback memory into a rule, with the human confirming?
3. **Goal-level gates.** Should a run itself have a verify command (e.g. "inbox count did not increase") that marks the run failed?
4. ~~**Sharing the session.**~~ Answered by phase 2.5: each run has a subagent of its own.
5. **Cost visibility.** Channel-based runs don't report token usage today. Without it, `limits` can only cap time and item counts.
