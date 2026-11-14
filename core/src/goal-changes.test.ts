import { describe, it, expect, beforeEach } from 'vitest'
import type { Database } from './sqlite.js'
import {
  openDatabase, createGoal, getGoal, getPlan, listMemory, insertMemory, queueRun, getRun, claimRun, schedulerPass, buildOverview,
  applyGoalChanges, normalizeModel, reportRunEnd, reportRunProgress, insertEvent, getRunHold, setRunHold, parseLimitReset, isUsageLimit,
} from './index.js'

let db: Database
const now = new Date().toISOString()
const plan = { id: 'g1', name: 'Inbox', description: null, status: 'active' as const, working_dir: '/tmp', created_at: now, updated_at: now }

beforeEach(() => {
  db = openDatabase(':memory:')
  createGoal(db, plan, { objective: 'Inbox zero', instructions: '', autonomy: { 'email.archive': 'auto' } })
})

describe('goal model', () => {
  it("is null (the session's) by default; set, it goes with each claimed run and into the overview", () => {
    createGoal(db, { ...plan, id: 'g2', name: 'Feeds' }, { objective: 'Feeds' })
    expect(getGoal(db, 'g2')!.model).toBeNull()
    expect(claimRun(db, 'g2', { holder: 'A' })!.model).toBeNull()
    expect(applyGoalChanges(db, 'g1', { model: 'Haiku' })).toEqual(['runs use haiku'])
    expect(getGoal(db, 'g1')!.model).toBe('haiku')
    expect(buildOverview(db).goals.find((g) => g.id === 'g1')).toMatchObject({ model: 'haiku' })
    const q = queueRun(db, 'g1')
    expect(claimRun(db, 'g1', { holder: 'A', queuedRunId: q.id })!.model).toBe('haiku')
  })

  it("changes to a full id, back to the session's with null, and says nothing when unchanged", () => {
    expect(applyGoalChanges(db, 'g1', { model: 'claude-opus-5-5' })).toEqual(['runs use claude-opus-5-5'])
    expect(applyGoalChanges(db, 'g1', { model: 'claude-opus-5-5' })).toEqual([])
    expect(applyGoalChanges(db, 'g1', { model: null })).toEqual(["runs use the session's model"])
    expect(getGoal(db, 'g1')!.model).toBeNull()
  })

  it("refuses a name that can't be a model, changing nothing", () => {
    expect(() => applyGoalChanges(db, 'g1', { model: 'rm -rf /', name: 'Other' })).toThrow(/isn't a model/)
    expect(getPlan(db, 'g1')!.name).toBe('Inbox')
    expect(normalizeModel('inherit')).toBeNull()
    expect(normalizeModel(' OPUS ')).toBe('opus')
  })

  it('can be given when the goal is made', () => {
    createGoal(db, { ...plan, id: 'g2' }, { objective: 'Feeds', model: 'sonnet' })
    expect(getGoal(db, 'g2')!.model).toBe('sonnet')
  })
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
  it('adds each turn\'s tokens to the run, after end_run too, and the overview shows the new ones (no cache reads)', () => {
    const run = claimRun(db, 'g1', { holder: 'session-A' })!
    reportRunEnd(db, run.run_id, { answer: 'working', usage: { input_tokens: 100, output_tokens: 50, cache_read_input_tokens: 1000, cache_creation_input_tokens: 200, model: 'claude-sonnet-5-5' } })
    db.prepare("UPDATE goal_runs SET status = 'completed' WHERE id = ?").run(run.run_id)
    reportRunEnd(db, run.run_id, { answer: 'Done.', usage: { input_tokens: 10, output_tokens: 5, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 } })
    expect(getRun(db, run.run_id)).toMatchObject({ input_tokens: 110, output_tokens: 55, cache_read_tokens: 1000, cache_write_tokens: 200, model: 'claude-sonnet-5-5' })
    expect(buildOverview(db).goals[0]!.runs[0]).toMatchObject({ tokens: 365,model: 'claude-sonnet-5-5' })
  })
})

describe("a run's progress", () => {
  it('shows its latest tool call, and a call waiting for permission until it settles', () => {
    const t0 = new Date(2099, 0, 5, 9, 0)
    const at = (min: number) => new Date(t0.getTime() + min * 60_000)
    const run = claimRun(db, 'g1', { holder: 'A', now: t0 })!
    const activity = () => buildOverview(db).goals[0]!.activity
    expect(activity().text).toBe('Starting: reading the brief')

    reportRunProgress(db, run.run_id, { event: 'tool', tool: 'Gmail search_threads' }, at(1))
    expect(activity()).toMatchObject({ state: 'running', text: 'Using Gmail search_threads', at: at(1).toISOString() })

    reportRunProgress(db, run.run_id, { event: 'tool', tool: 'Bash: rm old.zip' }, at(2))
    reportRunProgress(db, run.run_id, { event: 'waiting', tool: 'Bash: rm old.zip' }, at(2))
    expect(activity()).toMatchObject({
      text: 'Waiting for your permission: Bash: rm old.zip', waiting: { tool: 'Bash: rm old.zip', since: at(2).toISOString() },
    })
    // Another call settling doesn't end this wait
    reportRunProgress(db, run.run_id, { event: 'settled', tool: 'Gmail search_threads' }, at(3))
    expect(activity().waiting).toBeDefined()
    reportRunProgress(db, run.run_id, { event: 'settled', tool: 'Bash: rm old.zip' }, at(4))
    expect(activity()).toMatchObject({ text: 'Using Bash: rm old.zip' })
    expect(activity().waiting).toBeUndefined()

    // A newer Quarterdeck event says more than the last tool call
    insertEvent(db, { id: 'e1', plan_id: 'g1', task_id: 'g1', event_type: 'memory_added', actor: 'agent', payload: { text: 'Bank mail stays' }, created_at: at(5).toISOString() })
    expect(activity().text).toBe('Noted: Bank mail stays')
    reportRunProgress(db, run.run_id, { event: 'tool', tool: 'Gmail label_thread' }, at(6))
    expect(activity().text).toBe('Using Gmail label_thread')
  })

  it("says a wait on Quarterdeck's own tool may have no prompt showing", () => {
    const run = claimRun(db, 'g1', { holder: 'A' })!
    reportRunProgress(db, run.run_id, { event: 'waiting', tool: 'quarterdeck get_goal_brief' })
    const activity = buildOverview(db).goals[0]!.activity
    expect(activity.text).toMatch(/^Waiting for a permission prompt that may not be showing: quarterdeck get_goal_brief/)
    expect(activity.waiting?.tool).toBe('quarterdeck get_goal_brief')
  })

  it('changes nothing once the run has ended', () => {
    const run = claimRun(db, 'g1', { holder: 'A' })!
    reportRunEnd(db, run.run_id, { answer: 'x', reason: 'error' })
    expect(reportRunProgress(db, run.run_id, { event: 'waiting', tool: 'Bash: ls' })).toEqual({ updated: false })
    expect(getRun(db, run.run_id)!.waiting_tool).toBeNull()
  })
})
