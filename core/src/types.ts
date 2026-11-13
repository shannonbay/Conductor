export type PlanStatus = 'active' | 'archived'
export type TaskStatus = 'active' | 'pending' | 'completed' | 'abandoned'

export interface PlanRow {
  id: string
  name: string
  description: string | null
  status: PlanStatus
  working_dir: string
  focus_task_id: string | null
  /** 'goal' = a persistent goal: a plan that never finishes (see specs/persistent-goals.md). */
  kind: PlanKind
  /** Bumped by triggers on every change to the plan or its tasks. */
  revision: number
  created_at: string
  updated_at: string
}

export type PlanKind = 'plan' | 'goal'

/** Fields needed to insert a plan; the rest have defaults. */
export type NewPlan = Omit<PlanRow, 'revision' | 'focus_task_id' | 'kind'> & { focus_task_id?: string | null; kind?: PlanKind }

export interface Task {
  id: string
  plan_id: string
  goal: string
  status: TaskStatus
  result: string | null
  abandon_reason: string | null
  state: Record<string, unknown>
  depends_on: string[] | null
  notes: string | null
  // UI-layer fields (set by the web app; MCP leaves them at their defaults)
  locked_by: string | null
  locked_at: string | null
  requires_approval: boolean
  approved_by: string | null
  approved_at: string | null
  created_by: 'human' | 'agent'
  assigned_to: 'human' | 'agent' | null
  // Verification gates — all must pass before the task can be completed
  /** Statements the completer must give evidence for, one per item. */
  acceptance_criteria: string[] | null
  /** Shell command run in the plan's working_dir; must exit 0. */
  verify_command: string | null
  /** Per-task timeout for verify_command (default DEFAULT_VERIFY_TIMEOUT_S). */
  verify_timeout_s: number | null
  /** Set when all other gates passed and the task is waiting for human approval. */
  review_requested_at: string | null
  // Persistent-goal work items
  /** The goal run that created this item. */
  run_id: string | null
  /** Stable ID of the thing the item is about (e.g. "gmail:18c2f…"); unique per plan. */
  external_ref: string | null
  /** Set when a resolved item ages out; archived items are hidden but kept. */
  archived_at: string | null
  created_at: string
  updated_at: string
}

/** The gate fields a task can carry. */
export const GATE_FIELDS = ['acceptance_criteria', 'verify_command', 'verify_timeout_s', 'requires_approval'] as const

type OptionalTaskFields =
  | 'notes' | 'locked_by' | 'locked_at' | 'requires_approval'
  | 'approved_by' | 'approved_at' | 'created_by' | 'assigned_to'
  | 'acceptance_criteria' | 'verify_command' | 'verify_timeout_s' | 'review_requested_at'
  | 'run_id' | 'external_ref' | 'archived_at'

/** Fields needed to insert a task; UI-layer fields and notes are optional. */
export type NewTask = Omit<Task, OptionalTaskFields> & Partial<Pick<Task, OptionalTaskFields>>

/** One row of the immutable activity log. Plan-level events use the plan ID as task_id. */
export interface Event {
  id: string
  plan_id: string
  task_id: string
  event_type: string
  actor: 'human' | 'agent'
  session_id: string | null
  payload: Record<string, unknown>
  created_at: string
}

export type NewEvent = Omit<Event, 'created_at' | 'session_id'> & { created_at?: string; session_id?: string | null }

export type GateKind = 'criteria' | 'command' | 'approval' | 'override'

/** A stored gate check result — the evidence behind a completion. */
export interface Verification {
  id: string
  plan_id: string
  task_id: string
  gate: GateKind
  passed: boolean
  actor: 'human' | 'agent'
  /** The command that ran (command gate). */
  command: string | null
  exit_code: number | null
  /** Last few KB of output, or the approval feedback / override reason. */
  output: string | null
  /** Criteria evidence: one entry per acceptance criterion. */
  evidence: string[] | null
  duration_ms: number | null
  created_at: string
}

export type NewVerification = Omit<Verification, 'id' | 'created_at' | 'command' | 'exit_code' | 'output' | 'evidence' | 'duration_ms'>
  & Partial<Pick<Verification, 'command' | 'exit_code' | 'output' | 'evidence' | 'duration_ms' | 'created_at'>>

// ── Persistent goals ──────────────────────────────────────────────────────────

export type GoalStatus = 'active' | 'paused' | 'retired'
/** off: never; propose: work item needing approval; auto: act and record. */
export type AutonomyMode = 'off' | 'propose' | 'auto'

export interface GoalLimits {
  max_run_minutes: number
  max_items_per_run: number
  max_runs_per_day: number
}

export const DEFAULT_GOAL_LIMITS: GoalLimits = { max_run_minutes: 15, max_items_per_run: 50, max_runs_per_day: 48 }

export interface Goal {
  plan_id: string
  objective: string
  instructions: string
  status: GoalStatus
  /** Action category → mode. Categories not listed default to 'propose'. */
  autonomy: Record<string, AutonomyMode>
  limits: GoalLimits
  item_retention_days: number
  last_run_at: string | null
  next_run_at: string | null
  /** Tool name pattern ("mcp__gmail__send*") → action category, enforced by the goal-guard hook. */
  tool_map: Record<string, string>
  /** Goal-level check: a shell command that exits 0 when the goal is being met; the last number it prints is tracked as a trend. */
  health_command: string | null
  health_every_minutes: number
  /** Queue a run when the health check fails. */
  health_triggers_run: boolean
  last_health_at: string | null
  /** Runs once: when a run ends with nothing open, the goal is done (status 'retired'). */
  one_off: boolean
  /** The model its runs use: an alias (haiku, sonnet, opus) or a full id. null: the model of the session that starts the run. */
  model: string | null
}

export type NewGoal = Pick<Goal, 'plan_id' | 'objective'> & Partial<Omit<Goal, 'plan_id' | 'objective' | 'limits'>> & { limits?: Partial<GoalLimits> }

/** How a run was started. 'health' = a failing health check queued it; 'watch' = a watch saw something new. */
export type TriggerKind = 'manual' | 'interval' | 'cron' | 'event' | 'health' | 'watch'

/**
 * A check whose new lines start a run. A 'command' watch is a shell command
 * that prints one line per current item (an issue number, a feed guid); a
 * 'tool' watch is a tool the plugin calls, whose answer `match` turns into lines.
 */
export interface Watch {
  id: string
  plan_id: string
  name: string
  kind: 'command' | 'tool'
  command: string | null
  tool: string | null
  tool_input: Record<string, unknown>
  /** For a tool watch: a regular expression whose first group (or whole match) is one line. */
  match: string | null
  every_minutes: number
  /** Lines seen so far, newest check first. */
  seen: string[]
  /** When the first check that worked recorded what was there; null before it. */
  baseline_at: string | null
  last_checked_at: string | null
  /** For a tool watch: when its call was handed to the plugin, until the answer is reported. */
  asked_at: string | null
  last_fired_at: string | null
  last_error: string | null
  /** Checks failed in a row. */
  fail_count: number
  created_at: string
}

/** What the person sets on a watch. */
export type WatchSpec =
  | { command: string; every_minutes?: number }
  /** A tool the plugin calls (a connector's search): `match` turns its answer into lines. */
  | { tool: string; input?: Record<string, unknown>; match?: string; every_minutes?: number }

export interface WatchEvent {
  id: string
  watch_id: string
  plan_id: string
  line: string
  created_at: string
  /** Set once a run has been queued for it. */
  queued_at: string | null
  /** The run whose brief carried it. */
  run_id: string | null
}

export interface CronConfig {
  /** Five-field cron expression in local time, e.g. "0 9 * * 1-5". */
  expr: string
}

export interface EventConfig {
  /** sha256 of the webhook secret; the secret itself is shown once. */
  secret_hash: string
}

export interface IntervalConfig {
  minutes: number
  /** Local-time window like "08:00-20:00"; runs only inside it. */
  active_hours?: string
}

export interface GoalTrigger {
  id: string
  plan_id: string
  kind: TriggerKind
  config: IntervalConfig | CronConfig | EventConfig | Record<string, unknown>
  enabled: boolean
}

export type RunStatus = 'queued' | 'running' | 'completed' | 'failed' | 'timed_out' | 'skipped'

export interface GoalRun {
  id: string
  plan_id: string
  trigger: TriggerKind
  status: RunStatus
  session_id: string | null
  /** The Claude Code session doing the run (bound by the goal-guard hook). */
  cc_session_id: string | null
  /** The Claude Code session whose quarterdeck-goals plugin claimed the run. */
  holder: string | null
  /** The plugin's subagent doing the run. */
  agent_id: string | null
  summary: string | null
  skip_reason: string | null
  items_created: number
  items_resolved: number
  started_at: string
  ended_at: string | null
  /** What the run's agent used, summed over its turns. */
  input_tokens: number
  output_tokens: number
  cache_read_tokens: number
  cache_write_tokens: number
  /** The model that answered the run's last turn. */
  model: string | null
  /** The run's latest tool call outside Quarterdeck (`Bash: npm test`), and when; reported by the guard plugin. */
  now_tool: string | null
  now_tool_at: string | null
  /** The tool call waiting for a permission answer, and since when (null once answered). */
  waiting_tool: string | null
  waiting_since: string | null
  /**
   * When the run first read untrusted content (a tool that reads mail or web pages,
   * or watch events in its brief), and what it was: from then on its `auto`
   * categories need approval, in case that content asked for the action.
   */
  untrusted_at: string | null
  untrusted_source: string | null
}

export type MemoryKind = 'fact' | 'rule' | 'preference'
export type MemorySource = 'human' | 'agent' | 'feedback'

export interface GoalMemory {
  id: string
  plan_id: string
  kind: MemoryKind
  text: string
  source: MemorySource
  /** The item or run this came from. */
  source_ref: string | null
  pinned: boolean
  active: boolean
  created_at: string
  last_used_at: string | null
}

export interface HealthResult {
  id: string
  plan_id: string
  passed: boolean
  exit_code: number | null
  /** Last number printed by the command, for the trend. */
  value: number | null
  output: string | null
  duration_ms: number
  created_at: string
}

export interface ToolCallRecord {
  id: string
  plan_id: string
  run_id: string
  tool_name: string
  category: string
  decision: 'allow' | 'deny'
  reason: string | null
  created_at: string
}

export interface TreeStats {
  total_tasks: number
  active: number
  completed: number
  pending: number
  abandoned: number
}
