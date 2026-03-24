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

export const CreateTaskSchema = z.object({
  goal: z.string().min(1).describe('What this task should accomplish'),
  initial_state: z.record(z.unknown()).optional().describe('Freeform starting state (default {})'),
  depends_on: z.array(z.string()).optional().describe('Sibling task IDs that must complete first'),
  status: z.enum(['active', 'pending']).default('active').describe('Initial status'),
})

export const UpdateTaskSchema = z.object({
  result: z.string().optional().describe('Human-readable summary of progress or outcome'),
  state_patch: z.record(z.unknown()).optional().describe('Shallow-merge patch applied to state'),
  notes: z.string().nullable().optional().describe('Freeform text scratchpad — use for mid-task observations, corrections, or context for downstream tasks. Unlike result, notes can be set and updated at any point. Pass null to clear.'),
  goal: z.string().min(1).optional().describe('Rename the task goal. Only allowed while the task is still pending — throws if the task is active, completed, or abandoned.'),
})

export const NavigateSchema = z.object({
  target_id: z.string().describe('Task ID to navigate to'),
})

export const SetStatusSchema = z.object({
  task_id: z.string().optional().describe('Task to update (defaults to current focus)'),
  status: z.enum(['active', 'pending', 'completed', 'abandoned']).describe('New status'),
  reason: z.string().optional().describe('Required when status is abandoned'),
  result: z.string().optional().describe('Optional summary of what the task produced'),
})

export const SynthesizeSchema = z.object({
  target_id: z.string().optional().describe('Task to synthesize (defaults to current focus)'),
})

export const GetContextSchema = z.object({})

const TaskSpecSchema = z.object({
  goal: z.string().min(1).describe('What this task should accomplish'),
  status: z.enum(['active', 'pending']).default('pending').describe('Initial status'),
  depends_on: z.array(z.string()).optional().describe('Sibling task IDs that must complete first'),
  initial_state: z.record(z.unknown()).optional().describe('Freeform starting state (default {})'),
})

export const ProvisionTasksSchema = z.object({
  tasks: z.record(z.string(), TaskSpecSchema).describe(
    'Map of task ID → spec. IDs are absolute hierarchical addresses e.g. "1", "1.1", "1.2.3". ' +
    'Parent IDs must exist in the DB or be included in this batch. ' +
    'Duplicate IDs (already in DB) are rejected. ' +
    'Root-level IDs (no dot) require the plan to be empty.'
  ),
})
