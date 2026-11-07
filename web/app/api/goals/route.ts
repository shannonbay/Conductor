import { NextRequest } from 'next/server'
import { z } from 'zod'
import { nanoid } from 'nanoid'
import { existsSync } from 'fs'
import { createGoal, listGoals, getGoalItems, listRuns, GoalError } from '@/lib/db'
import { recordEvent } from '@/lib/event-log'
import { ok, err, serverError } from '@/lib/api-utils'

const AutonomySchema = z.record(z.enum(['off', 'propose', 'auto']))

const CreateGoalSchema = z.object({
  name: z.string().trim().min(1),
  objective: z.string().trim().min(1),
  instructions: z.string().default(''),
  working_dir: z.string().trim().min(1),
  interval_minutes: z.number().int().min(1).max(10_080).nullable().optional(),
  active_hours: z.string().regex(/^\d{2}:\d{2}-\d{2}:\d{2}$/, 'Use HH:MM-HH:MM').nullable().optional(),
  autonomy: AutonomySchema.optional(),
})

/** GET — goals with their counts and latest run. ?status=active|paused|retired|all (default all). */
export async function GET(req: NextRequest) {
  try {
    const status = req.nextUrl.searchParams.get('status')
    const goals = listGoals(status && status !== 'all' ? (status as 'active' | 'paused' | 'retired') : undefined)
    return ok(goals.map(({ plan, goal }) => {
      const items = getGoalItems(plan.id)
      const open = items.filter((t) => t.status === 'pending' || t.status === 'active')
      return {
        id: plan.id,
        name: plan.name,
        objective: goal.objective,
        status: goal.status,
        open_items: open.length,
        needs_you: open.filter((t) => t.review_requested_at).length,
        last_run: listRuns(plan.id, 1)[0] ?? null,
        next_run_at: goal.next_run_at,
      }
    }))
  } catch (e) {
    return serverError(e)
  }
}

/** POST — create a goal (a plan of kind 'goal' plus its settings and optional interval trigger). */
export async function POST(req: NextRequest) {
  try {
    const parsed = CreateGoalSchema.safeParse(await req.json())
    if (!parsed.success) return err(parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; '))
    const input = parsed.data
    if (!existsSync(input.working_dir)) return err(`Working directory not found: ${input.working_dir}`)

    const now = new Date().toISOString()
    const id = `plan_${nanoid(10)}`
    const goal = createGoal(
      { id, name: input.name, description: input.objective, status: 'active', working_dir: input.working_dir, created_at: now, updated_at: now },
      { objective: input.objective, instructions: input.instructions, autonomy: input.autonomy ?? {} },
      input.interval_minutes ? { minutes: input.interval_minutes, ...(input.active_hours && { active_hours: input.active_hours }) } : undefined,
    )
    recordEvent({ planId: id, taskId: id, eventType: 'plan_created', actor: 'human', payload: { kind: 'goal' } })
    return ok({ id, goal }, 201)
  } catch (e) {
    if (e instanceof GoalError) return err(e.message)
    if (e instanceof Error && /Interval|active_hours/.test(e.message)) return err(e.message)
    return serverError(e)
  }
}
