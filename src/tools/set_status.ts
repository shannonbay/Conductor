import { getProject, getTask, getChildren, updateTask, touchProject } from '../db.js'
import { getOpenProject } from '../session.js'
import { buildContext } from '../context.js'
import { SetStatusSchema } from '../schema.js'

export async function set_status(args: unknown) {
  const input = SetStatusSchema.parse(args)

  const projectId = getOpenProject()
  if (!projectId) throw new Error('No project is open. Use open_project or create_project first.')

  const project = getProject(projectId)!
  const focusTaskId = project.focus_task_id
  if (!focusTaskId) throw new Error('No focus task. Use create_task to add the first task.')

  const targetId = input.target_id ?? focusTaskId
  const task = getTask(projectId, targetId)
  if (!task) throw new Error(`Task ${targetId} not found.`)

  let warning: string | undefined

  if (input.status === 'abandoned') {
    if (!input.reason) throw new Error('reason is required when setting status to abandoned.')
  }

  if (input.status === 'active') {
    if (task.depends_on && task.depends_on.length > 0) {
      const blockers = task.depends_on.filter(depId => {
        const dep = getTask(projectId, depId)
        return dep?.status !== 'completed'
      })
      if (blockers.length > 0) {
        throw new Error(`Cannot activate task: unmet dependencies: ${blockers.join(', ')}`)
      }
    }
  }

  if (input.status === 'completed') {
    const children = getChildren(projectId, targetId)
    const unfinished = children.filter(c => c.status !== 'completed' && c.status !== 'abandoned')
    if (unfinished.length > 0) {
      warning = `Warning: ${unfinished.length} child task(s) are not yet completed or abandoned: ${unfinished.map(c => c.id).join(', ')}`
    }
  }

  const now = new Date().toISOString()
  const fields: Record<string, unknown> = { status: input.status, updated_at: now }
  if (input.status === 'abandoned') fields.abandon_reason = input.reason!

  updateTask(projectId, targetId, fields as Parameters<typeof updateTask>[2])
  touchProject(projectId)

  const context = buildContext(projectId, focusTaskId)
  if (warning) {
    return { ...context, warning }
  }
  return context
}
