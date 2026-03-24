import { listPlans, getTreeStats } from '../db.js'
import { ListPlansSchema } from '../schema.js'

export async function list_plans(args: unknown) {
  const input = ListPlansSchema.parse(args)
  const plans = listPlans(input.status)

  return {
    plans: plans.map(p => ({
      id: p.id,
      name: p.name,
      description: p.description,
      status: p.status,
      working_dir: p.working_dir,
      created_at: p.created_at,
      updated_at: p.updated_at,
      tree_stats: getTreeStats(p.id),
    })),
  }
}
