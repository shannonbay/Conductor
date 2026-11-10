/**
 * Tools the conductor-goals Claude Code plugin uses to drive goal runs: the
 * scheduler pass, the overview, human decisions from the Goals pane, and run
 * bookkeeping. The plugin refuses the human-only ones when a model calls them
 * (see plugins/conductor-goals/hooks/guard.ts); agents use the goal tools.
 */
import {
  schedulerPass, releaseLease, overviewWithEtag, decideItem, failRun, attachAgent, guardToolCallForRun,
  getGoal, getRun, getOpenGoalRun, updateGoal, touchPlan, createGoal, getMemory, deleteMemory,
  setSchedule, getSchedule, nextScheduledRun, queueRun, applyGoalChanges, reportRunEnd, deleteGoal,
} from '../db.js'
import {
  GoalsTickSchema, GoalsOverviewSchema, DecideItemSchema, CancelRunSchema, SetGoalStatusSchema, AttachAgentSchema,
  FailRunSchema, GuardCheckSchema, CreateGoalSchema, DeleteMemorySchema, SetScheduleSchema, UpdateGoalSchema, ReportRunEndSchema, DeleteGoalSchema,
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
  const { body, etag } = overviewWithEtag(input.detail ?? 'all')
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
  if (input.one_off && input.schedule) throw new Error('A one-off goal has no schedule.')
  const now = new Date().toISOString()
  const id = `plan_${nanoid(10)}`
  createGoal(
    { id, name: input.name, description: input.objective, status: 'active', working_dir: input.working_dir, created_at: now, updated_at: now },
    { objective: input.objective, instructions: input.instructions ?? '', autonomy: input.autonomy ?? {}, one_off: input.one_off ?? false },
  )
  if (input.tool_map && Object.keys(input.tool_map).length) applyGoalChanges(id, { tool_map: input.tool_map })
  record(id, id, 'plan_created', { kind: 'goal', one_off: input.one_off ?? false }, human)
  const applied = input.schedule ? applySchedule(id, input.schedule) : { schedule: null, next_run_at: null }
  // A one-off runs straight away; a new interval is due now (the next tick starts it)
  const queued = input.one_off ? queueRun(id) : null
  return { id, ...applied, one_off: input.one_off ?? false, queued_run: queued ? queued.id : null }
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
  if (input.one_off && input.schedule) throw new Error('A one-off goal has no schedule.')
  const applied = applySchedule(input.goal_id, input.schedule)
  // A schedule makes a goal recurring; "one-off" (with no schedule) makes it run once
  const one_off = Boolean(input.one_off && !input.schedule)
  updateGoal(input.goal_id, { one_off })
  record(input.goal_id, input.goal_id, 'goal_updated', { schedule: applied.schedule, one_off }, human)
  touchPlan(input.goal_id)
  return { goal_id: input.goal_id, ...applied, one_off }
}

/** Sets the schedule and when the next run is due: now for an interval, the next match for cron, none without one. */
function applySchedule(goalId: string, schedule: Parameters<typeof setSchedule>[1]) {
  setSchedule(goalId, schedule) // throws on a cron expression that never matches
  const s = getSchedule(goalId)
  const next_run_at = !s ? null : s.kind === 'interval' ? new Date().toISOString() : nextScheduledRun(goalId)
  updateGoal(goalId, { next_run_at })
  return { schedule: s, next_run_at }
}

/** Changes a goal's settings, once the person has confirmed them (the conductor-goals plugin asks). */
export async function update_goal(args: unknown) {
  const { goal_id, ...changes } = UpdateGoalSchema.parse(args)
  if (!getGoal(goal_id)) throw new Error(`Goal ${goal_id} not found.`)
  const changed = applyGoalChanges(goal_id, changes)
  if (changed.length) record(goal_id, goal_id, 'goal_updated', { changes: changed }, human)
  touchPlan(goal_id)
  return { goal_id, changed }
}

/** A run's agent finished a turn (reported by the guard plugin): skips a run that hit the usage limit and holds goal runs. */
export async function report_run_end(args: unknown) {
  const input = ReportRunEndSchema.parse(args)
  const run = getRun(input.run_id)
  const r = reportRunEnd(input.run_id, { answer: input.answer, reason: input.reason, usage: input.usage })
  if (run && r.outcome !== 'unchanged') {
    record(run.plan_id, run.plan_id, r.outcome === 'held' ? 'run_skipped' : 'agent_failed', { run_id: run.id, ...(r.hold && { hold_until: r.hold.until }), reason: input.answer.slice(0, 200) }, { via: 'plugin' })
  }
  return r
}

/** Deletes a goal for good, for the person (the plugin confirms first). */
export async function delete_goal(args: unknown) {
  const { goal_id } = DeleteGoalSchema.parse(args)
  return { deleted: goal_id, ...deleteGoal(goal_id) }
}
