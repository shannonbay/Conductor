import { getPlan, getTask, getChildren, getSiblings, getTreeStats, type Task } from './db.js'

type TaskSummary = {
  id: string
  goal: string
  status: string
  result?: string | null
  abandon_reason?: string | null
  depends_on?: string[] | null
}

function summarize(task: Task): TaskSummary {
  const s: TaskSummary = { id: task.id, goal: task.goal, status: task.status }
  if (task.result != null) s.result = task.result
  if (task.abandon_reason != null) s.abandon_reason = task.abandon_reason
  if (task.depends_on != null) s.depends_on = task.depends_on
  return s
}

export function buildContext(planId: string, focusTaskId: string) {
  const project = getPlan(planId)
  if (!project) throw new Error(`Plan ${planId} not found`)

  const focus = getTask(planId, focusTaskId)
  if (!focus) throw new Error(`Task ${focusTaskId} not found in plan ${planId}`)

  const segments = focusTaskId.split('.')
  const parentId = segments.length > 1 ? segments.slice(0, -1).join('.') : null
  const parent = parentId ? getTask(planId, parentId) : null

  const siblings = getSiblings(planId, focusTaskId)
  const children = getChildren(planId, focusTaskId)
  const tree_stats = getTreeStats(planId)

  return {
    plan: { id: project.id, name: project.name, working_dir: project.working_dir },
    focus,
    parent: parent ? { id: parent.id, goal: parent.goal, status: parent.status } : null,
    siblings: siblings.map(summarize),
    children: children.map(summarize),
    tree_stats,
  }
}
