import { getPlan, updatePlan } from '../db.js'
import { getOpenPlan, setOpenPlan } from '../session.js'
import { ArchivePlanSchema } from '../schema.js'

export async function archive_plan(args: unknown) {
  const input = ArchivePlanSchema.parse(args)
  const plan = getPlan(input.plan_id)
  if (!plan) throw new Error(`Plan ${input.plan_id} not found`)

  const now = new Date().toISOString()
  updatePlan(plan.id, { status: 'archived', updated_at: now })

  if (getOpenPlan() === plan.id) {
    setOpenPlan(null)
  }

  return {
    id: plan.id,
    name: plan.name,
    description: plan.description,
    status: 'archived',
    created_at: plan.created_at,
    updated_at: now,
  }
}
