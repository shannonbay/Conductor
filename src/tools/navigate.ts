import { getProject, getTask, updateProject } from '../db.js'
import { getOpenProject } from '../session.js'
import { buildContext } from '../context.js'
import { NavigateSchema } from '../schema.js'

export async function navigate(args: unknown) {
  const input = NavigateSchema.parse(args)

  const projectId = getOpenProject()
  if (!projectId) throw new Error('No project is open. Use open_project or create_project first.')

  const task = getTask(projectId, input.target_id)
  if (!task) throw new Error(`Task ${input.target_id} not found in this project.`)

  const now = new Date().toISOString()
  updateProject(projectId, { focus_task_id: input.target_id, updated_at: now })

  return buildContext(projectId, input.target_id)
}
