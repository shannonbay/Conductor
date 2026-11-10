/**
 * The goal scheduler's pass, run by whoever drives goals (the quarterdeck-goals
 * Claude Code plugin through the `goals_tick` MCP tool, or the web app with
 * QUARTERDECK_WEB_RUNS=1). It decides which runs are due, claims them, and
 * returns them; the caller starts an agent for each.
 *
 * Several Claude Code sessions may run the plugin at once, so a pass first
 * takes a lease: only the lease holder runs health checks and claims runs.
 */
import type { Database } from './sqlite.js'
import { getTask, updateTask } from './queries.js'
import { approveTask, isProposal, rejectTask, asksPerson } from './gates.js'
import { getGoal, getOpenRun, getRun, listGoals, updateGoal, updateRun, insertRun, insertMemory } from './goals.js'
import { archiveResolved, decideTick, failRun, nextIntervalRun, queueRun, recordSkip, GoalError } from './goal-engine.js'
import { healthDue, runHealthCheck } from './health.js'
import type { GoalRun, Task } from './types.js'
import { getRunHold, type RunHold } from './goal-changes.js'
import { schemaOutdated } from './migrate.js'

const LEASE_NAME = 'goals'
/** A holder that misses this long (several 30 s ticks) loses the lease to the next session that asks. */
export const LEASE_MS = 90_000
/** Grace beyond a goal's max_run_minutes before a run nobody finished is marked timed out. */
export const STALE_GRACE_MS = 5 * 60_000
/** Runs a pass starts at once across all goals; more wait for the next pass. */
export const DEFAULT_MAX_CONCURRENT = 3

// ── Lease ─────────────────────────────────────────────────────────────────────

/** Takes or renews the scheduler lease. True if `holder` holds it now. */
export function takeLease(db: Database, holder: string, now: Date = new Date()): boolean {
  db.prepare(`
    INSERT INTO scheduler_lease (name, holder, expires_at) VALUES (?, ?, ?)
    ON CONFLICT(name) DO UPDATE SET holder = excluded.holder, expires_at = excluded.expires_at
    WHERE scheduler_lease.holder = excluded.holder OR scheduler_lease.expires_at <= ?
  `).run(LEASE_NAME, holder, new Date(now.getTime() + LEASE_MS).toISOString(), now.toISOString())
  const row = db.prepare('SELECT holder FROM scheduler_lease WHERE name = ?').get(LEASE_NAME) as { holder: string }
  return row.holder === holder
}

/** Gives the lease up (a session ending), so another session takes over at once. */
export function releaseLease(db: Database, holder: string): void {
  db.prepare('DELETE FROM scheduler_lease WHERE name = ? AND holder = ?').run(LEASE_NAME, holder)
}

/** The session scheduling goal runs now, or null when nobody holds a live lease. */
export function leaseHolder(db: Database, now: Date = new Date()): string | null {
  const row = db.prepare('SELECT holder FROM scheduler_lease WHERE name = ? AND expires_at > ?').get(LEASE_NAME, now.toISOString()) as { holder: string } | undefined
  return row?.holder ?? null
}

// ── Claiming runs ─────────────────────────────────────────────────────────────

/** A run the caller should start an agent for. */
export interface ClaimedRun {
  run_id: string
  goal_id: string
  name: string
  working_dir: string
  trigger: GoalRun['trigger']
  max_run_minutes: number
  /** The agent's task: read the brief, work, end_run. */
  prompt: string
}

/** The instructions a goal run's agent starts with. */
export function goalRunPrompt(p: { goalId: string; runId: string; name: string; workingDir: string; maxRunMinutes: number }): string {
  return [
    `Run persistent goal "${p.name}" (goal ID: ${p.goalId}, run ID: ${p.runId}). Working directory: ${p.workingDir}.`,
    `You start with no memory of earlier runs: call get_goal_brief with goal_id "${p.goalId}" and run_id "${p.runId}" first. It has the objective, standing instructions, memory, human decisions since the last run, open items and recent run summaries.`,
    'Then: carry out approved actions first and complete those items; revise rejected ones using the feedback (update the proposal\'s state.action with update_task, then set_status completed to send it for review again) or abandon them; look for new work and add each piece with add_item (always with external_ref for outside things); stay within each action category\'s autonomy (auto: do it, then record it; propose: add_item and wait for approval; off: never). A tool call refused by the Quarterdeck goal guard means: propose it with add_item instead.',
    'When you need something only the person can give or do (a choice, details you can\'t find, connecting a service, allowing a site), add_item with ask_person: true and one clear question, and carry on with what you can; don\'t guess. Their answer arrives as memory and the item is completed.',
    'Save anything future runs should know with remember.',
    'Your summary, items and memory are read by the person who owns this goal: write to them as "you", and never guess their gender or pronouns.',
    `You have about ${p.maxRunMinutes} minutes; leave the rest for the next run. Don't wait on long background commands. Finish with end_run and a short summary: that summary is your report, so your final message can be one line.`,
  ].join('\n\n')
}

/** Moves a queued run (or a new one) to running for `holder`. Null if another holder got it first. */
export function claimRun(db: Database, planId: string, opts: { holder: string; queuedRunId?: string; trigger?: GoalRun['trigger']; now?: Date }): ClaimedRun | null {
  const now = (opts.now ?? new Date()).toISOString()
  const claim = db.transaction((): GoalRun | null => {
    const run = opts.queuedRunId ? getRun(db, opts.queuedRunId) : insertRun(db, planId, opts.trigger ?? 'manual', 'queued')
    if (!run) return null
    const changed = db.prepare("UPDATE goal_runs SET status = 'running', holder = ?, started_at = ? WHERE id = ? AND status = 'queued'")
      .run(opts.holder, now, run.id).changes
    if (!changed) return null
    updateGoal(db, planId, { last_run_at: now })
    return getRun(db, run.id)!
  })
  const run = claim()
  if (!run) return null
  const goal = getGoal(db, planId)!
  const plan = listGoals(db).find((g) => g.plan.id === planId)!.plan
  return {
    run_id: run.id,
    goal_id: planId,
    name: plan.name,
    working_dir: plan.working_dir,
    trigger: run.trigger,
    max_run_minutes: goal.limits.max_run_minutes,
    prompt: goalRunPrompt({ goalId: planId, runId: run.id, name: plan.name, workingDir: plan.working_dir, maxRunMinutes: goal.limits.max_run_minutes }),
  }
}

/** Records which subagent is doing a run. */
export function attachAgent(db: Database, runId: string, agentId: string): void {
  updateRun(db, runId, { agent_id: agentId })
}

/** Runs still marked running well past their goal's limit: their agent is gone. Returns their ids. */
export function expireStaleRuns(db: Database, now: Date = new Date(), opts: { skipRunIds?: Set<string> } = {}): string[] {
  const rows = db.prepare(`
    SELECT r.id, r.started_at, g.limits FROM goal_runs r JOIN goals g ON g.plan_id = r.plan_id WHERE r.status = 'running'
  `).all() as { id: string; started_at: string; limits: string }[]
  const expired: string[] = []
  for (const r of rows) {
    if (opts.skipRunIds?.has(r.id)) continue
    const maxMinutes = (JSON.parse(r.limits || '{}') as { max_run_minutes?: number }).max_run_minutes ?? 15
    if (now.getTime() - new Date(r.started_at).getTime() > maxMinutes * 60_000 + STALE_GRACE_MS) {
      failRun(db, r.id, 'timed_out', 'Run did not finish (Claude Code closed or the agent stopped responding)')
      expired.push(r.id)
    }
  }
  return expired
}

// ── Health ────────────────────────────────────────────────────────────────────

/** Runs a goal's health check; when it fails and the goal says so, queues a run (trigger 'health'). */
export async function checkHealth(db: Database, planId: string): Promise<{ passed: boolean; queuedRun: boolean }> {
  const result = await runHealthCheck(db, planId)
  const goal = getGoal(db, planId)
  let queuedRun = false
  if (!result.passed && goal?.health_triggers_run && goal.status === 'active' && !getOpenRun(db, planId)) {
    queueRun(db, planId, 'health')
    queuedRun = true
  }
  return { passed: result.passed, queuedRun }
}

// ── The pass ──────────────────────────────────────────────────────────────────

export interface PassResult {
  /** False when another session holds the lease; nothing else was done. */
  leader: boolean
  /** Runs claimed for the caller to start. */
  claimed: ClaimedRun[]
  /** Runs marked timed out because nobody finished them. */
  expired: string[]
  /** Set while goal runs are held (the usage limit is reached): nothing was claimed. */
  hold?: RunHold
  /** Set when a newer Quarterdeck in another session has upgraded the database: this one schedules nothing. */
  outdated?: true
}

export interface PassOptions {
  holder: string
  now?: Date
  /** Most runs going at once across all goals (default 3). */
  maxConcurrent?: number
  /** Runs the caller is tracking itself, never expired here. */
  trackedRunIds?: Set<string>
  /** Starts runs regardless of the lease (the web app, which is the only scheduler when it runs). */
  ignoreLease?: boolean
}

/** One scheduler pass: lease, stale runs, health checks, then claim every due run. */
export async function schedulerPass(db: Database, opts: PassOptions): Promise<PassResult> {
  const now = opts.now ?? new Date()
  // Older code leaves scheduling to the session that upgraded the database
  if (schemaOutdated(db)) return { leader: false, claimed: [], expired: [], outdated: true }
  if (!opts.ignoreLease && !takeLease(db, opts.holder, now)) return { leader: false, claimed: [], expired: [] }

  const expired = expireStaleRuns(db, now, { skipRunIds: opts.trackedRunIds })
  const goals = listGoals(db, 'active')

  // Health checks first: a failing check can queue a run that starts in this same pass
  for (const { goal } of goals) {
    if (!healthDue(goal, now)) continue
    await checkHealth(db, goal.plan_id).catch(() => { /* a broken command is recorded as a failed check */ })
  }

  // While the person's usage limit is reached, due runs wait (they stay due) until the reset
  const hold = getRunHold(db, now)
  if (hold) return { leader: true, claimed: [], expired, hold }

  let running = (db.prepare("SELECT COUNT(*) n FROM goal_runs WHERE status = 'running'").get() as { n: number }).n
  const max = opts.maxConcurrent ?? DEFAULT_MAX_CONCURRENT
  const claimed: ClaimedRun[] = []
  for (const { plan } of goals) {
    archiveResolved(db, plan.id, now)
    const decision = decideTick(db, plan.id, now)
    if (decision.action === 'none') continue
    if (decision.action === 'defer') {
      updateGoal(db, plan.id, { next_run_at: decision.next_run_at })
      continue
    }
    if (decision.action === 'skip') {
      if (decision.queuedRunId) {
        updateRun(db, decision.queuedRunId, { status: 'skipped', skip_reason: decision.reason, ended_at: now.toISOString() })
      } else {
        recordSkip(db, plan.id, decision.trigger, decision.reason, now)
      }
      updateGoal(db, plan.id, { next_run_at: nextIntervalRun(db, plan.id, now) })
      continue
    }
    if (running >= max) continue // stays due; the next pass picks it up
    const run = claimRun(db, plan.id, { holder: opts.holder, queuedRunId: decision.queuedRunId, trigger: decision.trigger, now })
    if (run) {
      claimed.push(run)
      running++
    }
    if (decision.trigger === 'interval' || decision.trigger === 'cron') updateGoal(db, plan.id, { next_run_at: nextIntervalRun(db, plan.id, now) })
  }
  return { leader: true, claimed, expired }
}

// ── Human decisions ───────────────────────────────────────────────────────────

/**
 * A human approves or rejects an item waiting for review. Approving a goal
 * proposal queues a run to carry it out (when the goal is active); rejecting
 * one saves the feedback as goal memory (in rejectTask).
 */
export function decideItem(
  db: Database, planId: string, taskId: string, input: { decision: 'approve' | 'reject' | 'answer'; feedback?: string },
): { task: Task; queuedRun: GoalRun | null } {
  const task = getTask(db, planId, taskId)
  if (!task) throw new GoalError(`Item ${taskId} not found.`)
  let queuedRun: GoalRun | null = null
  const active = () => getGoal(db, planId)?.status === 'active'
  if (input.decision === 'answer') {
    // The person's answer to a question a run asked: saved to the item and the
    // goal's memory, and a run is queued to carry on with it
    const answer = (input.feedback ?? '').trim()
    if (!answer) throw new GoalError('An answer is needed.')
    if (!asksPerson(task)) throw new GoalError(`Item ${taskId} isn't a question for you; approve or reject it instead.`)
    approveTask(db, planId, taskId)
    updateTask(db, planId, taskId, { result: `Your answer: ${answer}`, updated_at: new Date().toISOString() })
    insertMemory(db, { plan_id: planId, kind: 'fact', text: `You answered "${task.goal}": ${answer}`, source: 'human', source_ref: taskId })
    if (active()) queuedRun = queueRun(db, planId)
  } else if (input.decision === 'approve') {
    approveTask(db, planId, taskId)
    // An approved proposal is carried out by a run; a done request lets the run carry on
    if ((isProposal(task) || asksPerson(task)) && active()) queuedRun = queueRun(db, planId)
  } else {
    rejectTask(db, planId, taskId, input.feedback ?? '')
    // A one-off has no schedule to bring the next run: queue one to revise or drop the proposal
    const goal = getGoal(db, planId)
    if (isProposal(task) && goal?.one_off && goal.status === 'active') queuedRun = queueRun(db, planId)
  }
  return { task: getTask(db, planId, taskId)!, queuedRun }
}

/** A done one-off goes back to active, so it can run again. True if it was done. */
export function reviveIfDone(db: Database, planId: string): boolean {
  const goal = getGoal(db, planId)
  if (!goal?.one_off || goal.status !== 'retired') return false
  updateGoal(db, planId, { status: 'active' })
  return true
}
