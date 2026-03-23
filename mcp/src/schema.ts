import { z } from 'zod'

export const CreateProjectSchema = z.object({
  name: z.string().min(1).describe('Human-readable project name'),
  description: z.string().optional().describe('Optional summary of the project\'s purpose'),
  working_dir: z.string().optional().describe('Working directory for the project. Defaults to the server\'s current working directory.'),
})

export const ListProjectsSchema = z.object({
  status: z.enum(['active', 'archived', 'all']).default('active').describe('Filter by status'),
})

export const OpenProjectSchema = z.object({
  project_id: z.string().describe('ID of the project to open'),
})

export const ArchiveProjectSchema = z.object({
  project_id: z.string().describe('ID of the project to archive'),
})

export const CreateTaskSchema = z.object({
  goal: z.string().min(1).describe('What this task should accomplish'),
  plan: z.array(z.string()).min(1).describe('Ordered steps to achieve the goal'),
  initial_state: z.record(z.unknown()).optional().describe('Freeform starting state (default {})'),
  depends_on: z.array(z.string()).optional().describe('Sibling task IDs that must complete first'),
  status: z.enum(['active', 'pending']).default('active').describe('Initial status'),
})

export const UpdateTaskSchema = z.object({
  result: z.string().describe('Human-readable summary of progress or outcome'),
  state_patch: z.record(z.unknown()).optional().describe('Shallow-merge patch applied to state'),
  advance_step: z.boolean().default(false).describe('Increment step to the next plan item'),
})

export const NavigateSchema = z.object({
  target_id: z.string().describe('Task ID to navigate to'),
})

export const SetStatusSchema = z.object({
  target_id: z.string().optional().describe('Task to update (defaults to current focus)'),
  status: z.enum(['active', 'pending', 'completed', 'abandoned']).describe('New status'),
  reason: z.string().optional().describe('Required when status is abandoned'),
})

export const SynthesizeSchema = z.object({
  target_id: z.string().optional().describe('Task to synthesize (defaults to current focus)'),
})

export const GetContextSchema = z.object({})
