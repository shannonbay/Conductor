import { NextRequest } from 'next/server'
import { z } from 'zod'
import { getPlan, getTask, nextChildId, insertTask, getChildren, touchPlan } from '@/lib/db'
import { recordEvent } from '@/lib/event-log'
import { ok, err, notFound, serverError } from '@/lib/api-utils'

const AcceptedTaskSchema = z.object({
  goal: z.string().min(1),
  depends_on: z.array(z.string()).optional(),
})

const AcceptPlanSchema = z.object({
  tasks: z.array(AcceptedTaskSchema).min(1),
})

type Params = { params: Promise<{ id: string; taskId: string }> }

export async function POST(req: NextRequest, { params }: Params) {
  try {
    const { id: planId, taskId } = await params
    const plan = getPlan(planId)
    if (!plan) return notFound('Project')
    const task = getTask(planId, taskId)
    if (!task) return notFound('Task')

    const body = await req.json()
    const parsed = AcceptPlanSchema.safeParse(body)
    if (!parsed.success) return err(parsed.error.message)

    const now = new Date().toISOString()
    const created = []

    for (const t of parsed.data.tasks) {
      const childId = nextChildId(planId, taskId)
      insertTask({
        id: childId,
        plan_id: planId,
        goal: t.goal,
        status: 'pending',
        result: null,
        abandon_reason: null,
        state: {},
        depends_on: t.depends_on && t.depends_on.length > 0 ? t.depends_on : null,
        created_by: 'human',
        created_at: now,
        updated_at: now,
      })
      recordEvent({ planId, taskId: childId, eventType: 'task_created', actor: 'human', payload: { via: 'plan_accept' } })
      created.push(childId)
    }

    touchPlan(planId)
    return ok({ created, children: getChildren(planId, taskId) }, 201)
  } catch (e) {
    return serverError(e)
  }
}
