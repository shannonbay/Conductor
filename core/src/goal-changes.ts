/**
 * Changing a goal from the conversation (the update_goal tool, which asks the
 * person to confirm first), and holding all goal runs while the person's
 * usage limit is reached.
 */
import type { Database } from './sqlite.js'
import { getPlan, updatePlan } from './queries.js'
import { getGoal, getMemory, getRun, insertMemory, updateGoal, updateMemory, updateRun } from './goals.js'
import { failRun, GoalError } from './goal-engine.js'
import type { AutonomyMode, MemoryKind } from './types.js'

// ── Goal changes ──────────────────────────────────────────────────────────────

export interface GoalChanges {
  name?: string
  objective?: string
  instructions?: string
  /** Category → mode; null removes the category (it falls back to "propose"). */
  autonomy?: Record<string, AutonomyMode | null>
  /** Tool name pattern → category; null removes the rule. */
  tool_map?: Record<string, string | null>
  add_memory?: { kind: MemoryKind; text: string; pinned?: boolean }[]
  /** Memory ids to deactivate. */
  forget_memory?: string[]
  status?: 'active' | 'paused'
}

const MODES = new Set(['off', 'propose', 'auto'])

/** Applies a set of changes the person confirmed. Returns one line per change made. */
export function applyGoalChanges(db: Database, planId: string, changes: GoalChanges): string[] {
  const goal = getGoal(db, planId)
  const plan = getPlan(db, planId)
  if (!goal || !plan) throw new GoalError(`Goal ${planId} not found.`)
  for (const [category, mode] of Object.entries(changes.autonomy ?? {})) {
    if (mode !== null && !MODES.has(mode)) throw new GoalError(`"${mode}" isn't a mode for ${category}: use off, propose or auto.`)
  }
  for (const id of changes.forget_memory ?? []) {
    if (getMemory(db, id)?.plan_id !== planId) throw new GoalError(`Memory ${id} isn't this goal's.`)
  }

  const done: string[] = []
  db.transaction(() => {
    if (changes.name?.trim() && changes.name.trim() !== plan.name) {
      updatePlan(db, planId, { name: changes.name.trim(), updated_at: new Date().toISOString() })
      done.push(`renamed to "${changes.name.trim()}"`)
    }
    if (changes.objective?.trim() && changes.objective.trim() !== goal.objective) {
      updateGoal(db, planId, { objective: changes.objective.trim() })
      updatePlan(db, planId, { description: changes.objective.trim() })
      done.push('objective changed')
    }
    if (changes.instructions !== undefined && changes.instructions !== goal.instructions) {
      updateGoal(db, planId, { instructions: changes.instructions })
      done.push(changes.instructions.trim() ? 'instructions changed' : 'instructions cleared')
    }
    if (changes.autonomy && Object.keys(changes.autonomy).length) {
      const autonomy = { ...goal.autonomy }
      for (const [category, mode] of Object.entries(changes.autonomy)) {
        if (mode === null) delete autonomy[category]
        else autonomy[category] = mode
        done.push(mode === null ? `${category}: back to propose` : `${category}: ${mode}`)
      }
      updateGoal(db, planId, { autonomy })
    }
    if (changes.tool_map && Object.keys(changes.tool_map).length) {
      const toolMap = { ...goal.tool_map }
      for (const [pattern, category] of Object.entries(changes.tool_map)) {
        if (category === null) delete toolMap[pattern]
        else toolMap[pattern] = category
        done.push(category === null ? `tool rule ${pattern} removed` : `tool rule ${pattern} → ${category}`)
      }
      updateGoal(db, planId, { tool_map: toolMap })
    }
    for (const m of changes.add_memory ?? []) {
      insertMemory(db, { plan_id: planId, kind: m.kind, text: m.text, source: 'human', pinned: m.pinned ?? false })
      done.push(`remembered (${m.kind}): ${m.text}`)
    }
    for (const id of changes.forget_memory ?? []) {
      updateMemory(db, id, { active: false })
      done.push(`forgot memory ${id}`)
    }
    if (changes.status && changes.status !== goal.status) {
      if (goal.status === 'retired') throw new GoalError('This goal is done; run it again first.')
      updateGoal(db, planId, { status: changes.status })
      done.push(changes.status === 'paused' ? 'paused' : 'resumed')
    }
  })()
  return done
}

// ── Holding runs while the usage limit is reached ─────────────────────────────

export interface RunHold {
  until: string
  reason: string
}

/** The hold on all goal runs, if one is still in force (an expired one is cleared). */
export function getRunHold(db: Database, now: Date = new Date()): RunHold | null {
  const row = db.prepare('SELECT until, reason FROM goal_run_hold WHERE id = 1').get() as RunHold | undefined
  if (!row) return null
  if (row.until <= now.toISOString()) {
    db.prepare('DELETE FROM goal_run_hold WHERE id = 1').run()
    return null
  }
  return row
}

export function setRunHold(db: Database, hold: RunHold): void {
  db.prepare('INSERT INTO goal_run_hold (id, until, reason) VALUES (1, ?, ?) ON CONFLICT(id) DO UPDATE SET until = excluded.until, reason = excluded.reason')
    .run(hold.until, hold.reason)
}

export function clearRunHold(db: Database): void {
  db.prepare('DELETE FROM goal_run_hold WHERE id = 1').run()
}

const LIMIT = /(hit|reached) (your|the) .{0,30}limit|usage limit|rate limit|out of (credits|usage)/i
/** When the limit is lifted and the message doesn't say, try again after this long. */
export const DEFAULT_HOLD_MS = 30 * 60_000

/** Whether an agent's message says the person's usage limit is reached. */
export function isUsageLimit(text: string): boolean {
  return LIMIT.test(text)
}

/** "resets 8:10pm" → the next 8:10pm, local time, after `now`; null if the message names no time. */
export function parseLimitReset(text: string, now: Date = new Date()): Date | null {
  const m = /resets?\s+(?:at\s+)?(\d{1,2})(?::(\d{2}))?\s*(am|pm)?/i.exec(text)
  if (!m) return null
  let hour = Number(m[1])
  const minute = Number(m[2] ?? 0)
  const meridiem = m[3]?.toLowerCase()
  if (hour > 23 || minute > 59 || (meridiem && hour > 12)) return null
  if (meridiem === 'pm' && hour < 12) hour += 12
  if (meridiem === 'am' && hour === 12) hour = 0
  const at = new Date(now)
  at.setHours(hour, minute, 0, 0)
  if (at <= now) at.setDate(at.getDate() + 1)
  return at
}

/**
 * A run's agent finished a turn: if it stopped because the usage limit is
 * reached, the run is skipped (not failed) and all goal runs hold until the
 * reset. If it stopped on another error, the run fails with that message.
 * Otherwise nothing changes (the runner settles the run when its agent ends).
 */
/** A turn's token counts, as Claude Code reports them. */
export type RunUsage = { input_tokens: number; output_tokens: number; cache_read_input_tokens: number; cache_creation_input_tokens: number; model?: string }

/** Adds a turn's tokens to its run (a run's agent may take several turns). */
export function addRunUsage(db: Database, runId: string, usage: RunUsage): void {
  db.prepare(`
    UPDATE goal_runs SET input_tokens = input_tokens + ?, output_tokens = output_tokens + ?,
      cache_read_tokens = cache_read_tokens + ?, cache_write_tokens = cache_write_tokens + ?, model = COALESCE(?, model)
    WHERE id = ?
  `).run(usage.input_tokens || 0, usage.output_tokens || 0, usage.cache_read_input_tokens || 0, usage.cache_creation_input_tokens || 0, usage.model ?? null, runId)
}

export function reportRunEnd(
  db: Database, runId: string, input: { answer: string; reason?: string; usage?: RunUsage }, now: Date = new Date(),
): { outcome: 'held' | 'failed' | 'unchanged'; hold?: RunHold } {
  const run = getRun(db, runId)
  if (!run) return { outcome: 'unchanged' }
  // Tokens count whatever the run's state: its last turn can end after end_run
  if (input.usage) addRunUsage(db, runId, input.usage)
  if (run.status !== 'running') return { outcome: 'unchanged' }
  const answer = input.answer.trim()
  if (isUsageLimit(answer)) {
    const until = (parseLimitReset(answer, now) ?? new Date(now.getTime() + DEFAULT_HOLD_MS)).toISOString()
    const hold = { until, reason: answer.split('\n')[0]!.slice(0, 200) }
    updateRun(db, runId, { status: 'skipped', skip_reason: `usage limit reached: ${hold.reason}`, ended_at: now.toISOString() })
    setRunHold(db, hold)
    return { outcome: 'held', hold }
  }
  if (input.reason === 'error') {
    failRun(db, runId, 'failed', `The agent stopped on an error: ${answer.slice(0, 300) || 'no message'}`)
    return { outcome: 'failed' }
  }
  return { outcome: 'unchanged' }
}
