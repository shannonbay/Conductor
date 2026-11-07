import { NextRequest } from 'next/server'
import { z } from 'zod'
import { getPlan, getTask, getChildren, getSiblings, updateTask, touchPlan, checkHumanCompletion } from '@/lib/db'
import { recordEvent } from '@/lib/event-log'
import { ok, err, notFound, serverError } from '@/lib/api-utils'

const SetStatusSchema = z.object({
  status: z.enum(['active', 'pending', 'completed', 'abandoned']),
  reason: z.string().optional(),
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
    const parsed = SetStatusSchema.safeParse(body)
    if (!parsed.success) return err(parsed.error.message)

    const { status, reason } = parsed.data

    if (status === 'abandoned' && !reason) {
      return err('reason is required when abandoning a task')
    }

    // Validate: activating a task requires all depends_on to be completed
    if (status === 'active' && task.depends_on && task.depends_on.length > 0) {
      const siblings = getSiblings(planId, taskId)
      const siblingsById = new Map(siblings.map((s) => [s.id, s]))
      for (const depId of task.depends_on) {
        const dep = siblingsById.get(depId)
        if (!dep || dep.status !== 'completed') {
          return err(`Cannot activate: dependency ${depId} is not completed`)
        }
      }
    }

    // Check for unresolved children when completing
    let warning: string | undefined
    if (status === 'completed') {
      const children = getChildren(planId, taskId)
      const unresolved = children.filter((c) => c.status !== 'completed' && c.status !== 'abandoned')
      if (unresolved.length > 0) {
        warning = `${unresolved.length} child task(s) are not yet resolved`
      }

      // Verification gates (same rules as the MCP server, as a human: criteria
      // waived and completing counts as approval, but the command must pass)
      const outcome = await checkHumanCompletion(plan, task)
      if (outcome.outcome === 'blocked') {
        recordEvent({
          planId, taskId, eventType: 'verification_failed', actor: 'human',
          payload: { gates: outcome.blockers.map((b) => b.gate), message: outcome.blockers.map((b) => b.message).join(' ') },
        })
        return ok({
          error: 'Verification failed — the task was not completed.',
          blockers: outcome.blockers,
          can_override: true,
        }, 409)
      }
    }

    const now = new Date().toISOString()
    const fields: Record<string, unknown> = { status, updated_at: now }
    if (status === 'abandoned') fields['abandon_reason'] = reason
    // Leaving the task cancels a pending review request
    if (status !== 'completed' && task.review_requested_at) fields['review_requested_at'] = null

    updateTask(planId, taskId, fields)
    touchPlan(planId)
    recordEvent({
      planId,
      taskId,
      eventType: 'status_changed',
      actor: 'human',
      payload: { from: task.status, to: status, reason },
    })

    const updated = getTask(planId, taskId)!
    return ok({ task: updated, warning })
  } catch (e) {
    return serverError(e)
  }
}
