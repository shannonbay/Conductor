import { NextRequest } from 'next/server'
import { z } from 'zod'
import { getPlan, getTask, getChildren, getSiblings, getTreeStats, updateTask, deleteTaskTree, touchPlan, getGateStatus, getVerifications } from '@/lib/db'
import { recordEvent } from '@/lib/event-log'
import { ok, err, notFound, conflict, serverError } from '@/lib/api-utils'

const UpdateTaskSchema = z.object({
  goal: z.string().min(1).optional(),
  notes: z.string().nullable().optional(),
  result: z.string().nullable().optional(),
  assigned_to: z.enum(['human', 'agent']).nullable().optional(),
  state_patch: z.record(z.unknown()).optional(),
  // Verification gates — humans can edit these at any time (agents only while pending)
  acceptance_criteria: z.array(z.string().min(1)).max(20).optional(),
  verify_command: z.string().min(1).nullable().optional(),
  verify_timeout_s: z.number().int().min(1).max(3600).nullable().optional(),
  requires_approval: z.boolean().optional(),
})

type Params = { params: Promise<{ id: string; taskId: string }> }

export async function GET(_req: NextRequest, { params }: Params) {
  try {
    const { id: planId, taskId } = await params
    const plan = getPlan(planId)
    if (!plan) return notFound('Plan')
    const task = getTask(planId, taskId)
    if (!task) return notFound('Task')

    const taskParts = taskId.split('.')
    const parentId = taskParts.length > 1 ? taskParts.slice(0, -1).join('.') : null
    const parent = parentId ? getTask(planId, parentId) : null
    const siblings = getSiblings(planId, taskId)
    const children = getChildren(planId, taskId)

    return ok({
      plan: { id: plan.id, name: plan.name },
      task,
      parent: parent ? { id: parent.id, goal: parent.goal, status: parent.status } : null,
      siblings: siblings.map((s) => ({ id: s.id, goal: s.goal, status: s.status, result: s.result, abandon_reason: s.abandon_reason })),
      children: children.map((c) => ({ id: c.id, goal: c.goal, status: c.status, result: c.result, abandon_reason: c.abandon_reason })),
      tree_stats: getTreeStats(planId),
      gates: getGateStatus(task),
      verifications: getVerifications(planId, taskId, 20),
    })
  } catch (e) {
    return serverError(e)
  }
}

export async function PATCH(req: NextRequest, { params }: Params) {
  try {
    const { id: planId, taskId } = await params
    const plan = getPlan(planId)
    if (!plan) return notFound('Plan')
    const task = getTask(planId, taskId)
    if (!task) return notFound('Task')

    const body = await req.json()
    const parsed = UpdateTaskSchema.safeParse(body)
    if (!parsed.success) return err(parsed.error.message)

    const { goal, notes, result, assigned_to, state_patch, acceptance_criteria, verify_command, verify_timeout_s, requires_approval } = parsed.data
    const now = new Date().toISOString()
    const fields: Record<string, unknown> = { updated_at: now }

    if (goal !== undefined) fields['goal'] = goal
    if (notes !== undefined) fields['notes'] = notes
    if (result !== undefined) fields['result'] = result
    if (assigned_to !== undefined) fields['assigned_to'] = assigned_to
    if (state_patch) {
      fields['state'] = { ...task.state, ...state_patch }
    }
    if (acceptance_criteria !== undefined) fields['acceptance_criteria'] = acceptance_criteria
    if (verify_command !== undefined) fields['verify_command'] = verify_command
    if (verify_timeout_s !== undefined) fields['verify_timeout_s'] = verify_timeout_s
    if (requires_approval !== undefined) {
      fields['requires_approval'] = requires_approval
      // Turning approval off releases a task that was waiting for review
      if (!requires_approval) fields['review_requested_at'] = null
    }

    updateTask(planId, taskId, fields)
    touchPlan(planId)
    recordEvent({ planId, taskId, eventType: 'task_updated', actor: 'human', payload: { changes: Object.keys(fields) } })
    return ok(getTask(planId, taskId)!)
  } catch (e) {
    return serverError(e)
  }
}

export async function DELETE(_req: NextRequest, { params }: Params) {
  try {
    const { id: planId, taskId } = await params
    const plan = getPlan(planId)
    if (!plan) return notFound('Plan')
    const task = getTask(planId, taskId)
    if (!task) return notFound('Task')

    if (task.locked_by) {
      return conflict(`Task ${taskId} is locked by agent session ${task.locked_by}`)
    }

    deleteTaskTree(planId, taskId)
    touchPlan(planId)
    recordEvent({ planId, taskId, eventType: 'task_deleted', actor: 'human' })
    return ok({ deleted: taskId })
  } catch (e) {
    return serverError(e)
  }
}
