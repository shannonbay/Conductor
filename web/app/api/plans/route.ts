import { NextRequest } from 'next/server'
import { nanoid } from 'nanoid'
import { z } from 'zod'
import { listPlans, getTreeStats, insertPlan } from '@/lib/db'
import { recordEvent } from '@/lib/event-log'
import { ok, err, serverError } from '@/lib/api-utils'

const CreatePlanSchema = z.object({
  name: z.string().min(1),
  description: z.string().optional(),
  working_dir: z.string().min(1),
})

export async function GET(req: NextRequest) {
  try {
    const status = (req.nextUrl.searchParams.get('status') ?? 'active') as 'active' | 'archived' | 'all'
    const plans = listPlans(status)
    const result = plans.map((p) => ({ ...p, tree_stats: getTreeStats(p.id) }))
    return ok(result)
  } catch (e) {
    return serverError(e)
  }
}

export async function POST(req: NextRequest) {
  try {
    const body = await req.json()
    const parsed = CreatePlanSchema.safeParse(body)
    if (!parsed.success) return err(parsed.error.message)

    const { name, description, working_dir } = parsed.data
    const now = new Date().toISOString()
    const plan = {
      id: `plan_${nanoid(10)}`,
      name,
      description: description ?? null,
      status: 'active' as const,
      working_dir,
      focus_task_id: null,
      created_at: now,
      updated_at: now,
    }
    insertPlan(plan)
    recordEvent({ planId: plan.id, taskId: plan.id, eventType: 'plan_created', actor: 'human' })
    return ok({ ...plan, tree_stats: getTreeStats(plan.id) }, 201)
  } catch (e) {
    return serverError(e)
  }
}
