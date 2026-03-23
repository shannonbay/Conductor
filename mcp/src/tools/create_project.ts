import { nanoid } from 'nanoid'
import { insertProject, getTreeStats } from '../db.js'
import { setOpenProject } from '../session.js'
import { CreateProjectSchema } from '../schema.js'
import { z } from 'zod'

export async function create_project(args: unknown) {
  const input = CreateProjectSchema.parse(args)
  const id = 'proj_' + nanoid(10)
  const now = new Date().toISOString()

  const working_dir = input.working_dir ?? process.cwd()

  insertProject({
    id,
    name: input.name,
    description: input.description ?? null,
    status: 'active',
    working_dir,
    focus_task_id: null,
    created_at: now,
    updated_at: now,
  })

  setOpenProject(id)

  return {
    id,
    name: input.name,
    description: input.description ?? null,
    status: 'active',
    working_dir,
    focus_task_id: null,
    created_at: now,
    updated_at: now,
    tree_stats: getTreeStats(id),
  }
}
