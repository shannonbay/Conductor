/**
 * Goal guard: decides whether a tool call made during a goal run is allowed,
 * by mapping the tool to an action category (goal.tool_map) and applying the
 * goal's autonomy. Called through the MCP tool guard_check by the
 * quarterdeck-guard plugin, which knows which subagent does which run.
 *
 *   off     → denied
 *   auto    → allowed
 *   propose → allowed while an approved proposal for that category is being
 *             carried out: as many calls as the action needs (trashing a
 *             sender's 40 threads, the clicks of an unsubscribe page), until
 *             the run marks the item done. Every call is still recorded.
 *
 * Calls outside goal runs, or to tools not in the map, are always allowed.
 */
import type { Database } from 'better-sqlite3'
import { autonomyFor } from './goal-engine.js'
import { getGoal, newId } from './goals.js'
import type { GoalRun, ToolCallRecord } from './types.js'

export type GuardDecision =
  | { decision: 'allow'; category?: string; run_id?: string }
  | { decision: 'deny'; category: string; run_id: string; reason: string }

/** Matches a tool name against "exact" or glob ("mcp__gmail__send*") patterns; exact patterns win. */
export function matchToolCategory(toolMap: Record<string, string>, toolName: string): string | null {
  if (toolMap[toolName]) return toolMap[toolName]
  const globs = Object.entries(toolMap)
    .filter(([p]) => p.includes('*'))
    .sort(([a], [b]) => b.length - a.length) // most specific first
  for (const [pattern, category] of globs) {
    const re = new RegExp('^' + pattern.split('*').map((s) => s.replace(/[.+?^${}()|[\]\\]/g, '\\$&')).join('.*') + '$')
    if (re.test(toolName)) return category
  }
  return null
}

function record(db: Database, run: GoalRun, toolName: string, category: string, decision: 'allow' | 'deny', reason: string | null): void {
  db.prepare(`
    INSERT INTO goal_tool_calls (id, plan_id, run_id, tool_name, category, decision, reason, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run(newId('tc'), run.plan_id, run.id, toolName, category, decision, reason, new Date().toISOString())
}

/** Guard for a call made by a goal run's agent, by the run's id. */
export function guardToolCallForRun(db: Database, runId: string, toolName: string): GuardDecision {
  const run = db.prepare("SELECT * FROM goal_runs WHERE id = ? AND status IN ('queued', 'running')").get(runId) as GoalRun | undefined
  return run ? guardRun(db, run, toolName) : { decision: 'allow' }
}

function guardRun(db: Database, run: GoalRun, toolName: string): GuardDecision {
  const goal = getGoal(db, run.plan_id)
  if (!goal) return { decision: 'allow' }
  const category = matchToolCategory(goal.tool_map, toolName)
  if (!category) return { decision: 'allow', run_id: run.id }

  const mode = autonomyFor(goal, category)
  if (mode === 'auto') {
    record(db, run, toolName, category, 'allow', null)
    return { decision: 'allow', category, run_id: run.id }
  }
  if (mode === 'off') {
    const reason = `Quarterdeck goal guard: "${category}" is off for this goal, so ${toolName} is not allowed. Don't take or propose this action.`
    record(db, run, toolName, category, 'deny', reason)
    return { decision: 'deny', category, run_id: run.id, reason }
  }

  // propose: allowed while an approved proposal for this category is still being carried out
  // (active and not done). One action can take many calls; completing the item ends it.
  const approved = (db.prepare(`
    SELECT COUNT(*) AS n FROM tasks
    WHERE plan_id = ? AND status = 'active' AND archived_at IS NULL AND approved_at IS NOT NULL
      AND json_extract(state, '$.action.category') = ?
  `).get(run.plan_id, category) as { n: number }).n
  if (approved > 0) {
    record(db, run, toolName, category, 'allow', null)
    return { decision: 'allow', category, run_id: run.id }
  }
  const reason = `Quarterdeck goal guard: "${category}" needs approval first. Propose it with add_item (action.category "${category}") and wait until it shows approved_to_execute; once approved, carry it out and then complete the item.`
  record(db, run, toolName, category, 'deny', reason)
  return { decision: 'deny', category, run_id: run.id, reason }
}

export function listToolCalls(db: Database, planId: string, limit = 50): ToolCallRecord[] {
  return db.prepare('SELECT * FROM goal_tool_calls WHERE plan_id = ? ORDER BY created_at DESC, rowid DESC LIMIT ?')
    .all(planId, limit) as ToolCallRecord[]
}
