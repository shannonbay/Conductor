/**
 * Goal health checks: a command that exits 0 while the goal is being met.
 * The last number it prints is stored as a trend value (e.g. unread count).
 */
import type { Database } from './sqlite.js'
import { runVerifyCommand } from './gates.js'
import { getGoal, newId, updateGoal } from './goals.js'
import { getPlan } from './queries.js'
import type { Goal, HealthResult } from './types.js'

export const HEALTH_TIMEOUT_S = 120

/** The last number in the output, e.g. "unread: 42" → 42. */
export function parseHealthValue(output: string): number | null {
  const matches = output.match(/-?\d+(?:\.\d+)?/g)
  return matches ? Number(matches[matches.length - 1]) : null
}

export async function runHealthCheck(db: Database, planId: string): Promise<HealthResult> {
  const goal = getGoal(db, planId)
  const plan = getPlan(db, planId)
  if (!goal || !plan) throw new Error(`Goal ${planId} not found`)
  if (!goal.health_command) throw new Error('This goal has no health check command.')

  const r = await runVerifyCommand(goal.health_command, plan.working_dir, HEALTH_TIMEOUT_S)
  const row: HealthResult = {
    id: newId('hc'),
    plan_id: planId,
    passed: r.passed,
    exit_code: r.exit_code,
    value: parseHealthValue(r.output),
    output: r.output.slice(-2000),
    duration_ms: r.duration_ms,
    created_at: new Date().toISOString(),
  }
  db.prepare(`
    INSERT INTO goal_health (id, plan_id, passed, exit_code, value, output, duration_ms, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run(row.id, row.plan_id, row.passed ? 1 : 0, row.exit_code, row.value, row.output, row.duration_ms, row.created_at)
  updateGoal(db, planId, { last_health_at: row.created_at })
  return row
}

/** Health results, newest first. */
export function listHealth(db: Database, planId: string, limit = 50): HealthResult[] {
  return (db.prepare('SELECT * FROM goal_health WHERE plan_id = ? ORDER BY created_at DESC, rowid DESC LIMIT ?').all(planId, limit) as Record<string, unknown>[])
    .map((r) => ({ ...r, passed: Boolean(r.passed) }) as HealthResult)
}

export function healthDue(goal: Goal, now: Date = new Date()): boolean {
  if (!goal.health_command || goal.status !== 'active') return false
  if (!goal.last_health_at) return true
  return now.getTime() - new Date(goal.last_health_at).getTime() >= goal.health_every_minutes * 60_000
}
