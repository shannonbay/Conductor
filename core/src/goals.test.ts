import { describe, it, expect, beforeEach } from 'vitest'
import type { Database } from './sqlite.js'
import {
  openDatabase, insertTask, getTask, getPlan, getPlanRevision,
  createGoal, getGoal, listGoals, updateGoal, setIntervalTrigger, getIntervalTrigger,
  insertRun, getRun, updateRun, listRuns, getOpenRun, countRunsSince,
  insertMemory, listMemory, updateMemory, deleteMemory, getMemory,
  deleteGoal, type NewTask,
} from './index.js'

let db: Database
const now = new Date().toISOString()
const plan = (id = 'g1') => ({ id, name: 'Inbox', description: null, status: 'active' as const, working_dir: '/tmp', created_at: now, updated_at: now })
const item = (id: string, extra: Partial<NewTask> = {}): NewTask => ({
  id, plan_id: 'g1', goal: `item ${id}`, status: 'pending', result: null, abandon_reason: null, state: {}, depends_on: null,
  created_at: now, updated_at: now, ...extra,
})

beforeEach(() => { db = openDatabase(':memory:') })

describe('goal storage', () => {
  it('creates a goal as a plan of kind goal with default limits', () => {
    const g = createGoal(db, plan(), { objective: 'Inbox zero', autonomy: { 'email.archive': 'auto' } })
    expect(getPlan(db, 'g1')!.kind).toBe('goal')
    expect(g).toMatchObject({
      objective: 'Inbox zero', instructions: '', status: 'active', autonomy: { 'email.archive': 'auto' },
      limits: { max_run_minutes: 15, max_items_per_run: 50, max_runs_per_day: 48 }, item_retention_days: 7, next_run_at: null,
    })
  })

  it('plans default to kind plan', () => {
    db.prepare("INSERT INTO plans (id, name, status, working_dir, created_at, updated_at) VALUES ('p', 'P', 'active', '/', ?, ?)").run(now, now)
    expect(getPlan(db, 'p')!.kind).toBe('plan')
  })

  it('creating with an interval schedules the first run immediately', () => {
    const g = createGoal(db, plan(), { objective: 'x' }, { minutes: 30, active_hours: '08:00-20:00' })
    expect(g.next_run_at).not.toBeNull()
    expect(getIntervalTrigger(db, 'g1')).toMatchObject({ kind: 'interval', enabled: true, config: { minutes: 30, active_hours: '08:00-20:00' } })
  })

  it('updates goals, merging limits', () => {
    createGoal(db, plan(), { objective: 'x' })
    updateGoal(db, 'g1', { status: 'paused', limits: { max_run_minutes: 5 }, autonomy: { 'email.send': 'off' } })
    expect(getGoal(db, 'g1')).toMatchObject({ status: 'paused', autonomy: { 'email.send': 'off' }, limits: { max_run_minutes: 5, max_items_per_run: 50 } })
    expect(listGoals(db, 'paused')).toHaveLength(1)
    expect(listGoals(db, 'active')).toHaveLength(0)
  })

  it('keeps one interval trigger per goal and validates it', () => {
    createGoal(db, plan(), { objective: 'x' })
    setIntervalTrigger(db, 'g1', { minutes: 10 })
    setIntervalTrigger(db, 'g1', { minutes: 20 })
    expect(getIntervalTrigger(db, 'g1')!.config.minutes).toBe(20)
    expect(() => setIntervalTrigger(db, 'g1', { minutes: 0 })).toThrow(/at least 1 minute/)
    expect(() => setIntervalTrigger(db, 'g1', { minutes: 5, active_hours: '8-20' })).toThrow(/active_hours/)
    setIntervalTrigger(db, 'g1', null)
    expect(getIntervalTrigger(db, 'g1')).toBeUndefined()
  })
})

describe('runs', () => {
  beforeEach(() => createGoal(db, plan(), { objective: 'x' }))

  it('tracks open runs and counts non-skipped runs', () => {
    const r = insertRun(db, 'g1', 'manual')
    expect(getOpenRun(db, 'g1')?.id).toBe(r.id)
    updateRun(db, r.id, { status: 'completed', summary: 'done', ended_at: now })
    expect(getOpenRun(db, 'g1')).toBeUndefined()
    const skipped = insertRun(db, 'g1', 'interval', 'skipped', 'channel busy')
    expect(skipped.ended_at).not.toBeNull()
    expect(countRunsSince(db, 'g1', '2000-01-01')).toBe(1)
    expect(listRuns(db, 'g1').map((x) => x.status)).toEqual(['skipped', 'completed'])
    expect(listRuns(db, 'g1', 10, { includeSkipped: false })).toHaveLength(1)
    expect(getRun(db, r.id)!.summary).toBe('done')
  })

  it('bumps the plan revision when runs change', () => {
    const before = getPlanRevision(db, 'g1')!
    const r = insertRun(db, 'g1', 'manual')
    updateRun(db, r.id, { status: 'running' })
    expect(getPlanRevision(db, 'g1')!).toBeGreaterThanOrEqual(before + 2)
  })
})

describe('memory', () => {
  beforeEach(() => createGoal(db, plan(), { objective: 'x' }))

  it('adds, updates, deactivates and deletes memories', () => {
    const m = insertMemory(db, { plan_id: 'g1', kind: 'rule', text: '  Never archive mail from the bank. ', source: 'human' })
    expect(m).toMatchObject({ text: 'Never archive mail from the bank.', pinned: false, active: true })
    updateMemory(db, m.id, { pinned: true, active: false })
    expect(getMemory(db, m.id)).toMatchObject({ pinned: true, active: false })
    expect(listMemory(db, 'g1', { activeOnly: true })).toHaveLength(0)
    expect(listMemory(db, 'g1')).toHaveLength(1)
    deleteMemory(db, m.id)
    expect(listMemory(db, 'g1')).toHaveLength(0)
  })

  it('rejects empty text', () => {
    expect(() => insertMemory(db, { plan_id: 'g1', kind: 'fact', text: ' ', source: 'agent' })).toThrow(/required/)
  })
})

describe('work item columns', () => {
  beforeEach(() => createGoal(db, plan(), { objective: 'x' }))

  it('stores run_id, external_ref and archived_at', () => {
    insertTask(db, item('1', { run_id: 'run_a', external_ref: 'gmail:1', archived_at: now }))
    expect(getTask(db, 'g1', '1')).toMatchObject({ run_id: 'run_a', external_ref: 'gmail:1', archived_at: now })
  })

  it('refuses two items with the same external_ref in one goal', () => {
    insertTask(db, item('1', { external_ref: 'gmail:1' }))
    expect(() => insertTask(db, item('2', { external_ref: 'gmail:1' }))).toThrow(/UNIQUE/)
    insertTask(db, item('3'))
    insertTask(db, item('4')) // many items without a ref are fine
  })
})

describe('deleteGoal', () => {
  it('removes the goal and everything it holds; refuses while a run is going', () => {
    createGoal(db, plan(), { objective: 'Inbox zero' })
    insertTask(db, item('1'))
    insertMemory(db, { plan_id: 'g1', kind: 'fact', text: 'x', source: 'human' })
    const run = insertRun(db, 'g1', 'manual', 'running')
    expect(() => deleteGoal(db, 'g1')).toThrow(/run in progress/)
    db.prepare("UPDATE goal_runs SET status = 'completed' WHERE id = ?").run(run.id)
    expect(deleteGoal(db, 'g1').name).toBeTruthy()
    expect(getGoal(db, 'g1')).toBeUndefined()
    for (const t of ['tasks', 'goal_memory', 'goal_runs', 'plans']) {
      expect((db.prepare(`SELECT COUNT(*) n FROM ${t} WHERE ${t === 'plans' ? 'id' : 'plan_id'} = 'g1'`).get() as { n: number }).n).toBe(0)
    }
    expect(() => deleteGoal(db, 'g1')).toThrow(/not found/)
  })
})
