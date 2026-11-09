import { describe, it, expect } from 'vitest'
import {
  goals_tick, goals_overview, decide_item, cancel_run, set_goal_status, attach_agent, fail_run, guard_check,
  create_goal, delete_memory, set_schedule, update_goal, report_run_end,
} from '../../tools/goal_runner.js'
import { add_item, get_goal_brief, end_run, run_goal } from '../../tools/goals.js'
import { create_plan } from '../../tools/create_plan.js'
import { createGoal, queueRun, getRun, getGoal, getEvents, updateGoal, insertMemory, getMemory } from '../../db.js'
import { tmpdir } from 'os'
import { getOpenPlan, getOpenRun, withScope } from '../../session.js'
import type { PassResult } from '@conductor/core'

/** A scheduler pass (goals_tick without release). */
const tick = (holder: string) => goals_tick({ holder }) as Promise<PassResult>

const now = new Date().toISOString()

function makeGoal(id = 'goal_inbox') {
  createGoal(
    { id, name: 'Inbox', description: null, status: 'active', working_dir: '/tmp/inbox', created_at: now, updated_at: now },
    { objective: 'Inbox zero', instructions: '', autonomy: { 'email.archive': 'auto', 'email.delete': 'off' } },
  )
  return id
}

/** A run claimed through goals_tick, as the plugin does it. */
async function claim(goalId: string) {
  queueRun(goalId)
  const pass = await tick('session-A')
  return pass.claimed.find((c) => c.goal_id === goalId)!
}

describe('goals_tick', () => {
  it('claims a queued run for the lease holder, with the prompt the agent starts from', async () => {
    const id = makeGoal()
    const run = await claim(id)
    expect(run).toMatchObject({ goal_id: id, name: 'Inbox', working_dir: '/tmp/inbox', max_run_minutes: 15 })
    expect(run.prompt).toContain(`get_goal_brief with goal_id "${id}" and run_id "${run.run_id}"`)
    expect(getRun(run.run_id)).toMatchObject({ status: 'running', holder: 'session-A' })
    expect(getEvents(id).map((e) => e.event_type)).toContain('agent_started')
  })

  it('does nothing for a second session until the first releases the lease', async () => {
    const id = makeGoal()
    await goals_tick({ holder: 'session-A' })
    queueRun(id)
    expect(await goals_tick({ holder: 'session-B' })).toEqual({ leader: false, claimed: [], expired: [] })
    expect(await goals_tick({ holder: 'session-A', release: true })).toEqual({ released: true })
    expect((await tick('session-B')).claimed).toHaveLength(1)
  })
})

describe('goals_overview', () => {
  it('answers changed: false for a matching etag', async () => {
    makeGoal()
    const first = await goals_overview({})
    expect(first).toMatchObject({ changed: true, goals: [expect.objectContaining({ name: 'Inbox' })] })
    expect(await goals_overview({ etag: first.etag })).toEqual({ changed: false, etag: first.etag })
  })
})

describe('run_scope', () => {
  it("lets a run's calls act on its goal without changing the main conversation's open plan", async () => {
    const id = makeGoal()
    const run = await claim(id)
    await create_plan({ name: 'My own work', working_dir: '/tmp' })
    const mine = getOpenPlan()

    await withScope({ planId: id, runId: run.run_id }, async () => {
      await get_goal_brief({ goal_id: id, run_id: run.run_id })
      await add_item({ goal: 'Reply to Bob', action: { category: 'email.send', summary: 'Send reply' } })
      expect(getOpenPlan()).toBe(id)
      expect(getOpenRun()).toBe(run.run_id)
      await end_run({ summary: 'Proposed a reply.' })
    })

    expect(getOpenPlan()).toBe(mine)
    expect(getOpenRun()).toBeNull()
    expect(getRun(run.run_id)).toMatchObject({ status: 'completed', items_created: 1 })
  })
})

describe('decide_item', () => {
  it('approves a proposal, queues a run, and records a human event', async () => {
    const id = makeGoal()
    const run = await claim(id)
    await withScope({ planId: id, runId: run.run_id }, async () => {
      await add_item({ goal: 'Reply to Bob', action: { category: 'email.send', summary: 'Send reply' } })
      await end_run({ summary: 'Proposed a reply.' })
    })
    const r = await decide_item({ goal_id: id, item_id: '1', decision: 'approve' })
    expect(r.item).toMatchObject({ status: 'active', approved_at: expect.any(String) })
    expect(r.queued_run).toMatchObject({ status: 'queued' })
    expect(getEvents(id).find((e) => e.event_type === 'approval_granted')).toMatchObject({ actor: 'human' })
  })

  it('rejecting needs feedback', async () => {
    const id = makeGoal()
    const run = await claim(id)
    await withScope({ planId: id, runId: run.run_id }, () =>
      add_item({ goal: 'Reply to Bob', action: { category: 'email.send', summary: 'Send reply' } }))
    await expect(decide_item({ goal_id: id, item_id: '1', decision: 'reject' })).rejects.toThrow(/Feedback is required/)
    await decide_item({ goal_id: id, item_id: '1', decision: 'reject', feedback: 'too formal' })
    expect(getEvents(id).find((e) => e.event_type === 'review_rejected')).toMatchObject({ actor: 'human' })
  })
})

describe('run bookkeeping', () => {
  it('attach_agent, fail_run and cancel_run', async () => {
    const id = makeGoal()
    const run = await claim(id)
    await attach_agent({ run_id: run.run_id, agent_id: 'agent-1' })
    expect(getRun(run.run_id)!.agent_id).toBe('agent-1')

    expect(await cancel_run({ goal_id: id })).toEqual({ cancelled: run.run_id, agent_id: 'agent-1' })
    expect(getRun(run.run_id)!.status).toBe('failed')
    expect(await fail_run({ run_id: run.run_id, status: 'timed_out', reason: 'late' })).toMatchObject({ changed: false, status: 'failed' })
    await expect(cancel_run({ goal_id: id })).rejects.toThrow(/no run in progress/)
  })

  it('fail_run ends a run that is still going', async () => {
    const id = makeGoal()
    const run = await claim(id)
    expect(await fail_run({ run_id: run.run_id, reason: 'ended without end_run' })).toMatchObject({ changed: true, status: 'failed' })
    expect(getRun(run.run_id)!.summary).toBe('ended without end_run')
  })

  it('set_goal_status pauses and resumes', async () => {
    const id = makeGoal()
    await set_goal_status({ goal_id: id, status: 'paused' })
    expect(getGoal(id)!.status).toBe('paused')
    await set_goal_status({ goal_id: id, status: 'active' })
    expect(getGoal(id)!.status).toBe('active')
  })
})

describe('guard_check', () => {
  it("applies the goal's autonomy to a run's tool call", async () => {
    const id = makeGoal()
    updateGoal(id, { tool_map: { 'mcp__gmail__delete': 'email.delete' } })
    const run = await claim(id)
    expect(await guard_check({ run_id: run.run_id, tool_name: 'mcp__gmail__delete' })).toMatchObject({ decision: 'deny', category: 'email.delete' })
    expect(await guard_check({ run_id: run.run_id, tool_name: 'Read' })).toMatchObject({ decision: 'allow' })
  })
})

describe('create_goal and delete_memory', () => {
  it('creates a goal in an existing directory, refusing a missing one', async () => {
    const { id } = await create_goal({ name: 'Profile', objective: 'Keep it current', working_dir: tmpdir() })
    expect(getGoal(id)).toMatchObject({ objective: 'Keep it current', status: 'active' })
    await expect(create_goal({ name: 'X', objective: 'Y', working_dir: '/no/such/dir/xyz' })).rejects.toThrow(/not found/)
  })

  it("deletes a goal's memory, and only from that goal", async () => {
    const id = makeGoal()
    const m = insertMemory({ plan_id: id, kind: 'fact', text: 'Bob is my manager', source: 'human' })
    await expect(delete_memory({ goal_id: 'other', memory_id: m.id })).rejects.toThrow(/not found/)
    expect(await delete_memory({ goal_id: id, memory_id: m.id })).toEqual({ deleted: m.id })
    expect(getMemory(m.id)).toBeUndefined()
  })
})

describe('set_schedule', () => {
  it('an interval makes a run due now, which the next tick claims', async () => {
    const id = makeGoal()
    const before = Date.now()
    const r = await set_schedule({ goal_id: id, schedule: { kind: 'interval', minutes: 360 } })
    expect(r.schedule).toEqual({ kind: 'interval', minutes: 360 })
    expect(Date.parse(r.next_run_at!)).toBeGreaterThanOrEqual(before - 1000)
    await new Promise((res) => setTimeout(res, 5))
    expect((await tick('session-A')).claimed.map((c) => [c.goal_id, c.trigger])).toEqual([[id, 'interval']])
    expect(Date.parse(getGoal(id)!.next_run_at!)).toBeGreaterThan(Date.now() + 359 * 60_000)
  })

  it('cron sets the next match; null clears it; a cron that never matches is refused', async () => {
    const id = makeGoal()
    const r = await set_schedule({ goal_id: id, schedule: { kind: 'cron', expr: '0 9 * * *' } })
    expect(new Date(r.next_run_at!).getHours()).toBe(9)
    expect(await set_schedule({ goal_id: id, schedule: null })).toMatchObject({ schedule: null, next_run_at: null })
    await expect(set_schedule({ goal_id: id, schedule: { kind: 'cron', expr: '0 9 31 2 *' } })).rejects.toThrow()
    await expect(set_schedule({ goal_id: id, schedule: { kind: 'interval', minutes: 2 } })).rejects.toThrow()
  })
})

describe('one-off goals and schedules at creation', () => {
  it('create_goal with a schedule makes a run due now; a one-off queues its run', async () => {
    const daily = await create_goal({ name: 'Inbox', objective: 'Triage', working_dir: tmpdir(), schedule: { kind: 'interval', minutes: 1440 } })
    expect(daily).toMatchObject({ schedule: { kind: 'interval', minutes: 1440 }, one_off: false, queued_run: null })
    expect(daily.next_run_at).not.toBeNull()
    const once = await create_goal({ name: 'Tidy', objective: 'Delete installers', working_dir: tmpdir(), one_off: true })
    expect(once).toMatchObject({ schedule: null, one_off: true, queued_run: expect.any(String) })
    expect(getGoal(once.id)!.one_off).toBe(true)
    await expect(create_goal({ name: 'X', objective: 'Y', working_dir: tmpdir(), one_off: true, schedule: { kind: 'interval', minutes: 60 } })).rejects.toThrow(/no schedule/)
  })

  it('set_schedule switches between one-off and recurring', async () => {
    const id = makeGoal()
    expect(await set_schedule({ goal_id: id, schedule: null, one_off: true })).toMatchObject({ one_off: true, schedule: null })
    expect(getGoal(id)!.one_off).toBe(true)
    expect(await set_schedule({ goal_id: id, schedule: { kind: 'interval', minutes: 60 } })).toMatchObject({ one_off: false })
    expect(getGoal(id)!.one_off).toBe(false)
  })

  it('run_goal runs a done one-off again', async () => {
    const { id } = await create_goal({ name: 'Tidy', objective: 'Delete installers', working_dir: tmpdir(), one_off: true })
    const run = (await tick('session-A')).claimed[0]!
    await withScope({ planId: id, runId: run.run_id }, () => end_run({ summary: 'Deleted 3.' }))
    expect(getGoal(id)!.status).toBe('retired')
    await run_goal({ goal_id: id })
    expect(getGoal(id)!.status).toBe('active')
  })
})

describe('update_goal and report_run_end', () => {
  it('update_goal applies confirmed changes and records them as the human\'s', async () => {
    const id = makeGoal()
    const r = await update_goal({ goal_id: id, autonomy: { 'email.send': 'auto' }, add_memory: [{ kind: 'rule', text: 'Never email the bank' }] })
    expect(r.changed).toEqual(['email.send: auto', 'remembered (rule): Never email the bank'])
    expect(getGoal(id)!.autonomy).toMatchObject({ 'email.send': 'auto' })
    expect(getEvents(id).find((e) => e.event_type === 'goal_updated')).toMatchObject({ actor: 'human' })
    await expect(update_goal({ goal_id: id, autonomy: { x: 'sometimes' } })).rejects.toThrow()
  })

  it('report_run_end skips a run that hit the usage limit and holds goal runs', async () => {
    const id = makeGoal()
    const run = await claim(id)
    expect(await report_run_end({ run_id: run.run_id, answer: 'All good so far.' })).toEqual({ outcome: 'unchanged' })
    const held = await report_run_end({ run_id: run.run_id, answer: "You've hit your 5-hour limit" })
    expect(held).toMatchObject({ outcome: 'held', hold: { reason: "You've hit your 5-hour limit" } })
    expect(getRun(run.run_id)!.status).toBe('skipped')
    queueRun(id)
    expect(await tick('session-A')).toMatchObject({ claimed: [], hold: expect.anything() })
  })
})

describe('create_goal with autonomy and tool rules', () => {
  it('stores them, so a template\'s approvals work from the first run', async () => {
    const r = await create_goal({
      name: 'Inbox', objective: 'triage', working_dir: process.cwd(),
      autonomy: { 'email.send': 'off' }, tool_map: { 'mcp__*Gmail*__send_message': 'email.send' },
    })
    expect(getGoal(r.id)).toMatchObject({ autonomy: { 'email.send': 'off' }, tool_map: { 'mcp__*Gmail*__send_message': 'email.send' } })
  })
})
