import { nanoid } from 'nanoid'
import { insertPlan, getTreeStats } from '../db.js'
import { setOpenPlan } from '../session.js'
import { CreatePlanSchema } from '../schema.js'
import { z } from 'zod'

export async function create_plan(args: unknown) {
  const input = CreatePlanSchema.parse(args)
  const id = 'plan_' + nanoid(10)
  const now = new Date().toISOString()

  const working_dir = input.working_dir ?? process.cwd()

  insertPlan({
    id,
    name: input.name,
    description: input.description ?? null,
    status: 'active',
    working_dir,
    focus_task_id: null,
    created_at: now,
    updated_at: now,
  })

  setOpenPlan(id)

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
