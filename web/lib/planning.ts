import { z } from 'zod'
import type { Task } from './db'
import { requireChannel, planTasksViaChannel, modifyTasksViaChannel } from './channel-client'

export interface ProposedTask {
  goal: string
  plan: string[]
  suggested_depends_on: string[]
}

export interface ModifyDiff {
  unchanged: string[]
  modified: Array<ProposedTask & { replaces_id: string }>
  added: ProposedTask[]
  removed: string[]
}

const ProposedTaskSchema = z.object({
  goal: z.string().min(1),
  plan: z.array(z.string()).default([]),
  suggested_depends_on: z.array(z.string()).default([]),
})

const ProposedTasksSchema = z.array(ProposedTaskSchema)

const ModifyDiffSchema = z.object({
  unchanged: z.array(z.string()).default([]),
  modified: z.array(ProposedTaskSchema.extend({ replaces_id: z.string() })).default([]),
  added: z.array(ProposedTaskSchema).default([]),
  removed: z.array(z.string()).default([]),
})

export async function generatePlan(
  task: Task,
  planName: string,
  parentGoal: string | null,
  siblings: Task[],
  instruction?: string,
): Promise<ProposedTask[]> {
  await requireChannel()
  const raw = await planTasksViaChannel({ taskId: task.id, planName, goal: task.goal, parentGoal, siblings, instruction })
  return ProposedTasksSchema.parse(raw)
}

export async function modifyPlan(
  task: Task,
  planName: string,
  existingChildren: Task[],
  instruction: string,
): Promise<ModifyDiff> {
  await requireChannel()
  const raw = await modifyTasksViaChannel({ taskId: task.id, planName, goal: task.goal, existingChildren, instruction })
  const parsed = ModifyDiffSchema.parse(raw)

  // Safety: never remove completed or active tasks
  const protectedStatuses = new Set(['completed', 'active'])
  const childById = new Map(existingChildren.map((c) => [c.id, c]))
  parsed.removed = parsed.removed.filter((id) => {
    const child = childById.get(id)
    return child && !protectedStatuses.has(child.status)
  })

  return parsed
}
