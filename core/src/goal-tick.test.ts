import { describe, it, expect, beforeEach } from 'vitest'
import type { Database } from './sqlite.js'
import {
  openDatabase, createGoal, updateGoal, getGoal, queueRun, getRun, updateRun, addItem, getTask, listMemory, listRuns,
  takeLease, releaseLease, leaseHolder, claimRun, schedulerPass, expireStaleRuns, decideItem, attachAgent, guardToolCallForRun,
  buildOverview, overviewWithEtag, LEASE_MS, insertRun, endRun, updateTask, reviveIfDone, insertMemory,
  SCHEMA_VERSION, dbSchemaVersion, schemaOutdated, runMigrations, setSchedule, cronNext,
} from './index.js'

let db: Database
const now = new Date().toISOString()
const plan = { id: 'g1', name: 'Inbox', description: null, status: 'active' as const, working_dir: '/tmp/inbox', created_at: now, updated_at: now }

beforeEach(() => {
  db = openDatabase(':memory:')
  createGoal(db, plan, { objective: 'Inbox zero', instructions: '', autonomy: { 'email.archive': 'auto', 'email.delete': 'off' } })
})

describe('scheduler lease', () => {
  it('lets one holder at a time take it, and another once it expires or is released', () => {
    const t = new Date()
    expect(takeLease(db, 'A', t)).toBe(true)
    expect(takeLease(db, 'B', t)).toBe(false)
    expect(takeLease(db, 'A', new Date(t.getTime() + 1000))).toBe(true) // renew
    expect(takeLease(db, 'B', new Date(t.getTime() + 1000 + LEASE_MS + 1))).toBe(true)
    expect(takeLease(db, 'A', new Date(t.getTime() + 1000 + LEASE_MS + 2))).toBe(false)
    releaseLease(db, 'B')
    expect(takeLease(db, 'A', new Date(t.getTime() + 1000 + LEASE_MS + 3))).toBe(true)
  })

  it('the overview says when the standing session is the one starting runs', () => {
    expect(leaseHolder(db)).toBeNull()
    takeLease(db, 'standing')
    expect(leaseHolder(db)).toBe('standing')
    expect(buildOverview(db, 'all', 'standing')).toMatchObject({ standing: true })
    expect(buildOverview(db, 'all', 'another')).not.toHaveProperty('standing')
    expect(buildOverview(db)).not.toHaveProperty('standing')
    // A lease that ran out is nobody's
    expect(leaseHolder(db, new Date(Date.now() + LEASE_MS + 1000))).toBeNull()
  })
})

describe('claimRun', () => {
  it('claims a queued run once, with a prompt naming the goal and run', () => {
    const q = queueRun(db, 'g1')
    const claimed = claimRun(db, 'g1', { holder: 'A', queuedRunId: q.id })
    expect(claimed).toMatchObject({ run_id: q.id, goal_id: 'g1', name: 'Inbox', working_dir: '/tmp/inbox', max_run_minutes: 15 })
    expect(claimed!.prompt).toContain(`run_id "${q.id}"`)
    expect(getRun(db, q.id)).toMatchObject({ status: 'running', holder: 'A' })
    expect(getGoal(db, 'g1')!.last_run_at).not.toBeNull()
    expect(claimRun(db, 'g1', { holder: 'B', queuedRunId: q.id })).toBeNull()
  })

  it('creates and claims a run when none is queued', () => {
    const claimed = claimRun(db, 'g1', { holder: 'A', trigger: 'interval' })
    expect(getRun(db, claimed!.run_id)).toMatchObject({ status: 'running', trigger: 'interval', holder: 'A' })
  })

  it('records the subagent doing the run', () => {
    const claimed = claimRun(db, 'g1', { holder: 'A' })!
    attachAgent(db, claimed.run_id, 'agent-1')
    expect(getRun(db, claimed.run_id)!.agent_id).toBe('agent-1')
  })
})

describe('schedulerPass', () => {
  it('claims queued runs for the lease holder only', async () => {
    const q = queueRun(db, 'g1')
    const other = await schedulerPass(db, { holder: 'B', now: new Date() }).then(() => schedulerPass(db, { holder: 'A' }))
    expect(other).toEqual({ leader: false, claimed: [], expired: [] })
    // B took the lease first and claimed the run
    expect(getRun(db, q.id)).toMatchObject({ status: 'running', holder: 'B' })
  })

  it('claims a due interval run and moves next_run_at forward', async () => {
    createGoal(db, { ...plan, id: 'g2', name: 'Every half hour' }, { objective: 'x' }, { minutes: 30 })
    const t = new Date(Date.now() + 1000)
    const r = await schedulerPass(db, { holder: 'A', now: t })
    expect(r.claimed.map((c) => [c.goal_id, c.trigger])).toEqual([['g2', 'interval']])
    expect(getGoal(db, 'g2')!.next_run_at! > t.toISOString()).toBe(true)
  })

  it('restarts an interval from a run started any other way', async () => {
    createGoal(db, { ...plan, id: 'g2', name: 'Hourly' }, { objective: 'x' }, { minutes: 60 })
    const t = new Date()
    updateGoal(db, 'g2', { next_run_at: new Date(t.getTime() + 5 * 60_000).toISOString() })
    queueRun(db, 'g2') // Run now, five minutes before the scheduled run
    const r = await schedulerPass(db, { holder: 'A', now: t })
    expect(r.claimed.map((c) => [c.goal_id, c.trigger])).toEqual([['g2', 'manual']])
    expect(getGoal(db, 'g2')!.next_run_at).toBe(new Date(t.getTime() + 60 * 60_000).toISOString())
  })

  it('keeps a cron slot when a run starts some other way', async () => {
    createGoal(db, { ...plan, id: 'g2', name: 'Daily' }, { objective: 'x' })
    setSchedule(db, 'g2', { kind: 'cron', expr: '0 8 * * *' })
    const t = new Date()
    const slot = cronNext('0 8 * * *', t).toISOString()
    updateGoal(db, 'g2', { next_run_at: slot })
    queueRun(db, 'g2')
    const r = await schedulerPass(db, { holder: 'A', now: t })
    expect(r.claimed.map((c) => [c.goal_id, c.trigger])).toEqual([['g2', 'manual']])
    expect(getGoal(db, 'g2')!.next_run_at).toBe(slot)
  })

  it('starts no more than maxConcurrent runs at once', async () => {
    createGoal(db, { ...plan, id: 'g2', name: 'B' }, { objective: 'x' })
    createGoal(db, { ...plan, id: 'g3', name: 'C' }, { objective: 'x' })
    for (const id of ['g1', 'g2', 'g3']) queueRun(db, id)
    const first = await schedulerPass(db, { holder: 'A', maxConcurrent: 2 })
    expect(first.claimed).toHaveLength(2)
    expect((await schedulerPass(db, { holder: 'A', maxConcurrent: 2 })).claimed).toHaveLength(0)
    updateRun(db, first.claimed[0]!.run_id, { status: 'completed' })
    expect((await schedulerPass(db, { holder: 'A', maxConcurrent: 2 })).claimed).toHaveLength(1)
  })

  it('skips a queued run past the daily limit', async () => {
    updateGoal(db, 'g1', { limits: { max_runs_per_day: 1 } })
    insertRun(db, 'g1', 'manual', 'completed')
    const q = queueRun(db, 'g1')
    expect((await schedulerPass(db, { holder: 'A' })).claimed).toEqual([])
    expect(getRun(db, q.id)).toMatchObject({ status: 'skipped', skip_reason: expect.stringMatching(/daily run limit/) })
  })
})

describe('expireStaleRuns', () => {
  it('times out runs well past their limit, except ones the caller tracks', () => {
    const a = claimRun(db, 'g1', { holder: 'A' })!
    const later = new Date(Date.now() + 25 * 60_000)
    expect(expireStaleRuns(db, later, { skipRunIds: new Set([a.run_id]) })).toEqual([])
    expect(expireStaleRuns(db, new Date(Date.now() + 5 * 60_000))).toEqual([])
    expect(expireStaleRuns(db, later)).toEqual([a.run_id])
    expect(getRun(db, a.run_id)!.status).toBe('timed_out')
  })
})

describe('decideItem', () => {
  it('a question for the person waits under Needs you; answering it saves the answer and queues a run', () => {
    const q = addItem(db, 'g1', null, { goal: 'Which job sites should I search?', ask_person: true }).task
    expect(q).toMatchObject({ status: 'active', review_requested_at: expect.any(String) })
    expect(buildOverview(db).goals[0]!.needs_you[0]).toMatchObject({ id: q.id, asks_person: true })
    expect(() => decideItem(db, 'g1', q.id, { decision: 'answer', feedback: ' ' })).toThrow(/answer is needed/)
    const r = decideItem(db, 'g1', q.id, { decision: 'answer', feedback: 'Seek and LinkedIn' })
    expect(r.task).toMatchObject({ status: 'completed', result: 'Your answer: Seek and LinkedIn' })
    expect(r.queuedRun).not.toBeNull()
    expect(listMemory(db, 'g1').map((m) => m.text)).toContain('You answered "Which job sites should I search?": Seek and LinkedIn')
  })

  it('a request marked done completes and queues a run; a proposal cannot be answered', () => {
    const q = addItem(db, 'g1', null, { goal: 'Connect Gmail', ask_person: true }).task
    expect(decideItem(db, 'g1', q.id, { decision: 'approve' })).toMatchObject({ task: { status: 'completed' }, queuedRun: expect.anything() })
    const p = addItem(db, 'g1', null, { goal: 'Reply to Bob', action: { category: 'email.send', summary: 'Send reply' } }).task
    expect(() => decideItem(db, 'g1', p.id, { decision: 'answer', feedback: 'yes' })).toThrow(/isn't a question/)
  })

  it('approving a proposal keeps it active and queues a run', () => {
    addItem(db, 'g1', null, { goal: 'Reply to Bob', action: { category: 'email.send', summary: 'Send reply' } })
    const r = decideItem(db, 'g1', '1', { decision: 'approve' })
    expect(r.task).toMatchObject({ status: 'active', approved_by: 'human' })
    expect(r.queuedRun).toMatchObject({ status: 'queued', trigger: 'manual' })
  })

  it('rejecting saves the feedback as goal memory', () => {
    addItem(db, 'g1', null, { goal: 'Reply to Bob', action: { category: 'email.send', summary: 'Send reply' } })
    const r = decideItem(db, 'g1', '1', { decision: 'reject', feedback: 'too formal' })
    expect(r.queuedRun).toBeNull()
    expect(getTask(db, 'g1', '1')!.review_requested_at).toBeNull()
    expect(listMemory(db, 'g1').map((m) => m.text)).toContain('Feedback on "Reply to Bob": too formal')
  })

  it('refuses an unknown item', () => {
    expect(() => decideItem(db, 'g1', '9', { decision: 'approve' })).toThrow(/not found/)
  })
})

describe('guardToolCallForRun', () => {
  it('applies the goal autonomy to a running run, and allows anything outside runs', () => {
    updateGoal(db, 'g1', { tool_map: { 'mcp__gmail__send*': 'email.send', 'mcp__gmail__delete': 'email.delete' } })
    const run = claimRun(db, 'g1', { holder: 'A' })!
    expect(guardToolCallForRun(db, run.run_id, 'mcp__gmail__delete')).toMatchObject({ decision: 'deny', category: 'email.delete' })
    expect(guardToolCallForRun(db, run.run_id, 'mcp__gmail__send_reply')).toMatchObject({ decision: 'deny', reason: expect.stringMatching(/needs approval/) })
    expect(guardToolCallForRun(db, run.run_id, 'Read')).toEqual({ decision: 'allow', run_id: run.run_id })
    expect(guardToolCallForRun(db, 'run_nope', 'mcp__gmail__delete')).toEqual({ decision: 'allow' })
  })
})

describe('buildOverview', () => {
  it('stays small however much runs write: long text is clipped', () => {
    const long = 'x'.repeat(5000)
    for (let i = 0; i < 12; i++) {
      const id = `big${i}`
      createGoal(db, { id, name: `Goal ${i}`, description: null, status: 'active', working_dir: '/tmp', created_at: new Date().toISOString(), updated_at: new Date().toISOString() },
        { objective: long, instructions: long })
      for (let m = 0; m < 10; m++) insertMemory(db, { plan_id: id, kind: 'fact', text: long, source: 'agent' })
      for (let n = 0; n < 15; n++) addItem(db, id, null, { goal: long, notes: long, action: { category: 'email.send', summary: long } })
      for (let r = 0; r < 5; r++) {
        const run = insertRun(db, id, 'manual', 'running')
        db.prepare("UPDATE goal_runs SET status = 'completed', summary = ?, ended_at = ? WHERE id = ?").run(long, new Date().toISOString(), run.id)
      }
    }
    // Cards for all stay well under the ~50 KB a plugin can read; one goal's full detail is bounded too
    expect(JSON.stringify(buildOverview(db, [])).length).toBeLessThan(45_000)
    expect(JSON.stringify(buildOverview(db, ['big0']).goals.find((g) => g.id === 'big0')).length).toBeLessThan(30_000)
    const o = buildOverview(db, ['big0'])
    expect(o.goals.find((g) => g.id === 'big0')).toMatchObject({ detail: true, needs_you_count: 15 })
    expect(o.goals.find((g) => g.id === 'big0')!.runs[0]!.summary!.length).toBeLessThanOrEqual(300)
    expect(o.goals.find((g) => g.id === 'big1')).toMatchObject({ detail: false, needs_you_count: 15, memory: [], open_items: [] })
    expect(o.goals.find((g) => g.id === 'big1')!.needs_you).toHaveLength(5)
  })

  it('a question carries its context (notes) on a card and in detail, within bounds', () => {
    const context = 'Two ways: (a) stop the agent once its handback is answered; (b) let the handback through. I would do (a).'
    addItem(db, 'g1', null, { goal: 'Issue #8: which approach?', notes: context, ask_person: true })
    expect(buildOverview(db).goals[0]!.needs_you[0]).toMatchObject({ asks_person: true, notes: context })
    expect(buildOverview(db, []).goals[0]!.needs_you[0]).toMatchObject({ asks_person: true, notes: context })
    const long = 'x'.repeat(5000)
    for (let i = 0; i < 12; i++) {
      const id = `q${i}`
      createGoal(db, { id, name: `Goal ${i}`, description: null, status: 'active', working_dir: '/tmp', created_at: new Date().toISOString(), updated_at: new Date().toISOString() },
        { objective: long, instructions: long })
      for (let n = 0; n < 15; n++) addItem(db, id, null, { goal: long, notes: long, ask_person: true })
    }
    expect(JSON.stringify(buildOverview(db, [])).length).toBeLessThan(45_000)
    expect(JSON.stringify(buildOverview(db, ['q0']).goals.find((g) => g.id === 'q0')).length).toBeLessThan(30_000)
    const card = buildOverview(db, []).goals.find((g) => g.id === 'q1')!.needs_you
    expect(card.filter((i) => 'notes' in i)).toHaveLength(1)
  })

  it("leaves the actions params out (the goal page shows them)", () => {
    addItem(db, 'g1', null, { goal: 'Reply to Bob', action: { category: 'email.send', summary: 'Send reply', params: { body: 'x'.repeat(5000) } } })
    const item = buildOverview(db).goals[0]!.needs_you[0]!
    expect(item.action).toEqual({ category: 'email.send', summary: 'Send reply' })
  })

  it('lists goals with items waiting for review, and an etag that changes with them', () => {
    const before = overviewWithEtag(db).etag
    addItem(db, 'g1', null, { goal: 'Reply to Bob', action: { category: 'email.send', summary: 'Send reply' } })
    const o = buildOverview(db)
    expect(o.goals).toHaveLength(1)
    expect(o.goals[0]).toMatchObject({ id: 'g1', name: 'Inbox', needs_you: [{ id: '1', awaiting_review: true }] })
    expect(overviewWithEtag(db).etag).not.toBe(before)
    expect(listRuns(db, 'g1')).toEqual([])
  })
})

describe('one-off goals', () => {
  const oneOff = (id = 'o1') => createGoal(db, { ...plan, id, name: 'Tidy downloads' }, { objective: 'Delete old installers', one_off: true })

  it('a run that leaves nothing open makes it done, and it can run again', async () => {
    oneOff()
    const run = claimRun(db, 'o1', { holder: 'A' })!
    endRun(db, run.run_id, 'Deleted 12 installers.')
    expect(getGoal(db, 'o1')).toMatchObject({ status: 'retired', one_off: true, next_run_at: null })
    expect(buildOverview(db).goals.find((g) => g.id === 'o1')).toMatchObject({ status: 'retired', one_off: true })
    expect(reviveIfDone(db, 'o1')).toBe(true)
    expect(getGoal(db, 'o1')!.status).toBe('active')
    expect(reviveIfDone(db, 'g1')).toBe(false)
  })

  it('stays while a proposal waits, and finishes after the run that carries it out', async () => {
    oneOff()
    const first = claimRun(db, 'o1', { holder: 'A' })!
    addItem(db, 'o1', first.run_id, { goal: 'Delete ~/Downloads/big.iso', action: { category: 'fs.delete', summary: 'Delete it' } })
    endRun(db, first.run_id, 'Proposed one deletion.')
    expect(getGoal(db, 'o1')!.status).toBe('active')
    const { queuedRun } = decideItem(db, 'o1', '1', { decision: 'approve' })
    const second = claimRun(db, 'o1', { holder: 'A', queuedRunId: queuedRun!.id })!
    updateTask(db, 'o1', '1', { status: 'completed' })
    endRun(db, second.run_id, 'Deleted it.')
    expect(getGoal(db, 'o1')!.status).toBe('retired')
  })

  it('a rejected proposal queues a run to revise it; recurring goals never finish', async () => {
    oneOff()
    const run = claimRun(db, 'o1', { holder: 'A' })!
    addItem(db, 'o1', run.run_id, { goal: 'Delete all of ~/Downloads', action: { category: 'fs.delete', summary: 'Delete everything' } })
    endRun(db, run.run_id, 'Proposed.')
    expect(decideItem(db, 'o1', '1', { decision: 'reject', feedback: 'only installers' }).queuedRun).toMatchObject({ status: 'queued' })

    const g1 = claimRun(db, 'g1', { holder: 'A' })!
    endRun(db, g1.run_id, 'Nothing to do.')
    expect(getGoal(db, 'g1')!.status).toBe('active')
    expect(buildOverview(db).goals.map((g) => g.id)).toContain('g1')
  })

  it('other retired goals stay out of the overview', async () => {
    updateGoal(db, 'g1', { status: 'retired' })
    expect(buildOverview(db).goals.map((g) => g.id)).not.toContain('g1')
  })
})

describe('schema version', () => {
  it('records the schema version and never lowers a newer one', () => {
    expect(dbSchemaVersion(db)).toBe(SCHEMA_VERSION)
    db.exec(`PRAGMA user_version = ${SCHEMA_VERSION + 1}`)
    runMigrations(db)
    expect(dbSchemaVersion(db)).toBe(SCHEMA_VERSION + 1)
  })

  it('an outdated session schedules nothing and the overview says so', async () => {
    queueRun(db, 'g1')
    expect(buildOverview(db).outdated).toBeUndefined()
    db.exec(`PRAGMA user_version = ${SCHEMA_VERSION + 1}`)
    expect(schemaOutdated(db)).toBe(true)
    const r = await schedulerPass(db, { holder: 'A' })
    expect(r).toEqual({ leader: false, claimed: [], expired: [], outdated: true })
    expect(buildOverview(db).outdated).toBe(true)
  })
})
