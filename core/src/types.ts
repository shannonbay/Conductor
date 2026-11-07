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
  created_at: string
  updated_at: string
}

type OptionalTaskFields =
  | 'notes' | 'locked_by' | 'locked_at' | 'requires_approval'
  | 'approved_by' | 'approved_at' | 'created_by' | 'assigned_to'

/** Fields needed to insert a task; UI-layer fields and notes are optional. */
export type NewTask = Omit<Task, OptionalTaskFields> & Partial<Pick<Task, OptionalTaskFields>>

export interface TreeStats {
  total_tasks: number
  active: number
  completed: number
  pending: number
  abandoned: number
}
