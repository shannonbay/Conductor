/**
 * The goals overview: every goal that isn't retired, with what a compact view
 * (the quarterdeck-goals pane) needs, in one call. Served by the web app's
 * GET /api/goals/overview and the MCP tool goals_overview.
 */
import { createHash } from 'crypto'
import type { Database } from './sqlite.js'
import { compareTaskIds, deserializeTask, getEvents } from './queries.js'
import { isProposal, asksPerson } from './gates.js'
import { getOpenRun, getGoal, listGoals, listMemory, listRuns } from './goals.js'
import { autonomyFor } from './goal-engine.js'
import { getSchedule } from './schedule.js'
import { listHealth } from './health.js'
import { describeWatch, listWatches, watchFailing } from './watches.js'
import type { Event, Goal, GoalRun, Task } from './types.js'
import { getRunHold } from './goal-changes.js'
import { schemaOutdated } from './migrate.js'
import { leaseHolder } from './goal-tick.js'

const RUNS = 5
const OPEN_ITEMS = 10
const HEALTH = 20
const MEMORY = 10

/**
 * The longest text each field carries in the overview. The overview reaches the
 * plugin as one tool answer, and Claude Code hands a plugin an answer over
 * about 50 KB as a "saved to file" note instead of data, so its size must not
 * grow with how much runs write. The full text is in goal_detail and the
 * goal page.
 */
const CLIP = { summary: 300, memory: 240, title: 200, notes: 200, result: 200, activity: 240, instructions: 1500, objective: 400, watch: 300, context: 1000 }

function clip(text: string | null, max: number): string | null {
  if (text === null || text.length <= max) return text
  return `${text.slice(0, max - 1).trimEnd()}…`
}
/**
 * The goal's status (set by a run through end_run), or null. It is stale when
 * the last finished run failed, or ended later without setting it: it still
 * shows, dimmed, since it is the last word a run gave. `untrusted` is what the
 * run that set it had read, so the pane can mark it.
 */
export function statusNote(goal: Goal, runs: GoalRun[]): { text: string; at: string | null; stale: boolean; untrusted: string | null } | null {
  if (!goal.status_note) return null
  const last = runs.find((r) => r.status !== 'queued' && r.status !== 'running' && r.status !== 'skipped')
  const stale = !!last && (last.status === 'failed' || last.status === 'timed_out'
    || (!!last.ended_at && !!goal.status_note_at && last.ended_at > goal.status_note_at))
  return { text: goal.status_note, at: goal.status_note_at, stale, untrusted: goal.status_note_untrusted }
}

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
    asks_person: asksPerson(t),
    awaiting_review: t.review_requested_at !== null,
    approved_to_execute: isProposal(t) && t.approved_at !== null && t.status === 'active',
    updated_at: t.updated_at,
  }
}

export type ItemView = ReturnType<typeof itemView>

/**
 * An item as the overview carries it: without the action's params, which only
 * the goal page shows. The overview reaches the plugin as one tool answer, and
 * Claude Code saves a large answer to a file instead of passing it on.
 */
function overviewItem(t: Task) {
  const v = itemView(t)
  const action = v.action as { category: string; summary: string } | null
  // A question's notes are its context (the options, what the run would do): it can't be answered without them
  const notesMax = v.asks_person && v.awaiting_review ? CLIP.context : CLIP.notes
  // `clipped`: the pane offers to show the full text (get_item) when any of it was cut
  const clipped = v.goal.length > CLIP.title || (v.notes?.length ?? 0) > notesMax || (action?.summary?.length ?? 0) > CLIP.title
  const short = { ...v, goal: clip(v.goal, CLIP.title)!, notes: clip(v.notes, notesMax), result: clip(v.result, CLIP.result), ...(clipped && { clipped: true }) }
  return action ? { ...short, action: { category: action.category, summary: clip(action.summary, CLIP.title)! } } : short
}

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
  /** A running agent's tool call waiting for the person's permission answer (`text` says so too). */
  waiting?: { tool: string; since: string }
}

type ActivityInput = {
  goal: Pick<Goal, 'status'>
  openRun: Pick<GoalRun, 'status' | 'trigger' | 'started_at'> & Partial<Pick<GoalRun, 'now_tool' | 'now_tool_at' | 'waiting_tool' | 'waiting_since'>> | null
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
    if (openRun.waiting_tool && openRun.waiting_since) {
      const tool = openRun.waiting_tool
      // Quarterdeck's own tools (the brief first) ask only when the session has no allow rule
      // for them, and that prompt often isn't shown anywhere: say so rather than wait silently
      if (/^quarterdeck /.test(tool)) {
        return { state: 'running', text: `Waiting for a permission prompt that may not be showing: ${tool}. Allow Quarterdeck's tools in this session, or cancel the run`, at: openRun.waiting_since, waiting: { tool, since: openRun.waiting_since } }
      }
      return { state: 'running', text: `Waiting for your permission: ${tool}`, at: openRun.waiting_since, waiting: { tool, since: openRun.waiting_since } }
    }
    // The newest of: what its Quarterdeck calls recorded, and its latest other tool call
    const goals = new Map(items.map((t) => [t.id, t.goal]))
    let latest: Activity | null = null
    for (const e of events) {
      if (e.created_at < openRun.started_at) break
      if (e.actor !== 'agent') continue
      const text = describeEvent(e, (id) => goals.get(id) ?? null)
      if (text) {
        latest = { state: 'running', text, at: e.created_at }
        break
      }
    }
    const tool = openRun.now_tool && openRun.now_tool_at && openRun.now_tool_at >= openRun.started_at
      ? { state: 'running' as const, text: `Using ${openRun.now_tool}`, at: openRun.now_tool_at }
      : null
    if (tool && (!latest || tool.at > latest.at!)) return tool
    return latest ?? { state: 'running', text: 'Starting: reading the brief', at: openRun.started_at }
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

/**
 * Which goals get their full detail (runs, memory, open items, instructions,
 * tool rules): 'all', or the ids asked for (the pane's expanded goals). The
 * rest are cards: the last run, up to NEEDS_YOU items waiting for the person
 * (with a count), health, how many watches it has and what's happening now. So the overview grows by a
 * card per goal, not by everything every goal has done.
 */
export type OverviewDetail = 'all' | readonly string[]
const NEEDS_YOU = 5
/** The longest text a card's fields carry (its title line, objective and waiting items). */
const CARD_TEXT = 160
/** How many of a card's questions carry their context (the rest show it once their goal is expanded). */
const CARD_CONTEXT = 1

/** `standingSession`: the standing session's id (`quarterdeck runner`), to say when it is the one starting runs. */
export function buildOverview(db: Database, detail: OverviewDetail = 'all', standingSession: string | null = null) {
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
      const watches = listWatches(db, plan.id)
      return {
        id: plan.id,
        name: plan.name,
        objective: clip(goal.objective, CLIP.objective)!,
        status: goal.status,
        one_off: goal.one_off,
        model: goal.model,
        status_note: statusNote(goal, runs),
        instructions: clip(goal.instructions, CLIP.instructions)!,
        autonomy: goal.autonomy,
        tool_map: goal.tool_map,
        next_run_at: goal.next_run_at,
        schedule: getSchedule(db, plan.id),
        open_run: openRun,
        activity: (() => {
          const a = describeActivity({
            goal,
            openRun,
            lastRun: runs.find((r) => r.status !== 'queued' && r.status !== 'running') ?? null,
            events: openRun?.status === 'running' ? getEvents(db, plan.id, { limit: ACTIVITY_EVENTS }) : [],
            items,
          })
          return { ...a, text: clip(a.text, CLIP.activity)! }
        })(),
        runs: runs.map((r) => ({
          id: r.id, status: r.status, trigger: r.trigger, summary: clip(r.summary, CLIP.summary), started_at: r.started_at, ended_at: r.ended_at, agent_id: r.agent_id,
          // New tokens only: every model call re-reads the cached prompt, so cache reads would swamp the total
          tokens: r.input_tokens + r.output_tokens + r.cache_write_tokens, model: r.model,
          // What untrusted content it read first: from then on its auto actions needed approval
          untrusted: r.untrusted_source,
        })),
        needs_you: open.filter((t) => t.review_requested_at).map(overviewItem),
        open_items: open.filter((t) => !t.review_requested_at).slice(0, OPEN_ITEMS).map(overviewItem),
        open_item_count: open.filter((t) => !t.review_requested_at).length,
        health: listHealth(db, plan.id, HEALTH).map((h) => ({ passed: h.passed, value: h.value, created_at: h.created_at })),
        memory: listMemory(db, plan.id, { activeOnly: true }).slice(-MEMORY).reverse()
          .map((m) => ({ id: m.id, kind: m.kind, text: clip(m.text, CLIP.memory)!, source: m.source, pinned: m.pinned, created_at: m.created_at, untrusted: m.untrusted_source })),
        suggestions: getAutonomySuggestions(db, plan.id),
        // Without when each last checked: that changes every few minutes and would redraw the pane for nothing
        watches: watches.map((w) => ({
          name: w.name, kind: w.kind, every_minutes: w.every_minutes, runs: clip(describeWatch(w), CLIP.watch)!,
          last_fired_at: w.last_fired_at, failing: watchFailing(w), error: watchFailing(w) ? clip(w.last_error, CLIP.notes) : null,
        })),
        watch_count: watches.length,
        watch_failing: watches.some(watchFailing),
      }
    })
    .map((g) => {
      const waiting = g.needs_you.length
      if (detail === 'all' || detail.includes(g.id)) return { ...g, detail: true, needs_you_count: waiting }
      return {
        ...g, detail: false, needs_you_count: waiting,
        objective: clip(g.objective, CARD_TEXT)!,
        // On a card, each waiting item carries only what its row shows
        needs_you: g.needs_you.slice(0, NEEDS_YOU).map((i) => ({
          id: i.id, goal: clip(i.goal, CARD_TEXT)!, asks_person: i.asks_person,
          ...(('clipped' in i && i.clipped) || i.goal.length > CARD_TEXT || ((i.action as { summary?: string } | null)?.summary?.length ?? 0) > CARD_TEXT ? { clipped: true } : {}),
          // A question can't be answered without its context, so a card keeps the first few's
          ...(i.asks_person && i.notes && g.needs_you.filter((q) => q.asks_person).indexOf(i) < CARD_CONTEXT ? { notes: i.notes } : {}),
          action: i.action ? { category: (i.action as { category: string }).category, summary: clip((i.action as { summary: string }).summary, CARD_TEXT)! } : null,
        })),
        runs: g.runs.slice(0, 1), open_items: [], memory: [], instructions: '', tool_map: {}, watches: [],
      }
    })
  const standing = standingSession !== null && leaseHolder(db) === standingSession
  return { goals, hold: getRunHold(db), ...(schemaOutdated(db) ? { outdated: true as const } : {}), ...(standing ? { standing: true as const } : {}) }
}

export type Overview = ReturnType<typeof buildOverview>

/** The overview's JSON and a strong ETag for it (quoted, as HTTP sends it). */
export function overviewWithEtag(db: Database, detail: OverviewDetail = 'all', standingSession: string | null = null): { body: string; etag: string } {
  const body = JSON.stringify(buildOverview(db, detail, standingSession))
  return { body, etag: `"${createHash('sha256').update(body).digest('base64url').slice(0, 27)}"` }
}
