import { getProject, updateProject } from '../db.js'
import { setOpenProject } from '../session.js'
import { buildContext } from '../context.js'
import { OpenProjectSchema } from '../schema.js'

export async function open_project(args: unknown) {
  const input = OpenProjectSchema.parse(args)
  const project = getProject(input.project_id)
  if (!project) throw new Error(`Project ${input.project_id} not found`)

  if (project.status === 'archived') {
    const now = new Date().toISOString()
    updateProject(project.id, { status: 'active', updated_at: now })
    project.status = 'active'
    project.updated_at = now
  }

  setOpenProject(project.id)

  if (!project.focus_task_id) {
    return {
      project: { id: project.id, name: project.name },
      message: 'Project opened. The task tree is empty — use create_task to add the first task.',
    }
  }

  return buildContext(project.id, project.focus_task_id)
}
