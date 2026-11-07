import { describe, it, expect } from 'vitest'
import { NextRequest } from 'next/server'
import { tmpdir } from 'os'
import { POST as POSTPlan } from '@/app/api/plans/route.js'
import { POST as POSTTask } from '@/app/api/plans/[id]/tasks/route.js'
import { GET as GETTask, PATCH as PATCHTask } from '@/app/api/plans/[id]/tasks/[taskId]/route.js'
import { POST as POSTStatus } from '@/app/api/plans/[id]/tasks/[taskId]/status/route.js'
import { POST as POSTVerify } from '@/app/api/plans/[id]/tasks/[taskId]/verify/route.js'
import { POST as POSTApprove } from '@/app/api/plans/[id]/tasks/[taskId]/approve/route.js'
import { POST as POSTReject } from '@/app/api/plans/[id]/tasks/[taskId]/reject/route.js'
import { POST as POSTOverride } from '@/app/api/plans/[id]/tasks/[taskId]/override/route.js'
import { getTask, updateTask, getEvents } from '@/lib/db.js'

const PASS = 'node -e "process.exit(0)"'
const FAIL = 'node -e "console.log(\'lint errors\'); process.exit(2)"'

function req(method: string, body?: unknown) {
  return new NextRequest('http://localhost/api/x', {
    method,
    headers: body ? { 'Content-Type': 'application/json' } : {},
    body: body ? JSON.stringify(body) : undefined,
  })
}
const p = (id: string, taskId = '1') => ({ params: Promise.resolve({ id, taskId }) })

async function setup(gates: Record<string, unknown> = {}) {
  const plan = await (await POSTPlan(req('POST', { name: 'Gates', working_dir: tmpdir() }))).json() as { id: string }
  await POSTTask(req('POST', { goal: 'root', status: 'active' }), { params: Promise.resolve({ id: plan.id }) })
  if (Object.keys(gates).length) await PATCHTask(req('PATCH', gates), p(plan.id))
  return plan.id
}

const complete = (planId: string) => POSTStatus(req('POST', { status: 'completed' }), p(planId))

describe('verification gates (web API)', () => {
  it('PATCH sets gates and GET returns gate status and history', async () => {
    const planId = await setup({ acceptance_criteria: ['works'], verify_command: PASS, requires_approval: true })
    const body = await (await GETTask(req('GET'), p(planId))).json()
    expect(body.gates).toMatchObject({ acceptance_criteria: ['works'], verify_command: PASS, requires_approval: true })
    expect(body.verifications).toEqual([])
  })

  it('completing runs the verify command and returns 409 with output when it fails', async () => {
    const planId = await setup({ verify_command: FAIL })
    const res = await complete(planId)
    expect(res.status).toBe(409)
    const body = await res.json()
    expect(body.can_override).toBe(true)
    expect(body.blockers[0]).toMatchObject({ gate: 'command', exit_code: 2 })
    expect(body.blockers[0].output).toContain('lint errors')
    expect(getTask(planId, '1')!.status).toBe('active')
    expect(getEvents(planId).map((e) => e.event_type)).toContain('verification_failed')
  })

  it('a human completing does not need criteria evidence and counts as approval', async () => {
    const planId = await setup({ acceptance_criteria: ['works'], verify_command: PASS, requires_approval: true })
    expect((await complete(planId)).status).toBe(200)
    expect(getTask(planId, '1')).toMatchObject({ status: 'completed', approved_by: 'human' })
  })

  it('verify runs checks without completing', async () => {
    const planId = await setup({ verify_command: FAIL })
    const body = await (await POSTVerify(req('POST'), p(planId))).json()
    expect(body.result).toMatchObject({ passed: false, exit_code: 2 })
    expect(body.gates.last_command).toMatchObject({ passed: false })
    expect(getTask(planId, '1')!.status).toBe('active')
  })

  it('verify returns 400 when there is no command', async () => {
    const planId = await setup()
    expect((await POSTVerify(req('POST'), p(planId))).status).toBe(400)
  })

  it('override completes despite a failing command and keeps the reason', async () => {
    const planId = await setup({ verify_command: FAIL })
    expect((await POSTOverride(req('POST', { reason: '' }), p(planId))).status).toBe(400)
    expect((await POSTOverride(req('POST', { reason: 'known flaky lint rule' }), p(planId))).status).toBe(200)
    expect(getTask(planId, '1')!.status).toBe('completed')
    const body = await (await GETTask(req('GET'), p(planId))).json()
    expect(body.verifications[0]).toMatchObject({ gate: 'override', output: 'known flaky lint rule' })
  })

  describe('review', () => {
    async function awaitingReview() {
      const planId = await setup({ requires_approval: true })
      updateTask(planId, '1', { review_requested_at: new Date().toISOString() })
      return planId
    }

    it('approve completes the task', async () => {
      const planId = await awaitingReview()
      expect((await POSTApprove(req('POST'), p(planId))).status).toBe(200)
      expect(getTask(planId, '1')).toMatchObject({ status: 'completed', review_requested_at: null })
      expect(getEvents(planId)[0].event_type).toBe('approval_granted')
    })

    it('reject sends it back with feedback and requires feedback', async () => {
      const planId = await awaitingReview()
      expect((await POSTReject(req('POST', { feedback: ' ' }), p(planId))).status).toBe(400)
      expect((await POSTReject(req('POST', { feedback: 'add tests' }), p(planId))).status).toBe(200)
      const t = getTask(planId, '1')!
      expect(t).toMatchObject({ status: 'active', review_requested_at: null })
      expect(t.notes).toContain('add tests')
    })

    it('approve/reject return 409 when the task is not waiting for review', async () => {
      const planId = await setup({ requires_approval: true })
      expect((await POSTApprove(req('POST'), p(planId))).status).toBe(409)
      expect((await POSTReject(req('POST', { feedback: 'x' }), p(planId))).status).toBe(409)
    })

    it('turning approval off releases a waiting task', async () => {
      const planId = await awaitingReview()
      await PATCHTask(req('PATCH', { requires_approval: false }), p(planId))
      expect(getTask(planId, '1')!.review_requested_at).toBeNull()
    })
  })
})
