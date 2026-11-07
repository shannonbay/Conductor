import { NextRequest } from 'next/server'
import { z } from 'zod'
import {
  getPlan, updatePlan, getGoal, updateGoal, getIntervalTrigger, setIntervalTrigger, listRuns, getOpenRun,
  listMemory, getGoalItems, getApprovalStats, isProposal, type Task,
} from '@/lib/db'
import { recordEvent } from '@/lib/event-log'
import { ok, err, notFound, serverError } from '@/lib/api-utils'

type Params = { params: Promise<{ id: string }> }

function itemView(t: Task) {
  return {
    id: t.id,
    goal: t.goal,
    status: t.status,
    result: t.result,
    notes: t.notes,
    external_ref: t.external_ref,
    run_id: t.run_id,
    action: isProposal(t) ? t.state.action : null,
    awaiting_review: t.review_requested_at !== null,
    approved_to_execute: isProposal(t) && t.approved_at !== null && t.status === 'active',
    updated_at: t.updated_at,
  }
}

/** GET — everything the goal page shows. */
export async function GET(_req: NextRequest, { params }: Params) {
  try {
    const { id } = await params
    const plan = getPlan(id)
    const goal = getGoal(id)
    if (!plan || !goal) return notFound('Goal')

    const items = getGoalItems(id)
    const open = items.filter((t) => t.status === 'pending' || t.status === 'active')
    return ok({
      plan: { id: plan.id, name: plan.name, working_dir: plan.working_dir },
      goal,
      interval: getIntervalTrigger(id)?.config ?? null,
      open_run: getOpenRun(id) ?? null,
      runs: listRuns(id, 30),
      needs_you: open.filter((t) => t.review_requested_at).map(itemView),
      open_items: open.filter((t) => !t.review_requested_at).map(itemView),
      recently_resolved: items
        .filter((t) => t.status === 'completed' || t.status === 'abandoned')
        .sort((a, b) => b.updated_at.localeCompare(a.updated_at))
        .slice(0, 20)
        .map(itemView),
      memory: listMemory(id),
      approval_stats: getApprovalStats(id),
    })
  } catch (e) {
    return serverError(e)
  }
}

const PatchSchema = z.object({
  name: z.string().trim().min(1).optional(),
  objective: z.string().trim().min(1).optional(),
  instructions: z.string().optional(),
  status: z.enum(['active', 'paused', 'retired']).optional(),
  autonomy: z.record(z.enum(['off', 'propose', 'auto'])).optional(),
  limits: z.object({
    max_run_minutes: z.number().int().min(1).max(120),
    max_items_per_run: z.number().int().min(1).max(500),
    max_runs_per_day: z.number().int().min(1).max(1440),
  }).partial().optional(),
  item_retention_days: z.number().int().min(1).max(365).optional(),
  interval: z.object({
    minutes: z.number().int().min(1).max(10_080),
    active_hours: z.string().regex(/^\d{2}:\d{2}-\d{2}:\d{2}$/, 'Use HH:MM-HH:MM').nullable().optional(),
  }).nullable().optional(),
})

/** PATCH — edit goal settings, pause/resume/retire, change the schedule. */
export async function PATCH(req: NextRequest, { params }: Params) {
  try {
    const { id } = await params
    const goal = getGoal(id)
    if (!goal) return notFound('Goal')
    const parsed = PatchSchema.safeParse(await req.json())
    if (!parsed.success) return err(parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; '))
    const { name, interval, ...fields } = parsed.data

    if (name) updatePlan(id, { name, updated_at: new Date().toISOString() })
    if (fields.objective) updatePlan(id, { description: fields.objective })
    updateGoal(id, fields)

    if (interval !== undefined) {
      setIntervalTrigger(id, interval ? { minutes: interval.minutes, ...(interval.active_hours && { active_hours: interval.active_hours }) } : null)
    }
    // Resuming or (re)scheduling an active goal makes the next run due now
    const nowActive = (fields.status ?? goal.status) === 'active'
    if (nowActive && (interval || (fields.status === 'active' && goal.status !== 'active'))) {
      updateGoal(id, { next_run_at: getIntervalTrigger(id) ? new Date().toISOString() : null })
    }
    if (interval === null) updateGoal(id, { next_run_at: null })

    recordEvent({ planId: id, taskId: id, eventType: 'plan_updated', actor: 'human', payload: { changes: Object.keys(parsed.data) } })
    return ok({ goal: getGoal(id), interval: getIntervalTrigger(id)?.config ?? null })
  } catch (e) {
    return serverError(e)
  }
}
