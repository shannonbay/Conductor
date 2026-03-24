import { NextRequest } from 'next/server'
import { z } from 'zod'
import { getPlan, getFullTree, getTask, getSiblings, nextChildId, insertTask, updatePlan, countAllTasks, touchPlan } from '@/lib/db'
import { recordEvent } from '@/lib/event-log'
import { ok, err, notFound, serverError } from '@/lib/api-utils'

const CreateTaskSchema = z.object({
  goal: z.string().min(1),
  parent_id: z.string().nullable().optional(),
  status: z.enum(['active', 'pending']).default('pending'),
  initial_state: z.record(z.unknown()).optional(),
  depends_on: z.array(z.string()).optional(),
  notes: z.string().optional(),
})

export async function GET(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await params
    const plan = getPlan(id)
    if (!plan) return notFound('Plan')
    return ok(getFullTree(id))
  } catch (e) {
    return serverError(e)
  }
}

export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id: planId } = await params
    const plan = getPlan(planId)
    if (!plan) return notFound('Plan')

    const body = await req.json()
    const parsed = CreateTaskSchema.safeParse(body)
    if (!parsed.success) return err(parsed.error.message)

    const { goal, parent_id, status, initial_state, depends_on, notes } = parsed.data

    // Validate: root task requires empty tree
    if (!parent_id && countAllTasks(planId) > 0) {
      return err('A root task already exists. Provide a parent_id to create a child task.')
    }

    // Compute tree-address ID
    const taskId = parent_id
      ? nextChildId(planId, parent_id)
      : nextChildId(planId, null)

    // Validate parent exists
    if (parent_id) {
      const parent = getTask(planId, parent_id)
      if (!parent) return notFound(`Parent task ${parent_id}`)
    }

    // Validate depends_on are siblings
    if (depends_on && depends_on.length > 0) {
      const siblings = getSiblings(planId, taskId)
      const siblingIds = new Set(siblings.map((s) => s.id))
      for (const depId of depends_on) {
        if (!siblingIds.has(depId)) {
          return err(`depends_on task ${depId} is not a sibling of ${taskId}`)
        }
        if (status === 'active') {
          const dep = getTask(planId, depId)
          if (dep && dep.status !== 'completed') {
            return err(`Cannot set status to active: dependency ${depId} is not completed`)
          }
        }
      }
    }

    const now = new Date().toISOString()
    insertTask({
      id: taskId,
      plan_id: planId,
      goal,
      status,
      result: null,
      abandon_reason: null,
      state: initial_state ?? {},
      depends_on: depends_on ?? null,
      notes: notes ?? null,
      created_by: 'human',
      created_at: now,
      updated_at: now,
    })

    // Update plan focus to new task
    updatePlan(planId, { focus_task_id: taskId, updated_at: now })

    recordEvent({ planId, taskId, eventType: 'task_created', actor: 'human', payload: { goal, status } })
    return ok(getTask(planId, taskId)!, 201)
  } catch (e) {
    return serverError(e)
  }
}
