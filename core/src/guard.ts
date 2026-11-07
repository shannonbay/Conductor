/**
 * Goal guard: decides whether a tool call made during a goal run is allowed,
 * by mapping the tool to an action category (goal.tool_map) and applying the
 * goal's autonomy. Called by the goal-guard PreToolUse hook in Claude Code.
 *
 *   off     → denied
 *   auto    → allowed
 *   propose → allowed only while an approved proposal for that category is
 *             waiting to be carried out (one call per approved proposal)
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

/** Ties a Claude Code session to the goal run it is working on (done when the agent calls get_goal_brief). */
export function bindSessionToRun(db: Database, runId: string, ccSessionId: string): boolean {
  return db.prepare("UPDATE goal_runs SET cc_session_id = ? WHERE id = ? AND status IN ('queued', 'running')")
    .run(ccSessionId, runId).changes > 0
}

export function findRunForSession(db: Database, ccSessionId: string): GoalRun | undefined {
  return db.prepare("SELECT * FROM goal_runs WHERE cc_session_id = ? AND status IN ('queued', 'running') ORDER BY started_at DESC LIMIT 1")
    .get(ccSessionId) as GoalRun | undefined
}

function record(db: Database, run: GoalRun, toolName: string, category: string, decision: 'allow' | 'deny', reason: string | null): void {
  db.prepare(`
    INSERT INTO goal_tool_calls (id, plan_id, run_id, tool_name, category, decision, reason, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run(newId('tc'), run.plan_id, run.id, toolName, category, decision, reason, new Date().toISOString())
}

export function guardToolCall(db: Database, ccSessionId: string, toolName: string): GuardDecision {
  const run = findRunForSession(db, ccSessionId)
  if (!run) return { decision: 'allow' }
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
    const reason = `Conductor goal guard: "${category}" is off for this goal, so ${toolName} is not allowed. Don't take or propose this action.`
    record(db, run, toolName, category, 'deny', reason)
    return { decision: 'deny', category, run_id: run.id, reason }
  }

  // propose: one call per approved proposal that is still waiting to be carried out
  const approved = db.prepare(`
    SELECT COUNT(*) AS n, MIN(approved_at) AS since FROM tasks
    WHERE plan_id = ? AND status = 'active' AND archived_at IS NULL AND approved_at IS NOT NULL
      AND json_extract(state, '$.action.category') = ?
  `).get(run.plan_id, category) as { n: number; since: string | null }
  const used = approved.since
    ? (db.prepare("SELECT COUNT(*) AS n FROM goal_tool_calls WHERE plan_id = ? AND category = ? AND decision = 'allow' AND created_at >= ?")
        .get(run.plan_id, category, approved.since) as { n: number }).n
    : 0
  if (used < approved.n) {
    record(db, run, toolName, category, 'allow', null)
    return { decision: 'allow', category, run_id: run.id }
  }
  const reason = approved.n === 0
    ? `Conductor goal guard: "${category}" needs approval first. Propose it with add_item (action.category "${category}") and wait until it shows approved_to_execute.`
    : `Conductor goal guard: all ${approved.n} approved "${category}" action(s) have already been used. Complete those items, and propose any further action with add_item.`
  record(db, run, toolName, category, 'deny', reason)
  return { decision: 'deny', category, run_id: run.id, reason }
}

export function listToolCalls(db: Database, planId: string, limit = 50): ToolCallRecord[] {
  return db.prepare('SELECT * FROM goal_tool_calls WHERE plan_id = ? ORDER BY created_at DESC, rowid DESC LIMIT ?')
    .all(planId, limit) as ToolCallRecord[]
}
