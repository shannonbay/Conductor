/**
 * The goals overview: every goal that isn't retired, with what a compact view
 * (the conductor-goals pane) needs, in one call. Served by the web app's
 * GET /api/goals/overview and the MCP tool goals_overview.
 */
import { createHash } from 'crypto'
import type { Database } from 'better-sqlite3'
import { compareTaskIds, deserializeTask, getEvents } from './queries.js'
import { isProposal } from './gates.js'
import { getOpenRun, getGoal, listGoals, listMemory, listRuns } from './goals.js'
import { autonomyFor } from './goal-engine.js'
import { getSchedule } from './schedule.js'
import { listHealth } from './health.js'
import type { Event, Goal, GoalRun, Task } from './types.js'

const RUNS = 5
const OPEN_ITEMS = 10
const HEALTH = 20
const MEMORY = 10
/** Done one-off goals listed, newest first. */
const DONE = 10
/** Recent events read to find a running agent's latest step. */
const ACTIVITY_EVENTS = 20
/** A "propose" category approved this many times in a row is suggested for "auto". */
export const PROMOTE_AFTER = 10

// ── Items ─────────────────────────────────────────────────────────────────────

/** Work items of a goal that are not archived, in tree order. */
export function getGoalItems(db: Database, planId: string): Task[] {
  const rows = db.prepare('SELECT * FROM tasks WHERE plan_id = ? AND archived_at IS NULL').all(planId) as Record<string, unknown>[]
  return rows.map(deserializeTask).sort((a, b) => compareTaskIds(a.id, b.id))
}

/** A goal work item as the goal page and the overview show it. */
export function itemView(t: Task) {
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

export type ItemView = ReturnType<typeof itemView>

/**
 * Categories still at "propose" whose last PROMOTE_AFTER human decisions were all
 * approvals: candidates for switching to "auto".
 */
export function getAutonomySuggestions(db: Database, planId: string): { category: string; approved_in_a_row: number }[] {
  const goal = getGoal(db, planId)
  if (!goal) return []
  const rows = db.prepare(`
    SELECT json_extract(t.state, '$.action.category') AS category, v.passed
    FROM verifications v JOIN tasks t ON t.plan_id = v.plan_id AND t.id = v.task_id
    WHERE v.plan_id = ? AND v.gate = 'approval' AND json_extract(t.state, '$.action.category') IS NOT NULL
    ORDER BY v.created_at DESC, v.rowid DESC
  `).all(planId) as { category: string; passed: number }[]
  const streak = new Map<string, { n: number; broken: boolean }>()
  for (const r of rows) {
    const s = streak.get(r.category) ?? { n: 0, broken: false }
    if (!s.broken) { if (r.passed) s.n++; else s.broken = true }
    streak.set(r.category, s)
  }
  return [...streak.entries()]
    .filter(([c, s]) => s.n >= PROMOTE_AFTER && autonomyFor(goal, c) === 'propose')
    .map(([category, s]) => ({ category, approved_in_a_row: s.n }))
}

// ── Activity line ─────────────────────────────────────────────────────────────

export type Activity = {
  state: 'running' | 'queued' | 'paused' | 'idle'
  /** One line: what the goal's agent is doing, or what happens next. */
  text: string
  /** When `text` last changed, for a running agent's latest step. */
  at: string | null
}

type ActivityInput = {
  goal: Pick<Goal, 'status'>
  openRun: Pick<GoalRun, 'status' | 'trigger' | 'started_at'> | null
  lastRun: Pick<GoalRun, 'summary'> | null
  /** The goal's recent events, newest first. */
  events: Pick<Event, 'event_type' | 'actor' | 'task_id' | 'payload' | 'created_at'>[]
  items: Pick<Task, 'id' | 'goal' | 'status' | 'state' | 'approved_at'>[]
}

const oneLine = (s: string) => s.replace(/\s+/g, ' ').trim()
const str = (v: unknown) => (typeof v === 'string' && v.trim() ? oneLine(v) : null)

/** What one agent event says it did, or null for events that don't describe work. */
function describeEvent(e: ActivityInput['events'][number], itemGoal: (id: string) => string | null): string | null {
  const p = e.payload
  switch (e.event_type) {
    case 'agent_message':
      return str(p.message)
    case 'tool_call':
      return str(p.tool) ? `Using ${str(p.tool)}` : null
    case 'task_created': {
      const goal = str(p.goal)
      return goal ? `Added "${goal}"${p.mode === 'propose' ? ' for approval' : ''}` : null
    }
    case 'status_changed': {
      const goal = itemGoal(e.task_id)
      if (!goal) return null
      if (p.to === 'completed') return `Completed "${goal}"`
      if (p.to === 'abandoned') return `Dropped "${goal}"`
      return null
    }
    case 'memory_added':
      return str(p.text) ? `Noted: ${str(p.text)}` : null
    default:
      return null
  }
}

/** A one-line summary of what a goal is doing now, or what it does next. */
export function describeActivity({ goal, openRun, lastRun, events, items }: ActivityInput): Activity {
  if (openRun?.status === 'running') {
    const goals = new Map(items.map((t) => [t.id, t.goal]))
    for (const e of events) {
      if (e.created_at < openRun.started_at) break
      if (e.actor !== 'agent') continue
      const text = describeEvent(e, (id) => goals.get(id) ?? null)
      if (text) return { state: 'running', text, at: e.created_at }
    }
    return { state: 'running', text: 'Starting: reading the brief', at: openRun.started_at }
  }
  if (openRun) return { state: 'queued', text: `Queued (${openRun.trigger}) — starts within a minute while Claude Code is open`, at: openRun.started_at }
  if (goal.status === 'paused') return { state: 'paused', text: 'Paused', at: null }

  const approved = items.filter((t) => isProposal(t as Task) && t.approved_at !== null && t.status === 'active')
  if (approved.length > 0) {
    const more = approved.length > 1 ? ` and ${approved.length - 1} more` : ''
    return { state: 'idle', text: `Next run carries out "${oneLine(approved[0]!.goal)}"${more}`, at: null }
  }
  const summary = str(lastRun?.summary)
  if (summary) return { state: 'idle', text: `Last run: ${summary}`, at: null }
  return { state: 'idle', text: 'Waiting for its first run', at: null }
}

// ── Overview ──────────────────────────────────────────────────────────────────

export function buildOverview(db: Database) {
  const all = listGoals(db)
  // Done one-offs (retired) are listed too, the newest few; other retired goals are not
  const done = all.filter(({ goal }) => goal.status === 'retired' && goal.one_off)
    .sort((a, b) => (b.goal.last_run_at ?? '').localeCompare(a.goal.last_run_at ?? ''))
    .slice(0, DONE)
  const goals = [...all.filter(({ goal }) => goal.status !== 'retired'), ...done]
    .sort((a, b) => a.plan.name.localeCompare(b.plan.name))
    .map(({ plan, goal }) => {
      const items = getGoalItems(db, plan.id)
      const open = items.filter((t) => t.status === 'pending' || t.status === 'active')
      const openRun = getOpenRun(db, plan.id) ?? null
      const runs = listRuns(db, plan.id, RUNS, { includeSkipped: false })
      return {
        id: plan.id,
        name: plan.name,
        objective: goal.objective,
        status: goal.status,
        one_off: goal.one_off,
        next_run_at: goal.next_run_at,
        schedule: getSchedule(db, plan.id),
        open_run: openRun,
        activity: describeActivity({
          goal,
          openRun,
          lastRun: runs.find((r) => r.status !== 'queued' && r.status !== 'running') ?? null,
          events: openRun?.status === 'running' ? getEvents(db, plan.id, { limit: ACTIVITY_EVENTS }) : [],
          items,
        }),
        runs: runs.map((r) => ({
          id: r.id, status: r.status, trigger: r.trigger, summary: r.summary, started_at: r.started_at, ended_at: r.ended_at,
        })),
        needs_you: open.filter((t) => t.review_requested_at).map(itemView),
        open_items: open.filter((t) => !t.review_requested_at).slice(0, OPEN_ITEMS).map(itemView),
        open_item_count: open.filter((t) => !t.review_requested_at).length,
        health: listHealth(db, plan.id, HEALTH).map((h) => ({ passed: h.passed, value: h.value, created_at: h.created_at })),
        memory: listMemory(db, plan.id, { activeOnly: true }).slice(-MEMORY).reverse()
          .map((m) => ({ id: m.id, kind: m.kind, text: m.text, source: m.source, pinned: m.pinned, created_at: m.created_at })),
        suggestions: getAutonomySuggestions(db, plan.id),
      }
    })
  return { goals }
}

export type Overview = ReturnType<typeof buildOverview>

/** The overview's JSON and a strong ETag for it (quoted, as HTTP sends it). */
export function overviewWithEtag(db: Database): { body: string; etag: string } {
  const body = JSON.stringify(buildOverview(db))
  return { body, etag: `"${createHash('sha256').update(body).digest('base64url').slice(0, 27)}"` }
}
