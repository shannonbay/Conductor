export type PlanStatus = 'active' | 'archived'
export type TaskStatus = 'active' | 'pending' | 'completed' | 'abandoned'

export interface PlanRow {
  id: string
  name: string
  description: string | null
  status: PlanStatus
  working_dir: string
  focus_task_id: string | null
  /** Bumped by triggers on every change to the plan or its tasks. */
  revision: number
  created_at: string
  updated_at: string
}

/** Fields needed to insert a plan; the rest have defaults. */
export type NewPlan = Omit<PlanRow, 'revision' | 'focus_task_id'> & { focus_task_id?: string | null }

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
  created_at: string
  updated_at: string
}

/** The gate fields a task can carry. */
export const GATE_FIELDS = ['acceptance_criteria', 'verify_command', 'verify_timeout_s', 'requires_approval'] as const

type OptionalTaskFields =
  | 'notes' | 'locked_by' | 'locked_at' | 'requires_approval'
  | 'approved_by' | 'approved_at' | 'created_by' | 'assigned_to'
  | 'acceptance_criteria' | 'verify_command' | 'verify_timeout_s' | 'review_requested_at'

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

export interface TreeStats {
  total_tasks: number
  active: number
  completed: number
  pending: number
  abandoned: number
}
