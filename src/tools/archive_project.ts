import { getProject, updateProject } from '../db.js'
import { getOpenProject, setOpenProject } from '../session.js'
import { ArchiveProjectSchema } from '../schema.js'

export async function archive_project(args: unknown) {
  const input = ArchiveProjectSchema.parse(args)
  const project = getProject(input.project_id)
  if (!project) throw new Error(`Project ${input.project_id} not found`)

  const now = new Date().toISOString()
  updateProject(project.id, { status: 'archived', updated_at: now })

  if (getOpenProject() === project.id) {
    setOpenProject(null)
  }

  return {
    id: project.id,
    name: project.name,
    description: project.description,
    status: 'archived',
    focus_task_id: project.focus_task_id,
    created_at: project.created_at,
    updated_at: now,
  }
}
