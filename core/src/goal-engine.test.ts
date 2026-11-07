import { describe, it, expect, beforeEach } from 'vitest'
import type Database from 'better-sqlite3'
import {
  openDatabase, createGoal, updateGoal, getGoal, insertRun, getRun, updateRun, insertMemory, listMemory, getMemory, updateTask, getTask, getPlan,
  addItem, buildBrief, queueRun, startRun, endRun, failRun, archiveResolved, withinActiveHours, decideTick, nextIntervalRun, recordSkip,
  approveTask, rejectTask, checkCompletion, GoalError, listRuns, MEMORY_BRIEF_CHARS,
} from './index.js'

let db: Database.Database
const now = new Date().toISOString()
const plan = { id: 'g1', name: 'Inbox', description: null, status: 'active' as const, working_dir: '/tmp', created_at: now, updated_at: now }

beforeEach(() => {
  db = openDatabase(':memory:')
  createGoal(db, plan, {
    objective: 'Inbox zero',
    instructions: 'Archive newsletters.',
    autonomy: { 'email.archive': 'auto', 'email.delete': 'off' },
  })
})

describe('addItem', () => {
  it('creates a plain item as a root-level pending task', () => {
    const r = addItem(db, 'g1', null, { goal: 'Look at invoice', external_ref: 'gmail:1' })
    expect(r).toMatchObject({ existing: false })
    expect(r.task).toMatchObject({ id: '1', status: 'pending', external_ref: 'gmail:1', created_by: 'agent' })
    expect(addItem(db, 'g1', null, { goal: 'next' }).task.id).toBe('2')
  })

  it('returns the existing item for a known external_ref, even if archived', () => {
    addItem(db, 'g1', null, { goal: 'a', external_ref: 'gmail:1' })
    updateTask(db, 'g1', '1', { status: 'completed', archived_at: now })
    const again = addItem(db, 'g1', null, { goal: 'a again', external_ref: 'gmail:1' })
    expect(again.existing).toBe(true)
    expect(again.task.goal).toBe('a')
  })

  it('refuses actions whose category is off', () => {
    expect(() => addItem(db, 'g1', null, { goal: 'delete spam', action: { category: 'email.delete', summary: 'delete' } })).toThrow(/off for this goal/)
  })

  it('turns actions in propose categories (the default) into items awaiting review', () => {
    const r = addItem(db, 'g1', null, { goal: 'Reply to Alice', action: { category: 'email.send', summary: 'Send reply' } })
    expect(r.mode).toBe('propose')
    expect(r.task).toMatchObject({ status: 'active', requires_approval: true })
    expect(r.task.review_requested_at).not.toBeNull()
    expect(r.task.state.action).toMatchObject({ category: 'email.send', summary: 'Send reply', params: {} })
  })

  it('records auto actions as already done', () => {
    const r = addItem(db, 'g1', null, { goal: 'Archive newsletter', action: { category: 'email.archive', summary: 'Archived' } })
    expect(r.mode).toBe('auto')
    expect(r.task).toMatchObject({ status: 'completed', result: 'Done automatically: Archived' })
  })

  it('enforces the per-run item cap', () => {
    updateGoal(db, 'g1', { limits: { max_items_per_run: 2 } })
    const run = insertRun(db, 'g1', 'manual', 'running')
    addItem(db, 'g1', run.id, { goal: 'a' })
    addItem(db, 'g1', run.id, { goal: 'b' })
    expect(() => addItem(db, 'g1', run.id, { goal: 'c' })).toThrow(/limit 2/)
    expect(() => addItem(db, 'g1', null, { goal: 'outside a run' })).not.toThrow()
  })

  it('only works on goals', () => {
    db.prepare("INSERT INTO plans (id, name, status, working_dir, created_at, updated_at) VALUES ('p', 'P', 'active', '/', ?, ?)").run(now, now)
    expect(() => addItem(db, 'p', null, { goal: 'x' })).toThrow(GoalError)
  })
})

describe('proposals and review', () => {
  function propose() {
    return addItem(db, 'g1', null, { goal: 'Reply to Alice', action: { category: 'email.send', summary: 'Send reply' } }).task
  }

  it('approving a proposal keeps it active so the next run carries it out', async () => {
    propose()
    approveTask(db, 'g1', '1')
    const t = getTask(db, 'g1', '1')!
    expect(t).toMatchObject({ status: 'active', review_requested_at: null, approved_by: 'human' })
    // The agent can now complete it without another review
    expect(await checkCompletion(db, getPlan(db, 'g1')!, t, { actor: 'agent' })).toEqual({ outcome: 'pass' })
  })

  it('rejecting a proposal stores the feedback as memory', () => {
    propose()
    rejectTask(db, 'g1', '1', 'Too formal, keep it casual.')
    const [m] = listMemory(db, 'g1')
    expect(m).toMatchObject({ kind: 'preference', source: 'feedback', source_ref: '1', active: true })
    expect(m.text).toContain('Too formal, keep it casual.')
    expect(m.text).toContain('Reply to Alice')
  })

  it('a rejected proposal goes back to review when re-proposed', async () => {
    const t = propose()
    rejectTask(db, 'g1', '1', 'no')
    const again = await checkCompletion(db, getPlan(db, 'g1')!, getTask(db, 'g1', t.id)!, { actor: 'agent' })
    expect(again).toEqual({ outcome: 'awaiting_review' })
  })

  it('rejection on an ordinary plan does not create memory', async () => {
    db.prepare("INSERT INTO plans (id, name, status, working_dir, created_at, updated_at) VALUES ('p', 'P', 'active', '/', ?, ?)").run(now, now)
    db.prepare("INSERT INTO tasks (id, plan_id, goal, status, state, requires_approval, review_requested_at, created_at, updated_at) VALUES ('1', 'p', 'x', 'active', '{}', 1, ?, ?, ?)").run(now, now, now)
    rejectTask(db, 'p', '1', 'nope')
    expect(db.prepare('SELECT COUNT(*) n FROM goal_memory').get()).toEqual({ n: 0 })
  })
})

describe('buildBrief', () => {
  it('includes goal, autonomy, open items (approved first) and counts', () => {
    addItem(db, 'g1', null, { goal: 'plain', external_ref: 'gmail:1' })
    addItem(db, 'g1', null, { goal: 'proposal', action: { category: 'email.send', summary: 's' } })
    approveTask(db, 'g1', '2')
    addItem(db, 'g1', null, { goal: 'waiting', action: { category: 'email.send', summary: 's2' } })
    const b = buildBrief(db, 'g1')
    expect(b.goal).toMatchObject({ name: 'Inbox', objective: 'Inbox zero', instructions: 'Archive newsletters.' })
    expect(b.autonomy).toEqual({ default: 'propose', categories: { 'email.archive': 'auto', 'email.delete': 'off' } })
    expect(b.open_items.map((i) => i.id)).toEqual(['2', '1', '3'])
    expect(b.open_items[0]).toMatchObject({ approved_to_execute: true, action: { category: 'email.send' } })
    expect(b.counts).toMatchObject({ open: 3, awaiting_review: 1, approved_to_execute: 1 })
  })

  it('reports decisions made since the previous run only', () => {
    addItem(db, 'g1', null, { goal: 'old', action: { category: 'email.send', summary: 'old' } })
    approveTask(db, 'g1', '1')
    const prev = insertRun(db, 'g1', 'manual', 'running')
    endRun(db, prev.id, 'first run')
    addItem(db, 'g1', null, { goal: 'new', action: { category: 'email.send', summary: 'new' } })
    rejectTask(db, 'g1', '2', 'casual please')
    const run = insertRun(db, 'g1', 'interval', 'running')
    const b = buildBrief(db, 'g1', run.id)
    expect(b.decisions_since_last_run).toEqual([expect.objectContaining({ item: '2', decision: 'rejected', feedback: 'casual please' })])
    expect(b.recent_runs).toEqual([expect.objectContaining({ summary: 'first run' })])
    expect(b.run).toMatchObject({ id: run.id, trigger: 'interval' })
  })

  it('includes pinned memory always and other memory within the budget', () => {
    const pinned = insertMemory(db, { plan_id: 'g1', kind: 'rule', text: 'Never archive the bank.', source: 'human', pinned: true })
    insertMemory(db, { plan_id: 'g1', kind: 'fact', text: 'x'.repeat(MEMORY_BRIEF_CHARS), source: 'agent' })
    insertMemory(db, { plan_id: 'g1', kind: 'fact', text: 'Alice is my manager.', source: 'human' })
    const b = buildBrief(db, 'g1')
    expect(b.memory[0]).toMatchObject({ id: pinned.id, pinned: true })
    expect(b.memory.length + b.memory_omitted).toBe(3)
    expect(b.memory_omitted).toBeGreaterThan(0)
    expect(getMemory(db, pinned.id)!.last_used_at).not.toBeNull()
  })

  it('rejects a run from another goal', () => {
    expect(() => buildBrief(db, 'g1', 'run_missing')).toThrow(/not found/)
  })
})

describe('run lifecycle', () => {
  it('queueRun returns the existing open run instead of creating another', () => {
    const a = queueRun(db, 'g1')
    expect(queueRun(db, 'g1').id).toBe(a.id)
  })

  it('queueRun refuses paused goals', () => {
    updateGoal(db, 'g1', { status: 'paused' })
    expect(() => queueRun(db, 'g1')).toThrow(/paused/)
  })

  it('startRun / endRun record status, counts and last_run_at', () => {
    const run = startRun(db, queueRun(db, 'g1').id, null)
    expect(run.status).toBe('running')
    addItem(db, 'g1', run.id, { goal: 'a' })
    addItem(db, 'g1', run.id, { goal: 'b', action: { category: 'email.archive', summary: 'archived' } })
    const ended = endRun(db, run.id, 'Handled 2 emails.')
    expect(ended).toMatchObject({ status: 'completed', summary: 'Handled 2 emails.', items_created: 2, items_resolved: 1 })
    expect(getGoal(db, 'g1')!.last_run_at).not.toBeNull()
    expect(() => endRun(db, run.id, 'again')).toThrow(/already ended/)
  })

  it('endRun requires a summary', () => {
    const run = startRun(db, queueRun(db, 'g1').id, null)
    expect(() => endRun(db, run.id, '  ')).toThrow(/summary is required/)
  })

  it('failRun marks failed/timed out and ignores finished runs', () => {
    const run = startRun(db, queueRun(db, 'g1').id, null)
    failRun(db, run.id, 'timed_out', 'Run exceeded 15 minutes')
    expect(getRun(db, run.id)).toMatchObject({ status: 'timed_out', summary: 'Run exceeded 15 minutes' })
    failRun(db, run.id, 'failed', 'later')
    expect(getRun(db, run.id)!.status).toBe('timed_out')
  })
})

describe('archiveResolved', () => {
  it('archives resolved items older than the retention period only', () => {
    addItem(db, 'g1', null, { goal: 'old done' })
    addItem(db, 'g1', null, { goal: 'new done' })
    addItem(db, 'g1', null, { goal: 'old open' })
    const old = new Date(Date.now() - 10 * 86_400_000).toISOString()
    updateTask(db, 'g1', '1', { status: 'completed', updated_at: old })
    updateTask(db, 'g1', '2', { status: 'completed' })
    updateTask(db, 'g1', '3', { updated_at: old })
    expect(archiveResolved(db, 'g1')).toBe(1)
    expect(getTask(db, 'g1', '1')!.archived_at).not.toBeNull()
    expect(getTask(db, 'g1', '2')!.archived_at).toBeNull()
    expect(getTask(db, 'g1', '3')!.archived_at).toBeNull()
    expect(buildBrief(db, 'g1').open_items.map((i) => i.id)).toEqual(['3'])
  })
})

describe('scheduler decisions', () => {
  // A date after any next_run_at set during the test, at a chosen local time
  const at = (h: number, m = 0) => new Date(2099, 0, 5, h, m)

  it('withinActiveHours handles normal and overnight windows', () => {
    expect(withinActiveHours(undefined, at(3))).toBe(true)
    expect(withinActiveHours('08:00-20:00', at(8))).toBe(true)
    expect(withinActiveHours('08:00-20:00', at(20))).toBe(false)
    expect(withinActiveHours('22:00-06:00', at(23))).toBe(true)
    expect(withinActiveHours('22:00-06:00', at(5, 59))).toBe(true)
    expect(withinActiveHours('22:00-06:00', at(12))).toBe(false)
  })

  function intervalGoal(id: string, activeHours?: string) {
    createGoal(db, { ...plan, id }, { objective: 'x' }, { minutes: 30, active_hours: activeHours })
  }

  it('starts an interval goal when due, and nothing when not due', () => {
    intervalGoal('g2')
    expect(decideTick(db, 'g2', new Date(Date.now() + 1000))).toEqual({ action: 'start', trigger: 'interval' })
    updateGoal(db, 'g2', { next_run_at: new Date(Date.now() + 3_600_000).toISOString() })
    expect(decideTick(db, 'g2')).toEqual({ action: 'none' })
  })

  it('starts a queued manual run even without an interval', () => {
    const q = queueRun(db, 'g1')
    expect(decideTick(db, 'g1')).toEqual({ action: 'start', trigger: 'manual', queuedRunId: q.id })
  })

  it('does nothing while a run is in progress or the goal is paused', () => {
    intervalGoal('g2')
    const r = insertRun(db, 'g2', 'interval', 'running')
    expect(decideTick(db, 'g2', new Date(Date.now() + 1000))).toEqual({ action: 'none' })
    updateRun(db, r.id, { status: 'completed' })
    updateGoal(db, 'g2', { status: 'paused' })
    expect(decideTick(db, 'g2', new Date(Date.now() + 1000))).toEqual({ action: 'none' })
  })

  it('defers outside active hours', () => {
    intervalGoal('g2', '08:00-09:00')
    const d = decideTick(db, 'g2', at(23))
    expect(d.action).toBe('defer')
  })

  it('skips once the daily run limit is reached', () => {
    intervalGoal('g2')
    updateGoal(db, 'g2', { limits: { max_runs_per_day: 1 } })
    insertRun(db, 'g2', 'interval', 'completed')
    expect(decideTick(db, 'g2', new Date(Date.now() + 1000))).toMatchObject({ action: 'skip', reason: expect.stringMatching(/daily run limit/) })
  })

  it('nextIntervalRun adds the interval; null without one', () => {
    intervalGoal('g2')
    const from = new Date('2026-01-01T00:00:00Z')
    expect(nextIntervalRun(db, 'g2', from)).toBe('2026-01-01T00:30:00.000Z')
    expect(nextIntervalRun(db, 'g1', from)).toBeNull()
  })

  it('recordSkip records at most once per hour per reason', () => {
    expect(recordSkip(db, 'g1', 'interval', 'channel busy')).not.toBeNull()
    expect(recordSkip(db, 'g1', 'interval', 'channel busy')).toBeNull()
    expect(recordSkip(db, 'g1', 'interval', 'not connected')).not.toBeNull()
    expect(listRuns(db, 'g1')).toHaveLength(2)
  })
})
