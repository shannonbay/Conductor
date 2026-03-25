import { z } from 'zod'
import type { PlanRow, Task } from './db'
import { requireChannel, generatePlanViaChannel } from './channel-client'

export interface ProposedPlanTask {
  goal: string
  suggested_depends_on: string[]
}

export interface PlanProposal {
  root: { goal: string }
  children: ProposedPlanTask[]
}

const ProposedPlanTaskSchema = z.object({
  goal: z.string().min(1),
  suggested_depends_on: z.array(z.string()).default([]),
})

const PlanProposalSchema = z.object({
  root: z.object({ goal: z.string().min(1) }),
  children: z.array(ProposedPlanTaskSchema).min(1),
})

export async function generatePlan(
  plan: PlanRow,
  existingTasks: Task[],
): Promise<PlanProposal> {
  await requireChannel()

  const existingTasksSummary = existingTasks.length > 0
    ? existingTasks.map((t) => `${t.id}: "${t.goal}" [${t.status}]`).join('\n')
    : undefined

  const raw = await generatePlanViaChannel({
    planId: plan.id as unknown as number,
    planName: plan.name,
    description: plan.description ?? '',
    workingDir: plan.working_dir,
    existingTasksSummary,
  })
  return PlanProposalSchema.parse(raw)
}
