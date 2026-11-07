import { describe, it, expect, vi } from 'vitest'

vi.mock('@/lib/goal-scheduler', () => ({ kickScheduler: vi.fn() }))

import { NextRequest } from 'next/server'
import { tmpdir } from 'os'
import { POST as POSTGoal } from '@/app/api/goals/route.js'
import { PATCH as PATCHGoal } from '@/app/api/goals/[id]/route.js'
import { POST as POSTMemory } from '@/app/api/goals/[id]/memory/route.js'
import { GET as GETOverview } from '@/app/api/goals/overview/route.js'
import { getDb } from '@/lib/db'
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
