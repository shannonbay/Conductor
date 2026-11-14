/**
 * Tools the quarterdeck-goals Claude Code plugin uses to drive goal runs: the
 * scheduler pass, the overview, human decisions from the Goals pane, and run
 * bookkeeping. The plugin refuses the human-only ones when a model calls them
 * (see plugins/quarterdeck-goals/hooks/guard.ts); agents use the goal tools.
 */
import {
  schedulerPass, releaseLease, overviewWithEtag, decideItem, failRun, attachAgent, guardToolCallForRun,
  getGoal, getRun, getOpenGoalRun, updateGoal, touchPlan, createGoal, getMemory, deleteMemory, updateMemory,
  setSchedule, getSchedule, nextScheduledRun, queueRun, applyGoalChanges, reportRunEnd, reportRunProgress, deleteGoal,
  listWatches, checkCommandWatch, getTask, getWatch, reportToolWatch, queueForWatchEvents, reviveIfDone,
} from '../db.js'
import {
  GoalsTickSchema, GoalsOverviewSchema, DecideItemSchema, CancelRunSchema, SetGoalStatusSchema, AttachAgentSchema,
  FailRunSchema, GuardCheckSchema, CreateGoalSchema, DeleteMemorySchema, TrustMemorySchema, SetScheduleSchema, UpdateGoalSchema, ReportRunEndSchema, DeleteGoalSchema, WatchReportSchema,
  RunProgressSchema, GetItemSchema,
} from '../schema.js'
import { normalizeModel, type GoalChanges } from '@quarterdeck/core'
import { existsSync } from 'fs'
import { nanoid } from 'nanoid'
import { record } from '../history.js'
import { standingSessionId } from '../runner-session.js'
import { availableUpdate, type AvailableUpdate } from '../update-check.js'

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
    toolWatches: input.tool_watches,
  })
  for (const run of pass.claimed) {
    record(run.goal_id, run.goal_id, 'agent_started', { run_id: run.run_id, trigger: run.trigger, holder: input.holder }, { via: 'plugin' })
  }
  return pass
}

export async function goals_overview(args: unknown) {
  const input = GoalsOverviewSchema.parse(args)
  const { body, etag } = overviewWithEtag(input.detail ?? 'all', standingSessionId())
  return overviewAnswer(input.etag, body, etag, availableUpdate())
}

/** The overview's answer; a published update is part of it, so the etag changes when one appears. */
export function overviewAnswer(asked: string | undefined, body: string, etag: string, update: AvailableUpdate | null) {
  const tag = update ? `${etag}+update-${update.latest}` : etag
  if (asked === tag) return { changed: false, etag: tag }
  return { changed: true, etag: tag, ...JSON.parse(body) as object, ...(update ? { update } : {}) }
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

/**
 * One goal item's full text (its title, notes and proposed action's summary),
 * which the overview clips: the pane fetches it when the person expands a
 * long question or proposal. The action's params stay on the goal page.
 */
export async function get_item(args: unknown) {
  const input = GetItemSchema.parse(args)
  if (!getGoal(input.goal_id)) throw new Error(`Goal ${input.goal_id} not found.`)
  const t = getTask(input.goal_id, input.item_id)
  if (!t || t.archived_at) throw new Error(`Item ${input.item_id} not found in this goal.`)
  const action = (t.state as { action?: { category?: string; summary?: string } } | null)?.action
  return {
    id: t.id,
    goal: t.goal,
    notes: t.notes,
    action: action && typeof action.summary === 'string' ? { category: action.category ?? null, summary: action.summary } : null,
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
  return guardToolCallForRun(input.run_id, input.tool_name, input.input)
}

export async function create_goal(args: unknown) {
  const input = CreateGoalSchema.parse(args)
  if (!existsSync(input.working_dir)) throw new Error(`Working directory not found: ${input.working_dir}`)
  if (input.one_off && input.schedule) throw new Error('A one-off goal has no schedule.')
  const now = new Date().toISOString()
  const id = `plan_${nanoid(10)}`
  createGoal(
    { id, name: input.name, description: input.objective, status: 'active', working_dir: input.working_dir, created_at: now, updated_at: now },
    { objective: input.objective, instructions: input.instructions ?? '', autonomy: input.autonomy ?? {}, one_off: input.one_off ?? false, model: normalizeModel(input.model) },
  )
  if (input.tool_map && Object.keys(input.tool_map).length) applyGoalChanges(id, { tool_map: input.tool_map })
  if (input.watches && Object.keys(input.watches).length) applyGoalChanges(id, { watches: input.watches as GoalChanges['watches'] })
  record(id, id, 'plan_created', { kind: 'goal', one_off: input.one_off ?? false }, human)
  const applied = input.schedule ? applySchedule(id, input.schedule) : { schedule: null, next_run_at: null }
  // A one-off runs straight away; a new interval is due now (the next tick starts it)
  const queued = input.one_off ? queueRun(id) : null
  const watches = await firstChecks(id)
  return { id, ...applied, one_off: input.one_off ?? false, model: getGoal(id)?.model ?? null, queued_run: queued ? queued.id : null, ...(watches.length ? { watches } : {}) }
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
 * The person trusts a memory a run wrote after reading untrusted content: briefs
 * that hand it out stop marking their runs.
 */
export async function trust_memory(args: unknown) {
  const input = TrustMemorySchema.parse(args)
  const m = getMemory(input.memory_id)
  if (!m || m.plan_id !== input.goal_id) throw new Error(`Memory ${input.memory_id} not found in this goal.`)
  if (m.untrusted_source) {
    updateMemory(m.id, { untrusted_source: null })
    record(input.goal_id, input.goal_id, 'memory_trusted', { memory_id: m.id, text: m.text, was: m.untrusted_source }, human)
  }
  return { trusted: m.id }
}

/**
 * Replaces a goal's schedule (null: on demand only). As the web app does, a
 * new schedule makes the next run due: now for an interval, the next match for cron.
 */
export async function set_schedule(args: unknown) {
  const input = SetScheduleSchema.parse(args)
  if (!getGoal(input.goal_id)) throw new Error(`Goal ${input.goal_id} not found.`)
  if (input.one_off && input.schedule) throw new Error('A one-off goal has no schedule.')
  // A done one-off is only listed while it is one: bring it back first, or clearing
  // one_off below would leave a retired goal no list or tool can reach
  const revived = reviveIfDone(input.goal_id)
  const applied = applySchedule(input.goal_id, input.schedule)
  // A schedule makes a goal recurring; "one-off" (with no schedule) makes it run once
  const one_off = Boolean(input.one_off && !input.schedule)
  updateGoal(input.goal_id, { one_off })
  record(input.goal_id, input.goal_id, 'goal_updated', { schedule: applied.schedule, one_off, ...(revived && { revived }) }, human)
  touchPlan(input.goal_id)
  return { goal_id: input.goal_id, ...applied, one_off, ...(revived && { revived }) }
}

/** Sets the schedule and when the next run is due: now for an interval, the next match for cron, none without one. */
function applySchedule(goalId: string, schedule: Parameters<typeof setSchedule>[1]) {
  setSchedule(goalId, schedule) // throws on a cron expression that never matches
  const s = getSchedule(goalId)
  const next_run_at = !s ? null : s.kind === 'interval' ? new Date().toISOString() : nextScheduledRun(goalId)
  updateGoal(goalId, { next_run_at })
  return { schedule: s, next_run_at }
}

/** Changes a goal's settings, once the person has confirmed them (the quarterdeck-goals plugin asks). */
export async function update_goal(args: unknown) {
  const { goal_id, ...changes } = UpdateGoalSchema.parse(args)
  if (!getGoal(goal_id)) throw new Error(`Goal ${goal_id} not found.`)
  // The schema has checked each watch is a command or a tool
  const changed = applyGoalChanges(goal_id, changes as GoalChanges)
  if (changed.length) record(goal_id, goal_id, 'goal_updated', { changes: changed }, human)
  const watches = await firstChecks(goal_id)
  touchPlan(goal_id)
  return { goal_id, changed, ...(watches.length ? { watches } : {}) }
}

/**
 * Checks each watch that has never been checked (new, or with a new command),
 * so whoever set it up learns at once whether the command works. That check
 * is its baseline: it starts no run.
 */
async function firstChecks(goalId: string): Promise<{ name: string; result: string }[]> {
  const results: { name: string; result: string }[] = []
  for (const w of listWatches(goalId)) {
    if (w.last_checked_at !== null) continue
    if (w.kind === 'tool') {
      // Only a Claude Code session can call a connector: the one running goals makes the first call at its next pass
      results.push({ name: w.name, result: `set; the session running goals calls ${w.tool} within a minute, and goal_detail says if that fails` })
      continue
    }
    const r = await checkCommandWatch(w.id)
    results.push({
      name: w.name,
      result: r.error
        ? `the command failed (${r.error}); it is tried again every ${w.every_minutes} min`
        : `works: ${r.lines} ${r.lines === 1 ? 'item' : 'items'} there now; a run starts when a new one appears`,
    })
  }
  return results
}

/**
 * What a tool watch's call answered (the plugin made the call). Something new
 * queues a run at once, for the caller's next pass to start.
 */
export async function watch_report(args: unknown) {
  const input = WatchReportSchema.parse(args)
  const watch = getWatch(input.watch_id)
  if (!watch) throw new Error(`Watch ${input.watch_id} not found.`)
  const r = reportToolWatch(watch.id, input.error !== undefined ? { error: input.error } : { text: input.text ?? '' })
  const goal = getGoal(watch.plan_id)
  const queued = r.fresh.length && goal?.status === 'active' ? queueForWatchEvents(watch.plan_id) : null
  return { watch_id: watch.id, baseline: r.baseline, lines: r.lines, new: r.fresh.length, ...(r.error && { error: r.error }), queued_run: queued ? queued.id : null }
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

/**
 * What a run's agent is doing (reported by the guard plugin): its latest tool
 * call, and a call waiting for the person's permission answer. The Goals pane shows it.
 */
export async function run_progress(args: unknown) {
  const { run_id, event, label } = RunProgressSchema.parse(args)
  return reportRunProgress(run_id, { event, tool: label })
}

/** Deletes a goal for good, for the person (the plugin confirms first). */
export async function delete_goal(args: unknown) {
  const { goal_id } = DeleteGoalSchema.parse(args)
  return { deleted: goal_id, ...deleteGoal(goal_id) }
}
