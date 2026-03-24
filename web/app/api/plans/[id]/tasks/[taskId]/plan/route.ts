import { NextRequest } from 'next/server'
import { z } from 'zod'
import { getPlan, getTask, getSiblings } from '@/lib/db'
import { generatePlan } from '@/lib/planning'
import { ok, err, notFound, serverError } from '@/lib/api-utils'

const PlanSchema = z.object({
  instruction: z.string().optional(),
})

type Params = { params: Promise<{ id: string; taskId: string }> }

export async function POST(req: NextRequest, { params }: Params) {
  try {
    const { id: planId, taskId } = await params
    const plan = getPlan(planId)
    if (!plan) return notFound('Project')
    const task = getTask(planId, taskId)
    if (!task) return notFound('Task')

    const body = await req.json().catch(() => ({}))
    const parsed = PlanSchema.safeParse(body)
    if (!parsed.success) return err(parsed.error.message)

    const taskParts = taskId.split('.')
    const parentId = taskParts.length > 1 ? taskParts.slice(0, -1).join('.') : null
    const parentTask = parentId ? getTask(planId, parentId) : null
    const siblings = getSiblings(planId, taskId)

    const proposed = await generatePlan(
      task,
      plan.name,
      parentTask?.goal ?? null,
      siblings,
      parsed.data.instruction,
    )

    return ok({ proposed, task_id: taskId })
  } catch (e) {
    return serverError(e)
  }
}
