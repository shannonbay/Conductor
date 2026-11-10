/**
 * Goal schedules (interval or cron) and webhook (event) triggers.
 * Cron uses the standard five fields in local time: minute hour day-of-month month day-of-week.
 */
import type { Database } from './sqlite.js'
import { createHash, randomBytes, timingSafeEqual } from 'crypto'
import { getIntervalTrigger, listTriggers, newId, setIntervalTrigger } from './goals.js'
import type { CronConfig, EventConfig, GoalTrigger, IntervalConfig } from './types.js'

// ── Cron ──────────────────────────────────────────────────────────────────────

interface CronFields {
  minute: Set<number>
  hour: Set<number>
  dom: Set<number>
  month: Set<number>
  dow: Set<number>
  domAny: boolean
  dowAny: boolean
}

const RANGES: [number, number][] = [[0, 59], [0, 23], [1, 31], [1, 12], [0, 7]]
const FIELD_NAMES = ['minute', 'hour', 'day of month', 'month', 'day of week']

function parseField(text: string, index: number): Set<number> {
  const [lo, hi] = RANGES[index]
  const out = new Set<number>()
  for (const part of text.split(',')) {
    const m = /^(\*|(\d+)(?:-(\d+))?)(?:\/(\d+))?$/.exec(part)
    if (!m) throw new Error(`Invalid cron ${FIELD_NAMES[index]}: "${part}"`)
    const step = m[4] ? Number(m[4]) : 1
    let from = lo
    let to = hi
    if (m[1] !== '*') {
      from = Number(m[2])
      to = m[3] !== undefined ? Number(m[3]) : (m[4] ? hi : from)
    }
    if (step < 1 || from < lo || to > hi || from > to) throw new Error(`Invalid cron ${FIELD_NAMES[index]}: "${part}" (allowed ${lo}-${hi})`)
    for (let v = from; v <= to; v += step) out.add(index === 4 && v === 7 ? 0 : v)
  }
  return out
}

export function parseCron(expr: string): CronFields {
  const parts = expr.trim().split(/\s+/)
  if (parts.length !== 5) throw new Error('A cron expression has 5 fields: minute hour day-of-month month day-of-week, e.g. "0 9 * * 1-5"')
  const [minute, hour, dom, month, dow] = parts.map(parseField)
  return { minute, hour, dom, month, dow, domAny: parts[2] === '*', dowAny: parts[4] === '*' }
}

function dayMatches(f: CronFields, d: Date): boolean {
  const dom = f.dom.has(d.getDate())
  const dow = f.dow.has(d.getDay())
  // Standard cron: if both day fields are restricted, either may match
  if (!f.domAny && !f.dowAny) return dom || dow
  return dom && dow
}

/** The first time strictly after `from` (local time, to the minute) that matches the expression. */
export function cronNext(expr: string, from: Date): Date {
  const f = parseCron(expr)
  const d = new Date(from.getTime())
  d.setSeconds(0, 0)
  d.setMinutes(d.getMinutes() + 1)
  const limit = from.getTime() + 4 * 366 * 86_400_000
  while (d.getTime() <= limit) {
    if (!f.month.has(d.getMonth() + 1)) { d.setMonth(d.getMonth() + 1, 1); d.setHours(0, 0, 0, 0); continue }
    if (!dayMatches(f, d)) { d.setDate(d.getDate() + 1); d.setHours(0, 0, 0, 0); continue }
    if (!f.hour.has(d.getHours())) { d.setHours(d.getHours() + 1, 0, 0, 0); continue }
    if (!f.minute.has(d.getMinutes())) { d.setMinutes(d.getMinutes() + 1, 0, 0); continue }
    return d
  }
  throw new Error(`Cron expression "${expr}" never matches`)
}

// ── Schedule (one interval or cron trigger per goal) ──────────────────────────

export type Schedule = ({ kind: 'interval' } & IntervalConfig) | ({ kind: 'cron' } & CronConfig)

export function getSchedule(db: Database, planId: string): Schedule | null {
  const interval = getIntervalTrigger(db, planId)
  if (interval?.enabled) return { kind: 'interval', ...interval.config }
  const cron = listTriggers(db, planId).find((t) => t.kind === 'cron' && t.enabled)
  return cron ? { kind: 'cron', ...(cron.config as CronConfig) } : null
}

/** Replaces the goal's schedule; null makes it manual-only. Validates cron expressions. */
export function setSchedule(db: Database, planId: string, schedule: Schedule | null): void {
  db.prepare("DELETE FROM goal_triggers WHERE plan_id = ? AND kind = 'cron'").run(planId)
  if (schedule?.kind === 'cron') {
    cronNext(schedule.expr, new Date()) // throws if invalid or never matches
    setIntervalTrigger(db, planId, null)
    db.prepare("INSERT INTO goal_triggers (id, plan_id, kind, config, enabled) VALUES (?, ?, 'cron', ?, 1)")
      .run(newId('trg'), planId, JSON.stringify({ expr: schedule.expr.trim() }))
    return
  }
  setIntervalTrigger(db, planId, schedule ? { minutes: schedule.minutes, ...(schedule.active_hours && { active_hours: schedule.active_hours }) } : null)
}

/** When the next scheduled run is due after `from`; null for manual-only goals. */
export function nextScheduledRun(db: Database, planId: string, from: Date = new Date()): string | null {
  const s = getSchedule(db, planId)
  if (!s) return null
  return s.kind === 'interval'
    ? new Date(from.getTime() + s.minutes * 60_000).toISOString()
    : cronNext(s.expr, from).toISOString()
}

// ── Event (webhook) trigger ───────────────────────────────────────────────────

const hash = (secret: string) => createHash('sha256').update(secret).digest('hex')

export function getEventTrigger(db: Database, planId: string): GoalTrigger | undefined {
  return listTriggers(db, planId).find((t) => t.kind === 'event')
}

/** Enables the webhook and returns a new secret. Only its hash is stored, so show it to the user once. */
export function enableEventTrigger(db: Database, planId: string): string {
  const secret = randomBytes(24).toString('base64url')
  db.prepare("DELETE FROM goal_triggers WHERE plan_id = ? AND kind = 'event'").run(planId)
  db.prepare("INSERT INTO goal_triggers (id, plan_id, kind, config, enabled) VALUES (?, ?, 'event', ?, 1)")
    .run(newId('trg'), planId, JSON.stringify({ secret_hash: hash(secret) } satisfies EventConfig))
  return secret
}

export function disableEventTrigger(db: Database, planId: string): void {
  db.prepare("DELETE FROM goal_triggers WHERE plan_id = ? AND kind = 'event'").run(planId)
}

/** Constant-time check of a webhook secret. */
export function verifyEventSecret(db: Database, planId: string, secret: string): boolean {
  const t = getEventTrigger(db, planId)
  if (!t?.enabled || !secret) return false
  const expected = Buffer.from((t.config as EventConfig).secret_hash, 'hex')
  const actual = Buffer.from(hash(secret), 'hex')
  return expected.length === actual.length && timingSafeEqual(expected, actual)
}
