import { describe, it, expect, vi } from 'vitest'

vi.mock('@/lib/goal-scheduler', () => ({ kickScheduler: vi.fn() }))

import { NextRequest } from 'next/server'
import { tmpdir } from 'os'
import { POST as POSTGoal } from '@/app/api/goals/route.js'
import { PATCH as PATCHGoal } from '@/app/api/goals/[id]/route.js'
import { POST as POSTMemory } from '@/app/api/goals/[id]/memory/route.js'
import { GET as GETOverview } from '@/app/api/goals/overview/route.js'
import { getDb, approveTask } from '@/lib/db'
import * as core from '@conductor/core'

function req(method: string, body?: unknown, headers: Record<string, string> = {}) {
  return new NextRequest('http://localhost/api/x', {
    method,
    headers: { ...headers, ...(body ? { 'Content-Type': 'application/json' } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  })
}
const p = (id: string) => ({ params: Promise.resolve({ id }) })

async function createGoal(name: string) {
  const res = await POSTGoal(req('POST', { name, objective: `${name} objective`, working_dir: tmpdir() }))
  return (await res.json()).id as string
}

describe('GET /api/goals/overview', () => {
  it('returns each live goal with what the pane needs', async () => {
    const id = await createGoal('Inbox')
    core.addItem(getDb(), id, null, { goal: 'Reply to Alice', action: { category: 'email.send', summary: 'send it' } })
    core.addItem(getDb(), id, null, { goal: 'Invoice', external_ref: 'gmail:1' })
    await POSTMemory(req('POST', { text: 'Alice prefers short replies', kind: 'preference' }), p(id))
    const run = core.queueRun(getDb(), id)
    core.startRun(getDb(), run.id, null)
    core.endRun(getDb(), run.id, 'Triaged 3 emails')

    const res = await GETOverview(req('GET'))
    expect(res.status).toBe(200)
    expect(res.headers.get('etag')).toMatch(/^".+"$/)
    const { goals } = await res.json()
    expect(goals).toHaveLength(1)
    expect(goals[0]).toEqual(expect.objectContaining({
      id, name: 'Inbox', objective: 'Inbox objective', status: 'active', open_run: null, open_item_count: 1,
    }))
    expect(goals[0].needs_you).toEqual([expect.objectContaining({ goal: 'Reply to Alice', action: expect.objectContaining({ category: 'email.send' }) })])
    expect(goals[0].open_items).toEqual([expect.objectContaining({ goal: 'Invoice' })])
    expect(goals[0].runs).toEqual([expect.objectContaining({ id: run.id, status: 'completed', summary: 'Triaged 3 emails' })])
    expect(goals[0].memory).toEqual([expect.objectContaining({ text: 'Alice prefers short replies', kind: 'preference' })])
    expect(goals[0]).toHaveProperty('health')
    expect(goals[0]).toHaveProperty('suggestions')
  })

  it('leaves out retired goals and sorts by name', async () => {
    await createGoal('Zeta')
    await createGoal('Alpha')
    const retired = await createGoal('Old')
    await PATCHGoal(req('PATCH', { status: 'retired' }), p(retired))
    const { goals } = await (await GETOverview(req('GET'))).json()
    expect(goals.map((g: { name: string }) => g.name)).toEqual(['Alpha', 'Zeta'])
  })

  describe('activity', () => {
    const at = (iso: string, ms: number) => new Date(Date.parse(iso) + ms).toISOString()
    let n = 0
    const event = (planId: string, event_type: string, payload: Record<string, unknown>, created_at: string, task_id = planId, actor: 'agent' | 'human' = 'agent') =>
      core.insertEvent(getDb(), { id: `e${++n}`, plan_id: planId, task_id, event_type, actor, payload, created_at })
    const activityOf = async (id: string) =>
      ((await (await GETOverview(req('GET'))).json()).goals as { id: string; activity: unknown }[]).find((g) => g.id === id)!.activity

    it("while running, shows the agent's newest step since the run started", async () => {
      const id = await createGoal('Inbox')
      const run = core.startRun(getDb(), core.queueRun(getDb(), id).id, null)
      expect(await activityOf(id)).toEqual({ state: 'running', text: 'Starting: reading the brief', at: run.started_at })

      event(id, 'agent_message', { message: 'From an earlier run' }, at(run.started_at, -60_000))
      const item = core.addItem(getDb(), id, run.id, { goal: 'Reply to Alice', action: { category: 'email.send', summary: 's' } }).task
      event(id, 'task_created', { goal: 'Reply to Alice', mode: 'propose' }, at(run.started_at, 1_000), item.id)
      expect(await activityOf(id)).toEqual({ state: 'running', text: 'Added "Reply to Alice" for approval', at: at(run.started_at, 1_000) })

      event(id, 'status_changed', { from: 'pending', to: 'completed' }, at(run.started_at, 2_000), item.id)
      expect(await activityOf(id)).toMatchObject({ text: 'Completed "Reply to Alice"' })

      event(id, 'tool_call', { tool: 'Bash' }, at(run.started_at, 2_500), id, 'human') // not the agent: skipped
      event(id, 'agent_message', { message: 'Checking   the\nnewsletter folder' }, at(run.started_at, 3_000))
      expect(await activityOf(id)).toMatchObject({ text: 'Checking the newsletter folder', at: at(run.started_at, 3_000) })
    })

    it('says when a run is queued, the goal is paused, or what comes next', async () => {
      const id = await createGoal('Inbox')
      expect(await activityOf(id)).toEqual({ state: 'idle', text: 'Waiting for its first run', at: null })

      const run = core.startRun(getDb(), core.queueRun(getDb(), id).id, null)
      core.endRun(getDb(), run.id, 'Triaged 3 emails')
      expect(await activityOf(id)).toMatchObject({ state: 'idle', text: 'Last run: Triaged 3 emails' })

      const a = core.addItem(getDb(), id, null, { goal: 'Reply to Alice', action: { category: 'email.send', summary: 's' } }).task
      const b = core.addItem(getDb(), id, null, { goal: 'Archive newsletter', action: { category: 'email.archive', summary: 's' } }).task
      approveTask(id, a.id)
      approveTask(id, b.id)
      expect(await activityOf(id)).toMatchObject({ state: 'idle', text: 'Next run carries out "Reply to Alice" and 1 more' })

      await PATCHGoal(req('PATCH', { status: 'paused' }), p(id))
      expect(await activityOf(id)).toMatchObject({ state: 'paused', text: 'Paused' })

      await PATCHGoal(req('PATCH', { status: 'active' }), p(id))
      core.queueRun(getDb(), id)
      expect(await activityOf(id)).toMatchObject({ state: 'queued', text: 'Queued (manual) — starts within a minute while Claude Code is open' })
    })
  })

  it('answers 304 with no body while nothing changed, and 200 once something did', async () => {
    const id = await createGoal('Inbox')
    const etag = (await GETOverview(req('GET'))).headers.get('etag')!

    const same = await GETOverview(req('GET', undefined, { 'If-None-Match': etag }))
    expect(same.status).toBe(304)
    expect(await same.text()).toBe('')

    core.addItem(getDb(), id, null, { goal: 'New proposal', action: { category: 'email.send', summary: 's' } })
    const changed = await GETOverview(req('GET', undefined, { 'If-None-Match': etag }))
    expect(changed.status).toBe(200)
    expect(changed.headers.get('etag')).not.toBe(etag)
  })
})
