import { z } from 'zod'

export const CreatePlanSchema = z.object({
  name: z.string().min(1).describe('Human-readable plan name'),
  description: z.string().optional().describe('Optional summary of the plan\'s purpose'),
  working_dir: z.string().optional().describe('Working directory for the plan. Defaults to the server\'s current working directory.'),
})

export const ListPlansSchema = z.object({
  status: z.enum(['active', 'archived', 'all']).default('active').describe('Filter by status'),
})

export const OpenPlanSchema = z.object({
  plan_id: z.string().describe('ID of the plan to open'),
})

export const ArchivePlanSchema = z.object({
  plan_id: z.string().describe('ID of the plan to archive'),
})

/** Verification gates a task can carry. All must pass before it can be completed. */
const GateFields = {
  acceptance_criteria: z.array(z.string().min(1)).max(20).optional().describe(
    'Checkable statements that must be true when the task is done, e.g. "GET /users returns 401 without a token". ' +
    'When completing, you must give evidence for each one.'),
  verify_command: z.string().min(1).nullable().optional().describe(
    'Shell command Conductor runs in the plan\'s working_dir when you complete the task, e.g. "npm test -- auth". ' +
    'It must exit 0 or completion is refused. Pass null to remove (pending tasks only).'),
  verify_timeout_s: z.number().int().min(1).max(3600).optional().describe('Timeout for verify_command in seconds (default 300)'),
  requires_approval: z.boolean().optional().describe(
    'If true, a human must approve the task in the web UI before it is completed.'),
}

export const CreateTaskSchema = z.object({
  goal: z.string().min(1).describe('What this task should accomplish'),
  parent_id: z.string().optional().describe('ID of the parent task. Omit only when creating the first root task on an empty tree.'),
  initial_state: z.record(z.unknown()).optional().describe('Freeform starting state (default {})'),
  depends_on: z.array(z.string()).optional().describe('Sibling task IDs that must complete first'),
  status: z.enum(['active', 'pending']).default('active').describe('Initial status'),
  ...GateFields,
})

export const UpdateTaskSchema = z.object({
  task_id: z.string().describe('ID of the task to update'),
  result: z.string().optional().describe('Human-readable summary of progress or outcome'),
  state_patch: z.record(z.unknown()).optional().describe('Shallow-merge patch applied to state'),
  notes: z.string().nullable().optional().describe('Freeform text scratchpad — use for mid-task observations, corrections, or context for downstream tasks. Unlike result, notes can be set and updated at any point. Pass null to clear.'),
  goal: z.string().min(1).optional().describe('Rename the task goal. Only allowed while the task is still pending — throws if the task is active, completed, or abandoned.'),
  ...GateFields,
})

export const SetStatusSchema = z.object({
  task_id: z.string().describe('ID of the task to update'),
  status: z.enum(['active', 'pending', 'completed', 'abandoned']).describe('New status'),
  reason: z.string().optional().describe('Required when status is abandoned'),
  result: z.string().optional().describe('Optional summary of what the task produced'),
  evidence: z.array(z.string()).optional().describe(
    'When completing a task with acceptance_criteria: one entry per criterion, in order, saying how it is met ' +
    '(e.g. "covered by auth.test.ts: rejects missing token").'),
})

export const VerifyTaskSchema = z.object({
  task_id: z.string().describe('ID of the task whose checks to run'),
})

export const SynthesizeSchema = z.object({
  task_id: z.string().describe('ID of the task whose children to synthesize'),
})

export const GetContextSchema = z.object({
  task_id: z.string().optional().describe('ID of the task to get context for. Defaults to the root task ("1") if omitted.'),
})

const TaskSpecSchema = z.object({
  goal: z.string().min(1).describe('What this task should accomplish'),
  status: z.enum(['active', 'pending']).default('pending').describe('Initial status'),
  depends_on: z.array(z.string()).optional().describe('Sibling task IDs that must complete first'),
  initial_state: z.record(z.unknown()).optional().describe('Freeform starting state (default {})'),
  ...GateFields,
})

export const NextTaskSchema = z.object({})

export const GetHistorySchema = z.object({
  task_id: z.string().optional().describe('Only changes to this task and its sub-tasks. Omit for the whole plan.'),
  limit: z.number().int().min(1).max(200).default(30).describe('Newest N changes (default 30, max 200)'),
})

export const ProvisionTasksSchema = z.object({
  tasks: z.record(z.string(), TaskSpecSchema).describe(
    'Map of task ID → spec. IDs are absolute hierarchical addresses e.g. "1", "1.1", "1.2.3". ' +
    'Parent IDs must exist in the DB or be included in this batch. ' +
    'Duplicate IDs (already in DB) are rejected. ' +
    'Root-level IDs (no dot) require the plan to be empty.'
  ),
})
