/**
 * Watches: a goal's run starts when something happens, not only on a timer.
 *
 * A watch is a check that prints one line per current item (an open issue's
 * number, a feed entry's id, a file's name). The scheduler runs it every few
 * minutes; a line it hasn't seen before is an event, and events queue a run
 * whose brief lists them. The first check that works only records what is
 * there, and a check that fails changes nothing, so an outage never looks
 * like "everything is new".
 *
 * A watch with fires 'change' watches a state instead (a working tree, a
 * health URL): when its output differs from the last check's, each line that
 * wasn't in the last check is an event, and output that becomes empty is one
 * "(none)" event. The same lines in another order are no change.
 */
import type { Database } from './sqlite.js'
import { runVerifyCommand } from './gates.js'
import { getGoal, newId } from './goals.js'
import { canonicalToolName, matchToolCategory, QUARTERDECK_TOOL_PREFIX } from './guard.js'
import { getPlan } from './queries.js'
import type { Watch, WatchEvent, WatchSpec } from './types.js'

export const WATCH_TIMEOUT_S = 30
/** Lines read from one check; more are ignored. */
export const WATCH_MAX_LINES = 200
export const WATCH_LINE_CHARS = 300
/** Lines remembered per watch, the latest check's first. */
export const WATCH_SEEN_MAX = 1000
/** How much of a command's output is read. */
export const WATCH_OUTPUT_CHARS = 64 * 1024
/** Checks failed in a row before the watch is shown as failing. */
export const WATCH_FAILING_AFTER = 3
/** New lines per watch a brief lists; the rest are counted. */
export const WATCH_BRIEF_LINES = 50
export const WATCH_MIN_MINUTES = 1
export const WATCH_DEFAULT_MINUTES = 5
/** A tool watch's lines when it has no `match` of its own: every "id" in a JSON answer. */
export const WATCH_DEFAULT_MATCH = String.raw`"id"\s*:\s*"([^"]+)"`
/** A tool watch handed out for checking and never reported is handed out again after this long. */
export const WATCH_REPORT_GRACE_MS = 2 * 60_000
/** The event a 'change' watch records when its output becomes empty. */
export const WATCH_NONE_LINE = '(none)'
/** Events a run has taken are kept this long. */
const EVENT_RETENTION_MS = 30 * 86_400_000

type Row = Record<string, unknown>

function deserializeWatch(r: Row): Watch {
  return { ...r, tool_input: JSON.parse((r.tool_input as string) || '{}'), seen: JSON.parse((r.seen as string) || '[]') } as Watch
}

// ── Storage ───────────────────────────────────────────────────────────────────

/** A goal's watches, by name. */
export function listWatches(db: Database, planId: string): Watch[] {
  return (db.prepare('SELECT * FROM goal_watches WHERE plan_id = ? ORDER BY name').all(planId) as Row[]).map(deserializeWatch)
}

export function getWatch(db: Database, id: string): Watch | undefined {
  const r = db.prepare('SELECT * FROM goal_watches WHERE id = ?').get(id) as Row | undefined
  return r ? deserializeWatch(r) : undefined
}

/**
 * Adds a goal's watch, or changes the one with that name. A new command
 * starts over: what the old one saw says nothing about the new one's lines.
 */
export function setWatch(db: Database, planId: string, name: string, spec: WatchSpec): Watch {
  const goal = getGoal(db, planId)
  if (!goal) throw new Error(`Goal ${planId} not found`)
  const label = name.trim()
  if (!label) throw new Error('A watch needs a name.')
  const every = spec.every_minutes ?? WATCH_DEFAULT_MINUTES
  if (!Number.isInteger(every) || every < WATCH_MIN_MINUTES) throw new Error(`The watch "${label}" must check every ${WATCH_MIN_MINUTES} minute or more.`)
  const fires = spec.fires ?? 'new'
  if (fires !== 'new' && fires !== 'change') throw new Error(`The watch "${label}" fires on "new" or "change", not ${JSON.stringify(fires)}.`)

  // What it checks: a command, or a tool with its input and how to read the answer
  const what: Check = { kind: 'command', command: null, tool: null, tool_input: '{}', match: null }
  const given = spec as { command?: string; tool?: string; input?: Record<string, unknown>; match?: string }
  if (given.tool !== undefined) {
    const tool = String(given.tool).trim()
    if (!tool) throw new Error(`The watch "${label}" needs a tool.`)
    if (given.command) throw new Error(`The watch "${label}" has a command and a tool: give one.`)
    if (!tool.startsWith('mcp__')) throw new Error(`The watch "${label}" can only call a connector or MCP tool (mcp__…), not ${tool}.`)
    if (canonicalToolName(tool).startsWith(QUARTERDECK_TOOL_PREFIX) || /^mcp__quarterdeck-(goals|guard)__/.test(tool)) {
      throw new Error(`The watch "${label}" can't call Quarterdeck's own tools.`)
    }
    // A watch calls its tool with nobody asked, so it may not call what a run would need approval for
    const category = matchToolCategory(goal.tool_map, tool)
    const mode = category ? goal.autonomy[category] ?? 'propose' : 'auto'
    if (mode !== 'auto') {
      throw new Error(`The watch "${label}" can't call ${tool}: this goal's rules put it under "${category}", which is ${mode}. A watch may only read.`)
    }
    if (given.match !== undefined) {
      try { new RegExp(given.match) } catch { throw new Error(`The watch "${label}" has a match that isn't a regular expression: ${given.match}`) }
    }
    Object.assign(what, { kind: 'tool', tool, tool_input: JSON.stringify(given.input ?? {}), match: given.match?.trim() || null })
  } else {
    const command = String(given.command ?? '').trim()
    if (!command) throw new Error(`The watch "${label}" needs a command.`)
    what.command = command
  }

  const existing = listWatches(db, planId).find((w) => w.name === label)
  if (!existing) {
    const id = newId('wch')
    db.prepare('INSERT INTO goal_watches (id, plan_id, name, kind, command, tool, tool_input, match, every_minutes, fires, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
      .run(id, planId, label, what.kind, what.command, what.tool, what.tool_input, what.match, every, fires, new Date().toISOString())
    return getWatch(db, id)!
  }
  const same = existing.kind === what.kind && existing.command === what.command && existing.tool === what.tool
    && JSON.stringify(existing.tool_input) === what.tool_input && existing.match === what.match && existing.fires === fires
  if (same) {
    db.prepare('UPDATE goal_watches SET every_minutes = ? WHERE id = ?').run(every, existing.id)
  } else {
    db.prepare(`
      UPDATE goal_watches SET kind = ?, command = ?, tool = ?, tool_input = ?, match = ?, every_minutes = ?, fires = ?, seen = '[]', baseline_at = NULL,
        last_checked_at = NULL, asked_at = NULL, last_error = NULL, fail_count = 0 WHERE id = ?
    `).run(what.kind, what.command, what.tool, what.tool_input, what.match, every, fires, existing.id)
    db.prepare('DELETE FROM goal_watch_events WHERE watch_id = ? AND run_id IS NULL').run(existing.id)
  }
  return getWatch(db, existing.id)!
}

type Check = { kind: Watch['kind']; command: string | null; tool: string | null; tool_input: string; match: string | null }

/** What a watch checks, in a line: its command, or its tool with the input it is called with. */
export function describeWatch(w: Pick<Watch, 'kind' | 'command' | 'tool' | 'tool_input' | 'match'>): string {
  if (w.kind === 'command') return w.command ?? ''
  const input = Object.keys(w.tool_input).length ? ` ${JSON.stringify(w.tool_input)}` : ''
  return `${w.tool}${input}${w.match ? ` (lines: ${w.match})` : ''}`
}

/** Removes a goal's watch and the events no run has taken. True if there was one. */
export function removeWatch(db: Database, planId: string, name: string): boolean {
  const watch = listWatches(db, planId).find((w) => w.name === name.trim())
  if (!watch) return false
  db.prepare('DELETE FROM goal_watch_events WHERE watch_id = ? AND run_id IS NULL').run(watch.id)
  db.prepare('DELETE FROM goal_watches WHERE id = ?').run(watch.id)
  return true
}

export function watchDue(watch: Watch, now: Date = new Date()): boolean {
  if (!watch.last_checked_at) return true
  return now.getTime() - new Date(watch.last_checked_at).getTime() >= watch.every_minutes * 60_000
}

export function watchFailing(watch: Pick<Watch, 'fail_count'>): boolean {
  return watch.fail_count >= WATCH_FAILING_AFTER
}

// ── Checking ──────────────────────────────────────────────────────────────────

/** A check's output as lines: trimmed, without blanks or repeats, each clipped, at most WATCH_MAX_LINES. */
export function toLines(output: string): string[] {
  const lines = new Set<string>()
  for (const raw of output.split(/\r?\n/)) {
    const line = raw.trim().slice(0, WATCH_LINE_CHARS)
    if (line) lines.add(line)
    if (lines.size >= WATCH_MAX_LINES) break
  }
  return [...lines]
}

export interface WatchCheck {
  /** True for the first check that worked: it recorded what is there and started nothing. */
  baseline: boolean
  /** How many lines the check gave. */
  lines: number
  /** The lines not seen before (none on the baseline). */
  fresh: string[]
  error?: string
}

/**
 * Records one check's result: the lines it gave, or why it failed. New lines
 * become events. A failed check leaves what was seen alone and fires nothing.
 */
export function recordWatchLines(db: Database, watchId: string, result: { lines: string[] } | { error: string }, now: Date = new Date()): WatchCheck {
  const watch = getWatch(db, watchId)
  if (!watch) throw new Error(`Watch ${watchId} not found`)
  const at = now.toISOString()
  if ('error' in result) {
    const error = result.error.trim().slice(-500) || 'The check failed.'
    db.prepare('UPDATE goal_watches SET last_checked_at = ?, last_error = ?, fail_count = fail_count + 1 WHERE id = ?').run(at, error, watchId)
    return { baseline: false, lines: 0, fresh: [], error }
  }

  const known = new Set(watch.seen)
  const baseline = watch.baseline_at === null
  const current = new Set(result.lines)
  let fresh: string[]
  let seen: string[]
  if (watch.fires === 'change') {
    // Only the last check counts: the same set of lines (in any order) is no change
    const changed = current.size !== known.size || result.lines.some((l) => !known.has(l))
    fresh = baseline || !changed ? [] : result.lines.length ? result.lines.filter((l) => !known.has(l)) : [WATCH_NONE_LINE]
    seen = result.lines.slice(0, WATCH_SEEN_MAX)
  } else {
    fresh = baseline ? [] : result.lines.filter((l) => !known.has(l))
    seen = [...result.lines, ...watch.seen.filter((l) => !current.has(l))].slice(0, WATCH_SEEN_MAX)
  }

  db.transaction(() => {
    const insert = db.prepare('INSERT INTO goal_watch_events (id, watch_id, plan_id, line, created_at) VALUES (?, ?, ?, ?, ?)')
    for (const line of fresh) insert.run(newId('wev'), watchId, watch.plan_id, line, at)
    // last_error and last_fired_at are written only when they change: the pane re-reads on those
    db.prepare('UPDATE goal_watches SET seen = ?, baseline_at = COALESCE(baseline_at, ?), last_checked_at = ?, fail_count = 0 WHERE id = ?')
      .run(JSON.stringify(seen), at, at, watchId)
    if (watch.last_error !== null) db.prepare('UPDATE goal_watches SET last_error = NULL WHERE id = ?').run(watchId)
    if (fresh.length) db.prepare('UPDATE goal_watches SET last_fired_at = ? WHERE id = ?').run(at, watchId)
    db.prepare('DELETE FROM goal_watch_events WHERE watch_id = ? AND run_id IS NOT NULL AND created_at < ?')
      .run(watchId, new Date(now.getTime() - EVENT_RETENTION_MS).toISOString())
  })()
  return { baseline, lines: result.lines.length, fresh }
}

/** Runs a command watch in its goal's working directory and records the result. */
export async function checkCommandWatch(db: Database, watchId: string, now: Date = new Date()): Promise<WatchCheck> {
  const watch = getWatch(db, watchId)
  if (!watch) throw new Error(`Watch ${watchId} not found`)
  const plan = getPlan(db, watch.plan_id)
  if (!plan || watch.kind !== 'command' || !watch.command) throw new Error(`Watch ${watchId} has no command to run`)
  const r = await runVerifyCommand(watch.command, plan.working_dir, WATCH_TIMEOUT_S, { stdoutOnly: true, tailChars: WATCH_OUTPUT_CHARS })
  if (r.passed) return recordWatchLines(db, watchId, { lines: toLines(r.output) }, now)
  const why = r.timed_out
    ? `Timed out after ${WATCH_TIMEOUT_S} s`
    : r.exit_code === null ? r.output : `Exit code ${r.exit_code}${r.stderr?.trim() ? `: ${r.stderr.trim()}` : ''}`
  return recordWatchLines(db, watchId, { error: why }, now)
}

// ── Tool watches: the plugin makes the call, since only a session can reach a connector ──

/** A tool's answer as lines: each match of `pattern` (its first group, or all of it). */
export function matchLines(text: string, pattern: string | null): string[] {
  const re = new RegExp(pattern ?? WATCH_DEFAULT_MATCH, 'g')
  const found: string[] = []
  for (const m of text.matchAll(re)) {
    if (m[0] === '') break // a pattern that matches nothing would match everywhere
    found.push((m[1] ?? m[0]).replace(/\s+/g, ' '))
    if (found.length >= WATCH_MAX_LINES * 2) break
  }
  return toLines(found.join('\n'))
}

/** A tool watch that is due: the caller calls `tool` with `input` and answers with reportToolWatch. */
export interface ToolWatchCall {
  watch_id: string
  goal_id: string
  name: string
  tool: string
  input: Record<string, unknown>
}

/**
 * The due tool watches of the given goals, marked as asked so the next pass
 * doesn't hand them out again. One whose answer never comes is handed out
 * again after WATCH_REPORT_GRACE_MS.
 */
export function takeDueToolWatches(db: Database, planIds: string[], now: Date = new Date()): ToolWatchCall[] {
  const calls: ToolWatchCall[] = []
  for (const planId of planIds) {
    for (const w of listWatches(db, planId)) {
      if (w.kind !== 'tool' || !w.tool || !watchDue(w, now)) continue
      if (w.asked_at && now.getTime() - new Date(w.asked_at).getTime() < WATCH_REPORT_GRACE_MS) continue
      db.prepare('UPDATE goal_watches SET asked_at = ? WHERE id = ?').run(now.toISOString(), w.id)
      calls.push({ watch_id: w.id, goal_id: planId, name: w.name, tool: w.tool, input: w.tool_input })
    }
  }
  return calls
}

/** Records what a tool watch's call answered: its text, read into lines, or why it failed. */
export function reportToolWatch(db: Database, watchId: string, result: { text: string } | { error: string }, now: Date = new Date()): WatchCheck {
  const watch = getWatch(db, watchId)
  if (!watch || watch.kind !== 'tool') throw new Error(`Tool watch ${watchId} not found`)
  db.prepare('UPDATE goal_watches SET asked_at = NULL WHERE id = ?').run(watchId)
  if ('error' in result) return recordWatchLines(db, watchId, { error: result.error }, now)
  return recordWatchLines(db, watchId, { lines: matchLines(result.text, watch.match) }, now)
}

// ── Events ────────────────────────────────────────────────────────────────────

/** How many of a goal's events no run has been queued for yet. */
export function countUnqueuedWatchEvents(db: Database, planId: string): number {
  return (db.prepare('SELECT COUNT(*) n FROM goal_watch_events WHERE plan_id = ? AND run_id IS NULL AND queued_at IS NULL').get(planId) as { n: number }).n
}

/** Marks a goal's waiting events as having a run queued for them: each event queues at most one. */
export function markWatchEventsQueued(db: Database, planId: string, now: Date = new Date()): void {
  db.prepare('UPDATE goal_watch_events SET queued_at = ? WHERE plan_id = ? AND run_id IS NULL AND queued_at IS NULL').run(now.toISOString(), planId)
}

export interface WatchNews {
  watch: string
  /** The new lines, oldest first, at most WATCH_BRIEF_LINES. */
  new: string[]
  /** New lines left out of `new`. */
  omitted: number
}

/**
 * What a goal's watches saw that no earlier run was told: with `runId`, the
 * waiting events become that run's (asking again gives the same ones);
 * without, they are only listed.
 */
export function takeWatchEvents(db: Database, planId: string, runId?: string): WatchNews[] {
  if (runId) db.prepare('UPDATE goal_watch_events SET run_id = ? WHERE plan_id = ? AND run_id IS NULL').run(runId, planId)
  const rows = db.prepare(`
    SELECT e.line, COALESCE(w.name, 'a removed watch') AS watch
    FROM goal_watch_events e LEFT JOIN goal_watches w ON w.id = e.watch_id
    WHERE e.plan_id = ? AND ${runId ? 'e.run_id = ?' : 'e.run_id IS NULL'}
    ORDER BY e.created_at, e.rowid
  `).all(...(runId ? [planId, runId] : [planId])) as { line: string; watch: string }[]
  const byWatch = new Map<string, string[]>()
  for (const r of rows) byWatch.set(r.watch, [...(byWatch.get(r.watch) ?? []), r.line])
  return [...byWatch.entries()].map(([watch, lines]) => ({
    watch, new: lines.slice(0, WATCH_BRIEF_LINES), omitted: Math.max(0, lines.length - WATCH_BRIEF_LINES),
  }))
}

/**
 * Gives a run's events back, for a run that ended without doing its work: the
 * next run is told them instead. `requeue` also lets them queue a run again
 * (for a run that never got going, not for one that failed).
 */
export function releaseWatchEvents(db: Database, runId: string, opts: { requeue?: boolean } = {}): void {
  db.prepare(`UPDATE goal_watch_events SET run_id = NULL${opts.requeue ? ', queued_at = NULL' : ''} WHERE run_id = ?`).run(runId)
}

export function listWatchEvents(db: Database, planId: string): WatchEvent[] {
  return db.prepare('SELECT * FROM goal_watch_events WHERE plan_id = ? ORDER BY created_at, rowid').all(planId) as WatchEvent[]
}
