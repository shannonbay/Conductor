/**
 * Tools the conductor-goals Claude Code plugin uses to drive goal runs: the
 * scheduler pass, the overview, human decisions from the Goals pane, and run
 * bookkeeping. The plugin refuses the human-only ones when a model calls them
 * (see plugins/conductor-goals/hooks/guard.ts); agents use the goal tools.
 */
import {
  schedulerPass, releaseLease, overviewWithEtag, decideItem, failRun, attachAgent, guardToolCallForRun,
  getGoal, getRun, getOpenGoalRun, updateGoal, touchPlan, createGoal, getMemory, deleteMemory,
  setSchedule, getSchedule, nextScheduledRun,
} from '../db.js'
import {
  GoalsTickSchema, GoalsOverviewSchema, DecideItemSchema, CancelRunSchema, SetGoalStatusSchema, AttachAgentSchema,
  FailRunSchema, GuardCheckSchema, CreateGoalSchema, DeleteMemorySchema, SetScheduleSchema,
} from '../schema.js'
import { existsSync } from 'fs'
import { nanoid } from 'nanoid'
import { record } from '../history.js'

const human = { actor: 'human' as const, via: 'plugin' }

export async function goals_tick(args: unknown) {
  const input = GoalsTickSchema.parse(args)
  if (input.release) {
    releaseLease(input.holder)
    return { released: true }
  }
  const pass = await schedulerPass({
    holder: input.holder,
    trackedRunIds: new Set(input.tracked_run_ids),
    maxConcurrent: input.max_concurrent,
  })
  for (const run of pass.claimed) {
    record(run.goal_id, run.goal_id, 'agent_started', { run_id: run.run_id, trigger: run.trigger, holder: input.holder }, { via: 'plugin' })
  }
  return pass
}

export async function goals_overview(args: unknown) {
  const input = GoalsOverviewSchema.parse(args)
  const { body, etag } = overviewWithEtag()
  if (input.etag === etag) return { changed: false, etag }
  return { changed: true, etag, ...JSON.parse(body) as object }
}

export async function decide_item(args: unknown) {
  const input = DecideItemSchema.parse(args)
  if (!getGoal(input.goal_id)) throw new Error(`Goal ${input.goal_id} not found.`)
  const r = decideItem(input.goal_id, input.item_id, { decision: input.decision, feedback: input.feedback })
  if (input.decision === 'approve') {
    record(input.goal_id, input.item_id, 'approval_granted', {}, human)
  } else {
    record(input.goal_id, input.item_id, 'review_rejected', { feedback: input.feedback }, human)
  }
  touchPlan(input.goal_id)
  return {
    item: { id: r.task.id, status: r.task.status, approved_at: r.task.approved_at },
    queued_run: r.queuedRun ? { id: r.queuedRun.id, status: r.queuedRun.status } : null,
  }
}

export async function cancel_run(args: unknown) {
  const input = CancelRunSchema.parse(args)
  const run = getOpenGoalRun(input.goal_id)
  if (!run) throw new Error('This goal has no run in progress.')
  failRun(run.id, 'failed', input.reason ?? 'Cancelled by you')
  record(input.goal_id, input.goal_id, 'agent_cancelled', { run_id: run.id }, human)
  return { cancelled: run.id, agent_id: run.agent_id }
}

export async function set_goal_status(args: unknown) {
  const input = SetGoalStatusSchema.parse(args)
  const goal = getGoal(input.goal_id)
  if (!goal) throw new Error(`Goal ${input.goal_id} not found.`)
  if (goal.status === 'retired') throw new Error('This goal is retired.')
  updateGoal(input.goal_id, { status: input.status })
  record(input.goal_id, input.goal_id, 'goal_updated', { status: input.status }, human)
  return { goal_id: input.goal_id, status: input.status }
}

export async function attach_agent(args: unknown) {
  const input = AttachAgentSchema.parse(args)
  if (!getRun(input.run_id)) throw new Error(`Run ${input.run_id} not found.`)
  attachAgent(input.run_id, input.agent_id)
  return { run_id: input.run_id, agent_id: input.agent_id }
}

export async function fail_run(args: unknown) {
  const input = FailRunSchema.parse(args)
  const run = getRun(input.run_id)
  if (!run) throw new Error(`Run ${input.run_id} not found.`)
  const open = run.status === 'running' || run.status === 'queued'
  if (open) {
    failRun(run.id, input.status, input.reason)
    record(run.plan_id, run.plan_id, input.status === 'timed_out' ? 'agent_timed_out' : 'agent_failed', { run_id: run.id, reason: input.reason }, { via: 'plugin' })
  }
  return { run_id: run.id, status: open ? input.status : run.status, changed: open }
}

export async function guard_check(args: unknown) {
  const input = GuardCheckSchema.parse(args)
  return guardToolCallForRun(input.run_id, input.tool_name)
}

export async function create_goal(args: unknown) {
  const input = CreateGoalSchema.parse(args)
  if (!existsSync(input.working_dir)) throw new Error(`Working directory not found: ${input.working_dir}`)
  const now = new Date().toISOString()
  const id = `plan_${nanoid(10)}`
  createGoal(
    { id, name: input.name, description: input.objective, status: 'active', working_dir: input.working_dir, created_at: now, updated_at: now },
    { objective: input.objective, instructions: input.instructions ?? '', autonomy: {} },
    input.interval_minutes ? { minutes: input.interval_minutes } : undefined,
  )
  record(id, id, 'plan_created', { kind: 'goal' }, human)
  return { id }
}

export async function delete_memory(args: unknown) {
  const input = DeleteMemorySchema.parse(args)
  const m = getMemory(input.memory_id)
  if (!m || m.plan_id !== input.goal_id) throw new Error(`Memory ${input.memory_id} not found in this goal.`)
  deleteMemory(m.id)
  record(input.goal_id, input.goal_id, 'memory_deleted', { memory_id: m.id, text: m.text }, human)
  return { deleted: m.id }
}

/**
 * Replaces a goal's schedule (null: on demand only). As the web app does, a
 * new schedule makes the next run due: now for an interval, the next match for cron.
 */
export async function set_schedule(args: unknown) {
  const input = SetScheduleSchema.parse(args)
  if (!getGoal(input.goal_id)) throw new Error(`Goal ${input.goal_id} not found.`)
  setSchedule(input.goal_id, input.schedule) // throws on a cron expression that never matches
  const schedule = getSchedule(input.goal_id)
  const next_run_at = !schedule ? null : schedule.kind === 'interval' ? new Date().toISOString() : nextScheduledRun(input.goal_id)
  updateGoal(input.goal_id, { next_run_at })
  record(input.goal_id, input.goal_id, 'goal_updated', { schedule }, human)
  touchPlan(input.goal_id)
  return { goal_id: input.goal_id, schedule, next_run_at }
}
