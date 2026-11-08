import { describe, it, expect, beforeEach } from 'vitest'
import { tmpdir } from 'os'
import type Database from 'better-sqlite3'
import {
  openDatabase, createGoal, updateGoal, getGoal, insertRun, addItem, approveTask, updateTask, getTask,
  parseCron, cronNext, getSchedule, setSchedule, nextScheduledRun, decideTick,
  enableEventTrigger, disableEventTrigger, verifyEventSecret,
  runHealthCheck, listHealth, healthDue, parseHealthValue, buildBrief,
  matchToolCategory, bindSessionToRun, guardToolCall, listToolCalls,
} from './index.js'

let db: Database.Database
const now = new Date().toISOString()
const plan = (id = 'g1') => ({ id, name: 'Inbox', description: null, status: 'active' as const, working_dir: tmpdir(), created_at: now, updated_at: now })

beforeEach(() => {
  db = openDatabase(':memory:')
  createGoal(db, plan(), { objective: 'Inbox zero', autonomy: { 'email.archive': 'auto', 'email.delete': 'off' } })
})

describe('cron', () => {
  const at = (y: number, mo: number, d: number, h = 0, mi = 0) => new Date(y, mo - 1, d, h, mi)

  it('parses fields and rejects bad expressions', () => {
    expect([...parseCron('*/15 9-17 * * 1-5').minute]).toEqual([0, 15, 30, 45])
    expect(parseCron('0 0 * * 7').dow.has(0)).toBe(true) // 7 = Sunday
    expect(() => parseCron('0 9 * *')).toThrow(/5 fields/)
    expect(() => parseCron('61 * * * *')).toThrow(/minute/)
    expect(() => parseCron('* * * * mon')).toThrow(/day of week/)
  })

  it('finds the next matching minute', () => {
    expect(cronNext('0 9 * * *', at(2026, 1, 5, 8, 30))).toEqual(at(2026, 1, 5, 9, 0))
    expect(cronNext('0 9 * * *', at(2026, 1, 5, 9, 0))).toEqual(at(2026, 1, 6, 9, 0)) // strictly after
    expect(cronNext('*/20 * * * *', at(2026, 1, 5, 10, 21))).toEqual(at(2026, 1, 5, 10, 40))
    // 2026-01-09 is a Friday → next weekday 09:00 is Monday the 12th
    expect(cronNext('0 9 * * 1-5', at(2026, 1, 9, 10, 0))).toEqual(at(2026, 1, 12, 9, 0))
    expect(cronNext('0 0 1 3 *', at(2026, 1, 5))).toEqual(at(2026, 3, 1, 0, 0))
  })

  it('treats restricted day-of-month and day-of-week as either/or', () => {
    // 13th of the month OR Friday: from Wed 2026-01-07, Friday the 9th comes first
    expect(cronNext('0 12 13 * 5', at(2026, 1, 7))).toEqual(at(2026, 1, 9, 12, 0))
  })

  it('rejects expressions that never match', () => {
    expect(() => cronNext('0 0 31 2 *', at(2026, 1, 1))).toThrow(/never matches/)
  })
})

describe('schedule', () => {
  it('switches between interval, cron and manual', () => {
    setSchedule(db, 'g1', { kind: 'interval', minutes: 30, active_hours: '08:00-20:00' })
    expect(getSchedule(db, 'g1')).toEqual({ kind: 'interval', minutes: 30, active_hours: '08:00-20:00' })
    setSchedule(db, 'g1', { kind: 'cron', expr: '0 9 * * 1-5' })
    expect(getSchedule(db, 'g1')).toEqual({ kind: 'cron', expr: '0 9 * * 1-5' })
    setSchedule(db, 'g1', null)
    expect(getSchedule(db, 'g1')).toBeNull()
    expect(() => setSchedule(db, 'g1', { kind: 'cron', expr: 'nope' })).toThrow()
  })

  it('computes the next run from the schedule', () => {
    const from = new Date(2026, 0, 5, 8, 30)
    setSchedule(db, 'g1', { kind: 'cron', expr: '0 9 * * *' })
    expect(nextScheduledRun(db, 'g1', from)).toBe(new Date(2026, 0, 5, 9, 0).toISOString())
    setSchedule(db, 'g1', { kind: 'interval', minutes: 10 })
    expect(nextScheduledRun(db, 'g1', from)).toBe(new Date(2026, 0, 5, 8, 40).toISOString())
  })

  it('decideTick starts a due cron goal with trigger cron', () => {
    setSchedule(db, 'g1', { kind: 'cron', expr: '0 9 * * *' })
    updateGoal(db, 'g1', { next_run_at: new Date(Date.now() - 1000).toISOString() })
    expect(decideTick(db, 'g1')).toEqual({ action: 'start', trigger: 'cron' })
  })
})

describe('event trigger', () => {
  it('verifies only the current secret', () => {
    const secret = enableEventTrigger(db, 'g1')
    expect(secret.length).toBeGreaterThan(20)
    expect(verifyEventSecret(db, 'g1', secret)).toBe(true)
    expect(verifyEventSecret(db, 'g1', 'wrong')).toBe(false)
    expect(verifyEventSecret(db, 'g1', '')).toBe(false)
    const rotated = enableEventTrigger(db, 'g1')
    expect(verifyEventSecret(db, 'g1', secret)).toBe(false)
    expect(verifyEventSecret(db, 'g1', rotated)).toBe(true)
    disableEventTrigger(db, 'g1')
    expect(verifyEventSecret(db, 'g1', rotated)).toBe(false)
  })
})

describe('health checks', () => {
  it('parses the last number as the value', () => {
    expect(parseHealthValue('unread: 12\nold: 3')).toBe(3)
    expect(parseHealthValue('ratio -1.5')).toBe(-1.5)
    expect(parseHealthValue('all clear')).toBeNull()
  })

  it('runs the command, records value and pass/fail, and shows in the brief', async () => {
    updateGoal(db, 'g1', { health_command: 'node -e "console.log(\'unread older than a day: 7\'); process.exit(1)"' })
    const r = await runHealthCheck(db, 'g1')
    expect(r).toMatchObject({ passed: false, exit_code: 1, value: 7 })
    expect(getGoal(db, 'g1')!.last_health_at).toBe(r.created_at)
    expect(listHealth(db, 'g1')).toHaveLength(1)
    expect(buildBrief(db, 'g1').health).toMatchObject({ passed: false, value: 7, output: expect.stringContaining('unread') })
  })

  it('requires a command', async () => {
    await expect(runHealthCheck(db, 'g1')).rejects.toThrow(/no health check/)
  })

  it('healthDue respects the interval and goal status', () => {
    const g = () => getGoal(db, 'g1')!
    expect(healthDue(g())).toBe(false) // no command
    updateGoal(db, 'g1', { health_command: 'x', health_every_minutes: 60 })
    expect(healthDue(g())).toBe(true)
    updateGoal(db, 'g1', { last_health_at: new Date().toISOString() })
    expect(healthDue(g())).toBe(false)
    expect(healthDue(g(), new Date(Date.now() + 61 * 60_000))).toBe(true)
    updateGoal(db, 'g1', { status: 'paused' })
    expect(healthDue(g(), new Date(Date.now() + 61 * 60_000))).toBe(false)
  })
})

describe('goal guard', () => {
  const MAP = { 'mcp__gmail__send_message': 'email.send', 'mcp__gmail__delete*': 'email.delete', 'mcp__gmail__archive*': 'email.archive' }

  function runWithSession(session = 'cc_1') {
    updateGoal(db, 'g1', { tool_map: MAP })
    const run = insertRun(db, 'g1', 'manual', 'running')
    expect(bindSessionToRun(db, run.id, session)).toBe(true)
    return run
  }

  it('matches exact names before globs', () => {
    expect(matchToolCategory({ 'a__*': 'x', 'a__b': 'y' }, 'a__b')).toBe('y')
    expect(matchToolCategory({ 'a__*': 'x', 'a__b*': 'y' }, 'a__bc')).toBe('y')
    expect(matchToolCategory(MAP, 'mcp__gmail__search')).toBeNull()
  })

  it('allows everything outside a goal run, and unmapped tools inside one', () => {
    expect(guardToolCall(db, 'cc_other', 'mcp__gmail__send_message')).toEqual({ decision: 'allow' })
    runWithSession()
    expect(guardToolCall(db, 'cc_1', 'Bash').decision).toBe('allow')
  })

  it('denies off categories and allows auto ones', () => {
    runWithSession()
    expect(guardToolCall(db, 'cc_1', 'mcp__gmail__delete_message')).toMatchObject({ decision: 'deny', category: 'email.delete', reason: expect.stringMatching(/off/) })
    expect(guardToolCall(db, 'cc_1', 'mcp__gmail__archive_thread')).toMatchObject({ decision: 'allow', category: 'email.archive' })
  })

  it('allows a propose category while an approved proposal is being carried out, however many calls it takes', () => {
    const run = runWithSession()
    expect(guardToolCall(db, 'cc_1', 'mcp__gmail__send_message')).toMatchObject({ decision: 'deny', reason: expect.stringMatching(/needs approval/) })

    const item = addItem(db, 'g1', run.id, { goal: 'Reply to Alice', action: { category: 'email.send', summary: 'send' } }).task
    approveTask(db, 'g1', item.id)
    expect(guardToolCall(db, 'cc_1', 'mcp__gmail__send_message').decision).toBe('allow')
    expect(guardToolCall(db, 'cc_1', 'mcp__gmail__send_message').decision).toBe('allow') // the same action, a second call

    updateTask(db, 'g1', item.id, { status: 'completed' }) // carried out: the approval is used up
    expect(guardToolCall(db, 'cc_1', 'mcp__gmail__send_message')).toMatchObject({ decision: 'deny', reason: expect.stringMatching(/needs approval/) })
    expect(listToolCalls(db, 'g1').map((c) => c.decision)).toEqual(['deny', 'allow', 'allow', 'deny']) // newest first
  })

  it('stops guarding once the run has ended', () => {
    const run = runWithSession()
    db.prepare("UPDATE goal_runs SET status = 'completed' WHERE id = ?").run(run.id)
    expect(guardToolCall(db, 'cc_1', 'mcp__gmail__delete_message')).toEqual({ decision: 'allow' })
    expect(getTask(db, 'g1', '1')).toBeUndefined()
  })

  it('cannot bind a session to a finished run', () => {
    const run = insertRun(db, 'g1', 'manual', 'completed')
    expect(bindSessionToRun(db, run.id, 'cc_1')).toBe(false)
  })
})
