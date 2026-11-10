import { getTask, getChildren, updateTask, touchPlan, getPlan, checkCompletion, describeBlockers } from '../db.js'
import { getOpenPlan } from '../session.js'
import { buildContext } from '../context.js'
import { SetStatusSchema } from '../schema.js'
import { record } from '../history.js'
import { envVar, hasGates } from '@quarterdeck/core'

export async function set_status(args: unknown) {
  const input = SetStatusSchema.parse(args)

  const planId = getOpenPlan()
  if (!planId) throw new Error('No plan is open. Use open_plan or create_plan first.')

  const task = getTask(planId, input.task_id)
  if (!task) throw new Error(`Task ${input.task_id} not found.`)

  let warning: string | undefined

  if (input.status === 'abandoned') {
    if (!input.reason) throw new Error('reason is required when setting status to abandoned.')
  }

  if (input.status === 'active') {
    if (task.depends_on && task.depends_on.length > 0) {
      const blockers = task.depends_on.filter(depId => {
        const dep = getTask(planId, depId)
        return dep?.status !== 'completed'
      })
      if (blockers.length > 0) {
        throw new Error(`Cannot activate task: unmet dependencies: ${blockers.join(', ')}`)
      }
    }

    // Opt-in: force agents to break a task into sub-tasks before starting it.
    if (envVar('REQUIRE_DECOMPOSE') === '1'
        && task.state.atomic !== true
        && getChildren(planId, input.task_id).length === 0) {
      throw new Error(
        `Task ${input.task_id} has no sub-tasks yet. Choose one:\n` +
        '1. Multi-step work: call provision_tasks to create child tasks, then activate the first child ' +
        '(leave this parent pending). Repeat on each child until you reach leaf tasks.\n' +
        '2. Single atomic step (one specific tool call): call update_task with state_patch: {"atomic": true}, ' +
        'then retry set_status.'
      )
    }
  }

  if (input.status === 'completed') {
    const children = getChildren(planId, input.task_id)
    const unfinished = children.filter(c => c.status !== 'completed' && c.status !== 'abandoned')
    if (unfinished.length > 0) {
      const ids = unfinished.map(c => c.id).join(', ')
      // Opt-in: refuse to complete a parent until every child is resolved.
      if (envVar('STRICT_COMPLETE') === '1') {
        throw new Error(
          `Cannot complete task ${input.task_id}: ${unfinished.length} child task(s) are not yet completed or abandoned: ${ids}. ` +
          'Finish or abandon them (with a reason), call synthesize on this task, then retry.'
        )
      }
      warning = `Warning: ${unfinished.length} child task(s) are not yet completed or abandoned: ${ids}`
    }

    // Verification gates: criteria evidence, verify command, human approval
    const outcome = await checkCompletion(getPlan(planId)!, task, { actor: 'agent', evidence: input.evidence })
    if (outcome.outcome === 'blocked') {
      record(planId, input.task_id, 'verification_failed', {
        gates: outcome.blockers.map((b) => b.gate),
        message: outcome.blockers.map((b) => b.message).join(' '),
      })
      throw new Error(`Cannot complete task ${input.task_id}: verification failed.\n\n${describeBlockers(outcome.blockers)}`)
    }
    if (outcome.outcome === 'awaiting_review') {
      if (!task.review_requested_at) {
        if (input.result !== undefined) {
          updateTask(planId, input.task_id, { result: input.result, updated_at: new Date().toISOString() })
        }
        touchPlan(planId)
        record(planId, input.task_id, 'approval_requested', input.result !== undefined ? { result: input.result } : {})
      }
      return {
        ...buildContext(planId, input.task_id),
        awaiting_review: true,
        message: `All automatic checks passed. Task ${input.task_id} is now waiting for a human to approve it in the web UI — ` +
          'it stays active until then. Move on to other work (next_task skips it); if it is rejected, the feedback will be added to its notes.',
      }
    }
  }

  const now = new Date().toISOString()
  const fields: Record<string, unknown> = { status: input.status, updated_at: now }
  if (input.status === 'abandoned') fields.abandon_reason = input.reason!
  if (input.result !== undefined) fields.result = input.result
  // Leaving the task (e.g. abandoning it) cancels a pending review request
  if (input.status !== 'completed' && task.review_requested_at) fields.review_requested_at = null

  updateTask(planId, input.task_id, fields as Parameters<typeof updateTask>[2])
  touchPlan(planId)
  record(planId, input.task_id, 'status_changed', {
    from: task.status,
    to: input.status,
    ...(input.reason !== undefined && { reason: input.reason }),
    ...(input.result !== undefined && { result: input.result, previous_result: task.result }),
    ...(input.status === 'completed' && hasGates(task) && { verified: true }),
  })

  const context = buildContext(planId, input.task_id)
  if (warning) {
    return { ...context, warning }
  }
  return context
}
