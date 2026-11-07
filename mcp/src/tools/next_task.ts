import { getAllTasks, compareTaskIds, type Task } from '../db.js'
import { getOpenPlan } from '../session.js'
import { buildContext } from '../context.js'
import { NextTaskSchema } from '../schema.js'

type Action = 'continue' | 'start' | 'complete'

const isResolved = (t: Task) => t.status === 'completed' || t.status === 'abandoned'

/**
 * Picks the next thing to work on in the open plan, walking the tree in order:
 *   continue — an active leaf task (work already in progress)
 *   start    — a pending leaf task whose dependencies are all completed
 *   complete — a task whose children are all resolved, ready to synthesize and close
 * Completed/abandoned subtrees are skipped, and a task with unmet depends_on
 * blocks its whole subtree. Returns action "none" with blockers if nothing is ready.
 */
export async function next_task(args: unknown) {
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

  const unmetDeps = (t: Task) =>
    (t.depends_on ?? [])
      .map((id) => ({ id, status: byId.get(id)?.status ?? 'missing' }))
      .filter((d) => d.status !== 'completed')

  function visit(t: Task): { action: Action; task: Task } | null {
    if (isResolved(t)) return null

    if (t.status === 'pending') {
      const waiting = unmetDeps(t)
      if (waiting.length > 0) {
        blocked.push({ id: t.id, goal: t.goal, waiting_on: waiting })
        return null
      }
    }

    const children = childrenOf.get(t.id) ?? []
    if (children.length === 0) {
      return { action: t.status === 'active' ? 'continue' : 'start', task: t }
    }
    for (const c of children) {
      const found = visit(c)
      if (found) return found
    }
    return children.every(isResolved) ? { action: 'complete', task: t } : null
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
  return {
    action: 'none',
    message: 'No task is ready: everything left is waiting on unmet dependencies. Complete the tasks they wait on, or abandon the blocked tasks with a reason.',
    blocked,
  }
}

function hintFor(action: Action, task: Task): string {
  switch (action) {
    case 'continue':
      return 'This task is already active. Keep working on it, record progress with update_task, then set_status completed.'
    case 'complete':
      return 'All children are resolved. Call synthesize on this task, then set_status completed with a result.'
    case 'start': {
      const needsDecompose = process.env.CONDUCTOR_REQUIRE_DECOMPOSE === '1' && task.state.atomic !== true
      return needsDecompose
        ? 'Ready to start. Decompose it with provision_tasks first, or mark it atomic (update_task state_patch {"atomic": true}), then set_status active.'
        : 'Ready to start. Call set_status active, do the work, then set_status completed with a result.'
    }
  }
}
