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
  const newStep = input.advance_step
    ? Math.min(task.step + 1, task.plan.length - 1)
    : task.step

  const now = new Date().toISOString()
  updateTask(projectId, focusTaskId, {
    result: input.result,
    state: newState,
    step: newStep,
    updated_at: now,
  })
  touchProject(projectId)

  return buildContext(projectId, focusTaskId)
}
