import { getProject, getTask, updateTask, touchProject } from '../db.js'
import { getOpenProject } from '../session.js'
import { buildContext } from '../context.js'
import { UpdateTaskSchema } from '../schema.js'

export async function update_task(args: unknown) {
  const input = UpdateTaskSchema.parse(args)

  const projectId = getOpenProject()
  if (!projectId) throw new Error('No project is open. Use open_project or create_project first.')

  const project = getProject(projectId)!
  const focusTaskId = project.focus_task_id
  if (!focusTaskId) throw new Error('No focus task. Use create_task to add the first task.')

  const task = getTask(projectId, focusTaskId)
  if (!task) throw new Error(`Task ${focusTaskId} not found.`)

  const newState = { ...task.state, ...(input.state_patch ?? {}) }

  const now = new Date().toISOString()
  const fields: Parameters<typeof updateTask>[2] = { state: newState, updated_at: now }
  if (input.result !== undefined) fields.result = input.result

  updateTask(projectId, focusTaskId, fields)
  touchProject(projectId)

  return buildContext(projectId, focusTaskId)
}
