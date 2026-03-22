import { getProject, getTask, getChildren, getSiblings, getTreeStats, type Task } from './db.js'

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

export function buildContext(projectId: string, focusTaskId: string) {
  const project = getProject(projectId)
  if (!project) throw new Error(`Project ${projectId} not found`)

  const focus = getTask(projectId, focusTaskId)
  if (!focus) throw new Error(`Task ${focusTaskId} not found in project ${projectId}`)

  const segments = focusTaskId.split('.')
  const parentId = segments.length > 1 ? segments.slice(0, -1).join('.') : null
  const parent = parentId ? getTask(projectId, parentId) : null

  const siblings = getSiblings(projectId, focusTaskId)
  const children = getChildren(projectId, focusTaskId)
  const tree_stats = getTreeStats(projectId)

  return {
    project: { id: project.id, name: project.name },
    focus,
    parent: parent ? { id: parent.id, goal: parent.goal, status: parent.status } : null,
    siblings: siblings.map(summarize),
    children: children.map(summarize),
    tree_stats,
  }
}
