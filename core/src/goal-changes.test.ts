import { describe, it, expect, beforeEach } from 'vitest'
import type Database from 'better-sqlite3'
import {
  openDatabase, createGoal, getGoal, getPlan, listMemory, insertMemory, queueRun, getRun, claimRun, schedulerPass, buildOverview,
  applyGoalChanges, reportRunEnd, getRunHold, setRunHold, parseLimitReset, isUsageLimit,
} from './index.js'

let db: Database.Database
const now = new Date().toISOString()
const plan = { id: 'g1', name: 'Inbox', description: null, status: 'active' as const, working_dir: '/tmp', created_at: now, updated_at: now }

beforeEach(() => {
  db = openDatabase(':memory:')
  createGoal(db, plan, { objective: 'Inbox zero', instructions: '', autonomy: { 'email.archive': 'auto' } })
})

describe('applyGoalChanges', () => {
  it('changes the name, objective, instructions, autonomy, tool rules, memory and status, saying what changed', () => {
    const m = insertMemory(db, { plan_id: 'g1', kind: 'fact', text: 'Gmail is not connected', source: 'agent' })
    const done = applyGoalChanges(db, 'g1', {
      name: 'Inbox under 20',
      objective: 'Keep the inbox under 20 unread',
      instructions: 'Never touch mail from the bank.',
      autonomy: { 'email.send': 'propose', 'email.archive': null, 'email.delete': 'off' },
      tool_map: { 'mcp__gmail__send*': 'email.send' },
      add_memory: [{ kind: 'rule', text: 'Archive newsletters after a week', pinned: true }],
      forget_memory: [m.id],
      status: 'paused',
    })
    expect(done).toEqual([
      'renamed to "Inbox under 20"', 'objective changed', 'instructions changed',
      'email.send: propose', 'email.archive: back to propose', 'email.delete: off',
      'tool rule mcp__gmail__send* → email.send', 'remembered (rule): Archive newsletters after a week', `forgot memory ${m.id}`, 'paused',
    ])
    expect(getPlan(db, 'g1')!.name).toBe('Inbox under 20')
    expect(getGoal(db, 'g1')).toMatchObject({
      objective: 'Keep the inbox under 20 unread', status: 'paused',
      autonomy: { 'email.send': 'propose', 'email.delete': 'off' }, tool_map: { 'mcp__gmail__send*': 'email.send' },
    })
    expect(listMemory(db, 'g1', { activeOnly: true }).map((x) => [x.text, x.source, x.pinned])).toEqual([['Archive newsletters after a week', 'human', true]])
  })

  it('refuses a bad mode or another goal\'s memory, changing nothing', () => {
    createGoal(db, { ...plan, id: 'g2' }, { objective: 'x' })
    const other = insertMemory(db, { plan_id: 'g2', kind: 'fact', text: 'x', source: 'human' })
    expect(() => applyGoalChanges(db, 'g1', { autonomy: { 'email.send': 'yes' as never } })).toThrow(/isn't a mode/)
    expect(() => applyGoalChanges(db, 'g1', { objective: 'changed', forget_memory: [other.id] })).toThrow(/isn't this goal's/)
    expect(getGoal(db, 'g1')!.objective).toBe('Inbox zero')
  })
})

describe('the usage limit', () => {
  it('reads the reset time, local, the next time it comes round', () => {
    const at = new Date(2026, 10, 8, 19, 30)
    const reset = parseLimitReset("You've hit your 5-hour limit · resets 8:10pm (Pacific/Auckland)", at)!
    expect([reset.getDate(), reset.getHours(), reset.getMinutes()]).toEqual([8, 20, 10])
    const tomorrow = parseLimitReset('resets 7am', at)!
    expect([tomorrow.getDate(), tomorrow.getHours()]).toEqual([9, 7])
    expect(parseLimitReset('try again later', at)).toBeNull()
    expect(isUsageLimit("You've hit your 5-hour limit · resets 8:10pm")).toBe(true)
    expect(isUsageLimit('All done: archived 4 newsletters.')).toBe(false)
  })

  it('a run that hits it is skipped, not failed, and no run starts until the reset', async () => {
    const t = new Date(2099, 0, 5, 19, 30)
    const run = claimRun(db, 'g1', { holder: 'A', now: t })!
    const r = reportRunEnd(db, run.run_id, { answer: "You've hit your 5-hour limit · resets 8:10pm (Pacific/Auckland)" }, t)
    expect(r.outcome).toBe('held')
    expect(getRun(db, run.run_id)).toMatchObject({ status: 'skipped', skip_reason: expect.stringContaining('usage limit reached') })
    expect(getRunHold(db, t)).toMatchObject({ until: new Date(2099, 0, 5, 20, 10).toISOString() })
    expect(buildOverview(db).hold).not.toBeNull()

    queueRun(db, 'g1')
    const held = await schedulerPass(db, { holder: 'A', now: new Date(2099, 0, 5, 20, 0) })
    expect(held).toMatchObject({ claimed: [], hold: expect.objectContaining({ reason: expect.stringContaining('5-hour limit') }) })
    const after = await schedulerPass(db, { holder: 'A', now: new Date(2099, 0, 5, 20, 11) })
    expect(after.claimed).toHaveLength(1)
    expect(getRunHold(db, new Date(2099, 0, 5, 20, 11))).toBeNull()
  })

  it('another error fails the run with its message; an ordinary turn changes nothing', () => {
    const run = claimRun(db, 'g1', { holder: 'A' })!
    expect(reportRunEnd(db, run.run_id, { answer: 'Still waiting on the export.' })).toEqual({ outcome: 'unchanged' })
    expect(reportRunEnd(db, run.run_id, { answer: 'API Error: 529 overloaded', reason: 'error' })).toEqual({ outcome: 'failed' })
    expect(getRun(db, run.run_id)).toMatchObject({ status: 'failed', summary: 'The agent stopped on an error: API Error: 529 overloaded' })
    setRunHold(db, { until: new Date(Date.now() + 60_000).toISOString(), reason: 'x' })
    expect(getRunHold(db)).not.toBeNull()
  })
})

describe('run usage', () => {
  it('adds each turn\'s tokens to the run, after end_run too, and the overview shows the total', () => {
    const run = claimRun(db, 'g1', { holder: 'session-A' })!
    reportRunEnd(db, run.run_id, { answer: 'working', usage: { input_tokens: 100, output_tokens: 50, cache_read_input_tokens: 1000, cache_creation_input_tokens: 200, model: 'claude-sonnet-5-5' } })
    db.prepare("UPDATE goal_runs SET status = 'completed' WHERE id = ?").run(run.run_id)
    reportRunEnd(db, run.run_id, { answer: 'Done.', usage: { input_tokens: 10, output_tokens: 5, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 } })
    expect(getRun(db, run.run_id)).toMatchObject({ input_tokens: 110, output_tokens: 55, cache_read_tokens: 1000, cache_write_tokens: 200, model: 'claude-sonnet-5-5' })
    expect(buildOverview(db).goals[0]!.runs[0]).toMatchObject({ tokens: 1365, model: 'claude-sonnet-5-5' })
  })
})
