import { describe, it, expect, vi } from 'vitest'


import { NextRequest } from 'next/server'
import { tmpdir } from 'os'
import { GET as GETGoals, POST as POSTGoal } from '@/app/api/goals/route.js'
import { GET as GETGoal, PATCH as PATCHGoal } from '@/app/api/goals/[id]/route.js'
import { POST as POSTRun } from '@/app/api/goals/[id]/run/route.js'
import { POST as POSTMemory } from '@/app/api/goals/[id]/memory/route.js'
import { PATCH as PATCHMemory, DELETE as DELETEMemory } from '@/app/api/goals/[id]/memory/[memoryId]/route.js'
import { POST as POSTApprove } from '@/app/api/goals/[id]/items/[itemId]/approve/route.js'
import { POST as POSTReject } from '@/app/api/goals/[id]/items/[itemId]/reject/route.js'
import { getDb, getOpenRun, getTask, getGoal, getIntervalTrigger, insertPlan } from '@/lib/db'
import * as core from '@quarterdeck/core'

function req(method: string, body?: unknown) {
  return new NextRequest('http://localhost/api/x', { method, headers: body ? { 'Content-Type': 'application/json' } : {}, body: body ? JSON.stringify(body) : undefined })
}
const p = <T extends Record<string, string> = Record<never, string>>(id: string, extra?: T) =>
  ({ params: Promise.resolve({ id, ...extra } as { id: string } & T) })

async function createGoal(body: Record<string, unknown> = {}) {
  const res = await POSTGoal(req('POST', { name: 'Inbox', objective: 'Inbox zero', working_dir: tmpdir(), ...body }))
  return { status: res.status, body: await res.json() }
}

describe('goals API', () => {
  it('creates a goal and lists it, not among plans', async () => {
    const { status, body } = await createGoal({ interval_minutes: 30, active_hours: '08:00-20:00', autonomy: { 'email.archive': 'auto' } })
    expect(status).toBe(201)
    expect(getIntervalTrigger(body.id)!.config).toEqual({ minutes: 30, active_hours: '08:00-20:00' })
    expect(getGoal(body.id)!.autonomy).toEqual({ 'email.archive': 'auto' })

    insertPlan({ id: 'plan_ordinary', name: 'Ordinary plan', description: null, status: 'active', working_dir: tmpdir(), created_at: new Date().toISOString(), updated_at: new Date().toISOString() })
    const goals = await (await GETGoals(new NextRequest('http://localhost/api/goals'))).json()
    expect(goals).toEqual([expect.objectContaining({ id: body.id, name: 'Inbox', open_items: 0, needs_you: 0 })])
  })

  it('validates input', async () => {
    expect((await createGoal({ objective: '' })).status).toBe(400)
    expect((await createGoal({ working_dir: '/definitely/missing' })).body.error).toMatch(/not found/)
    expect((await createGoal({ interval_minutes: 30, active_hours: '8-20' })).status).toBe(400)
  })

  it('GET returns the goal page data, with proposals under needs_you', async () => {
    const { body: { id } } = await createGoal()
    core.addItem(getDb(), id, null, { goal: 'Reply to Alice', action: { category: 'email.send', summary: 'send' } })
    core.addItem(getDb(), id, null, { goal: 'Invoice', external_ref: 'gmail:1' })
    const data = await (await GETGoal(req('GET'), p(id))).json()
    expect(data.goal.objective).toBe('Inbox zero')
    expect(data.needs_you).toEqual([expect.objectContaining({ goal: 'Reply to Alice', awaiting_review: true, action: expect.objectContaining({ category: 'email.send' }) })])
    expect(data.open_items).toEqual([expect.objectContaining({ goal: 'Invoice', external_ref: 'gmail:1' })])
  })

  it('PATCH pauses, resumes (due now) and changes the schedule', async () => {
    const { body: { id } } = await createGoal({ interval_minutes: 30 })
    await PATCHGoal(req('PATCH', { status: 'paused' }), p(id))
    expect(getGoal(id)!.status).toBe('paused')
    core.updateGoal(getDb(), id, { next_run_at: '2099-01-01T00:00:00.000Z' })
    await PATCHGoal(req('PATCH', { status: 'active' }), p(id))
    expect(getGoal(id)!.next_run_at! < '2099').toBe(true)
    await PATCHGoal(req('PATCH', { interval: null }), p(id))
    expect(getIntervalTrigger(id)).toBeUndefined()
    expect(getGoal(id)!.next_run_at).toBeNull()
    const res = await PATCHGoal(req('PATCH', { limits: { max_run_minutes: 0 } }), p(id))
    expect(res.status).toBe(400)
  })

  it('Run now queues a run for the plugin to start; refuses paused goals', async () => {
    const { body: { id } } = await createGoal()
    const res = await POSTRun(req('POST'), p(id))
    expect(res.status).toBe(202)
    expect(getOpenRun(id)!.status).toBe('queued')
    core.updateRun(getDb(), getOpenRun(id)!.id, { status: 'completed' })
    await PATCHGoal(req('PATCH', { status: 'paused' }), p(id))
    expect((await POSTRun(req('POST'), p(id))).status).toBe(409)
  })

  it('memory can be added, edited and deleted by the human', async () => {
    const { body: { id } } = await createGoal()
    const { memory } = await (await POSTMemory(req('POST', { kind: 'rule', text: 'Never archive the bank.' }), p(id))).json()
    expect(memory).toMatchObject({ source: 'human', text: 'Never archive the bank.' })
    await PATCHMemory(req('PATCH', { pinned: true, text: 'Never archive mail from the bank.' }), p(id, { memoryId: memory.id }))
    const data = await (await GETGoal(req('GET'), p(id))).json()
    expect(data.memory[0]).toMatchObject({ pinned: true, text: 'Never archive mail from the bank.' })
    await DELETEMemory(req('DELETE'), p(id, { memoryId: memory.id }))
    expect((await (await GETGoal(req('GET'), p(id))).json()).memory).toEqual([])
    expect((await POSTMemory(req('POST', { kind: 'rule', text: ' ' }), p(id))).status).toBe(400)
  })

  it('approving a proposal keeps it active and queues a run; rejecting adds memory', async () => {
    const { body: { id } } = await createGoal()
    const a = core.addItem(getDb(), id, null, { goal: 'Reply A', action: { category: 'email.send', summary: 'send A' } }).task
    const b = core.addItem(getDb(), id, null, { goal: 'Reply B', action: { category: 'email.send', summary: 'send B' } }).task

    await POSTApprove(req('POST'), p(id, { itemId: a.id }))
    expect(getTask(id, a.id)).toMatchObject({ status: 'active', review_requested_at: null })
    expect(getOpenRun(id)!.status).toBe('queued')

    await POSTReject(req('POST', { feedback: 'Too formal.' }), p(id, { itemId: b.id }))
    const data = await (await GETGoal(req('GET'), p(id))).json()
    expect(data.memory).toEqual([expect.objectContaining({ source: 'feedback', text: expect.stringContaining('Too formal.') })])
    expect(data.approval_stats).toEqual({ 'email.send': { approved: 1, rejected: 1 } })
    expect(data.open_items.find((i: { id: string }) => i.id === a.id)).toMatchObject({ approved_to_execute: true })
  })
})
