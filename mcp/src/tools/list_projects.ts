import { listProjects, getTreeStats } from '../db.js'
import { ListProjectsSchema } from '../schema.js'

export async function list_projects(args: unknown) {
  const input = ListProjectsSchema.parse(args)
  const projects = listProjects(input.status)

  return {
    projects: projects.map(p => ({
      id: p.id,
      name: p.name,
      description: p.description,
      status: p.status,
      created_at: p.created_at,
      updated_at: p.updated_at,
      tree_stats: getTreeStats(p.id),
    })),
  }
}
