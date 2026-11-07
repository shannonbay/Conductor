import { getAllTasks, compareTaskIds, getLatestVerification, type Task } from '../db.js'
import { hasGates } from '@conductor/core'
import { getOpenPlan } from '../session.js'
import { buildContext } from '../context.js'
import { NextTaskSchema } from '../schema.js'

type Action = 'continue' | 'start' | 'complete' | 'fix'

const isResolved = (t: Task) => t.status === 'completed' || t.status === 'abandoned'

/**
 * Picks the next thing to work on in the open plan, walking the tree in order:
 *   continue — an active leaf task (work already in progress)
 *   start    — a pending leaf task whose dependencies are all completed
 *   complete — a task whose children are all resolved, ready to synthesize and close
 *   fix      — an active task whose last verify command failed
 * Completed/abandoned subtrees are skipped, tasks waiting for human review are
 * skipped, and a task with unmet depends_on blocks its whole subtree.
 * Returns action "none" with what is blocked or awaiting review if nothing is ready.
 */
export interface NextTaskResult {
  action: Action | 'none'
  task_id?: string
  hint?: string
  context?: ReturnType<typeof buildContext>
  message?: string
  blocked?: { id: string; goal: string; waiting_on: { id: string; status: string }[] }[]
  awaiting_review?: { id: string; goal: string; since: string }[]
}

export async function next_task(args: unknown): Promise<NextTaskResult> {
  NextTaskSchema.parse(args)

  const planId = getOpenPlan()
  if (!planId) throw new Error('No plan is open. Use list_plans and open_plan first.')

  const tasks = getAllTasks(planId)
  const byId = new Map(tasks.map((t) => [t.id, t]))
  const childrenOf = new Map<string, Task[]>()
  for (const t of tasks) {
    const parent = t.id.includes('.') ? t.id.slice(0, t.id.lastIndexOf('.')) : ''
    if (!childrenOf.has(parent)) childrenOf.set(parent, [])
    childrenOf.get(parent)!.push(t) // tasks are already in tree order
  }

  const blocked: { id: string; goal: string; waiting_on: { id: string; status: string }[] }[] = []
  const awaitingReview: { id: string; goal: string; since: string }[] = []

  const unmetDeps = (t: Task) =>
    (t.depends_on ?? [])
      .map((id) => ({ id, status: byId.get(id)?.status ?? 'missing' }))
      .filter((d) => d.status !== 'completed')

  const lastCheckFailed = (t: Task) =>
    t.status === 'active' && t.verify_command !== null && getLatestVerification(planId, t.id, 'command')?.passed === false

  function visit(t: Task): { action: Action; task: Task } | null {
    if (isResolved(t)) return null

    if (t.review_requested_at) {
      awaitingReview.push({ id: t.id, goal: t.goal, since: t.review_requested_at })
      return null
    }

    if (t.status === 'pending') {
      const waiting = unmetDeps(t)
      if (waiting.length > 0) {
        blocked.push({ id: t.id, goal: t.goal, waiting_on: waiting })
        return null
      }
    }

    const children = childrenOf.get(t.id) ?? []
    if (children.length === 0) {
      if (lastCheckFailed(t)) return { action: 'fix', task: t }
      return { action: t.status === 'active' ? 'continue' : 'start', task: t }
    }
    for (const c of children) {
      const found = visit(c)
      if (found) return found
    }
    if (!children.every(isResolved)) return null
    return { action: lastCheckFailed(t) ? 'fix' : 'complete', task: t }
  }

  for (const root of (childrenOf.get('') ?? []).sort((a, b) => compareTaskIds(a.id, b.id))) {
    const found = visit(root)
    if (found) {
      return {
        action: found.action,
        task_id: found.task.id,
        hint: hintFor(found.action, found.task),
        context: buildContext(planId, found.task.id),
      }
    }
  }

  if (tasks.length === 0) {
    return { action: 'none', message: 'The plan has no tasks yet. Create a root task with create_task or provision_tasks.' }
  }
  if ((childrenOf.get('') ?? []).every(isResolved)) {
    return { action: 'none', message: 'Every task is completed or abandoned. Archive the plan with archive_plan.' }
  }
  const parts = [
    awaitingReview.length > 0 && `${awaitingReview.length} task(s) are waiting for a human to approve them in the web UI.`,
    blocked.length > 0 && 'Other tasks are waiting on unmet dependencies: complete the tasks they wait on, or abandon the blocked tasks with a reason.',
  ].filter(Boolean)
  return {
    action: 'none',
    message: `No task is ready. ${parts.join(' ')}`,
    ...(awaitingReview.length > 0 && { awaiting_review: awaitingReview }),
    ...(blocked.length > 0 && { blocked }),
  }
}

function hintFor(action: Action, task: Task): string {
  const gateHint = !hasGates(task) ? '' : ' ' + [
    task.acceptance_criteria?.length && `Give evidence for each of its ${task.acceptance_criteria.length} acceptance criteria (evidence param).`,
    task.verify_command && `Conductor will run \`${task.verify_command}\`, which must pass — use verify_task to check first.`,
    task.requires_approval && 'A human must then approve it in the web UI.',
  ].filter(Boolean).join(' ')

  switch (action) {
    case 'continue':
      return 'This task is already active. Keep working on it, record progress with update_task, then set_status completed.' + gateHint
    case 'fix':
      return 'The last verify command run for this task failed (see gates.last_command). Fix the problem, run verify_task, then set_status completed.' + gateHint
    case 'complete':
      return 'All children are resolved. Call synthesize on this task, then set_status completed with a result.' + gateHint
    case 'start': {
      const needsDecompose = process.env.CONDUCTOR_REQUIRE_DECOMPOSE === '1' && task.state.atomic !== true
      return (needsDecompose
        ? 'Ready to start. Decompose it with provision_tasks first, or mark it atomic (update_task state_patch {"atomic": true}), then set_status active.'
        : 'Ready to start. Call set_status active, do the work, then set_status completed with a result.') + gateHint
    }
  }
}
