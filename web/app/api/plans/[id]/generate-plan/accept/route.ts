import { NextRequest } from 'next/server'
import { z } from 'zod'
import { getPlan, nextChildId, insertTask, touchPlan } from '@/lib/db'
import { recordEvent } from '@/lib/event-log'
import { ok, err, notFound, serverError } from '@/lib/api-utils'

const AcceptSchema = z.object({
  root: z.object({
    goal: z.string().min(1),
  }),
  children: z.array(z.object({
    goal: z.string().min(1),
    depends_on: z.array(z.string()).optional(),
  })),
})

export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id: planId } = await params
    const plan = getPlan(planId)
    if (!plan) return notFound('Plan')

    const body = await req.json()
    const parsed = AcceptSchema.safeParse(body)
    if (!parsed.success) return err(parsed.error.message)

    const { root, children } = parsed.data
    const now = new Date().toISOString()

    // Create root task
    const rootId = nextChildId(planId, null)
    insertTask({
      id: rootId,
      plan_id: planId,
      goal: root.goal,
      status: 'pending',
      result: null,
      abandon_reason: null,
      state: {},
      depends_on: null,
      notes: null,
      created_by: 'human',
      created_at: now,
      updated_at: now,
    })
    recordEvent({ planId, taskId: rootId, eventType: 'task_created', actor: 'human', payload: { goal: root.goal, via: 'generate_plan_accept' } })

    // Pre-compute child IDs (rootId was just created with no children, so they are sequential)
    const childIds = children.map((_, i) => `${rootId}.${i + 1}`)

    // Create children under root
    const createdIds: string[] = [rootId]
    for (let i = 0; i < children.length; i++) {
      const child = children[i]
      const childId = childIds[i]
      // Translate 0-based sibling indices → actual task IDs
      const resolvedDeps = (child.depends_on ?? [])
        .map(idx => childIds[parseInt(idx)])
        .filter(Boolean)
      insertTask({
        id: childId,
        plan_id: planId,
        goal: child.goal,
        status: 'pending',
        result: null,
        abandon_reason: null,
        state: {},
        depends_on: resolvedDeps.length > 0 ? resolvedDeps : null,
        notes: null,
        created_by: 'human',
        created_at: now,
        updated_at: now,
      })
      recordEvent({ planId, taskId: childId, eventType: 'task_created', actor: 'human', payload: { goal: child.goal, via: 'generate_plan_accept' } })
      createdIds.push(childId)
    }

    touchPlan(planId)

    return ok({ root_id: rootId, created: createdIds }, 201)
  } catch (e) {
    return serverError(e)
  }
}
