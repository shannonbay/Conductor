import { getProject } from '../db.js'
import { getOpenProject } from '../session.js'
import { buildContext } from '../context.js'
import { GetContextSchema } from '../schema.js'

export async function get_context(args: unknown) {
  GetContextSchema.parse(args)

  const projectId = getOpenProject()
  if (!projectId) {
    return {
      error: 'No project is open. Use list_projects to see available projects, then open_project to open one.',
    }
  }

  const project = getProject(projectId)!
  if (!project.focus_task_id) {
    return {
      project: { id: project.id, name: project.name },
      message: 'Project is open but the task tree is empty. Use create_task to add the first task.',
    }
  }

  return buildContext(projectId, project.focus_task_id)
}
