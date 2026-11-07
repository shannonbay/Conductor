import { describe, it, expect } from 'vitest'
import { tmpdir } from 'os'
import { create_plan } from '../../tools/create_plan.js'
import { create_task } from '../../tools/create_task.js'
import { provision_tasks } from '../../tools/provision_tasks.js'
import { update_task } from '../../tools/update_task.js'
import { set_status } from '../../tools/set_status.js'
import { verify_task } from '../../tools/verify_task.js'
import { next_task } from '../../tools/next_task.js'
import { get_context } from '../../tools/get_context.js'
import { get_history } from '../../tools/get_history.js'
import { getTask } from '../../db.js'
import { getOpenPlan } from '../../session.js'

const PASS = 'node -e "process.exit(0)"'
const FAIL = 'node -e "console.log(\'2 tests failed\'); process.exit(1)"'

const task = (id: string) => getTask(getOpenPlan()!, id)!
const plan = () => create_plan({ name: 'Gates', working_dir: tmpdir() })

describe('verification gates (MCP)', () => {
  it('stores gates from create_task and shows them in get_context', async () => {
    await plan()
    await create_task({ goal: 'root', acceptance_criteria: ['returns 401'], verify_command: PASS, requires_approval: true })
    expect(task('1')).toMatchObject({ acceptance_criteria: ['returns 401'], verify_command: PASS, requires_approval: true })
    const ctx = await get_context({ task_id: '1' }) as { gates?: unknown }
    expect(ctx.gates).toMatchObject({ acceptance_criteria: ['returns 401'], verify_command: PASS, requires_approval: true, awaiting_review: false })
  })

  it('stores gates from provision_tasks', async () => {
    await plan()
    await provision_tasks({ tasks: { '1': { goal: 'root' }, '1.1': { goal: 'a', verify_command: PASS, verify_timeout_s: 30 } } })
    expect(task('1.1')).toMatchObject({ verify_command: PASS, verify_timeout_s: 30 })
  })

  it('omits gates from get_context for ungated tasks', async () => {
    await plan()
    await create_task({ goal: 'root' })
    expect(await get_context({ task_id: '1' })).not.toHaveProperty('gates')
  })

  describe('update_task', () => {
    it('allows gate changes while pending', async () => {
      await plan()
      await create_task({ goal: 'root', status: 'pending' })
      await update_task({ task_id: '1', verify_command: PASS, acceptance_criteria: ['a'] })
      expect(task('1')).toMatchObject({ verify_command: PASS, acceptance_criteria: ['a'] })
    })

    it('refuses to change or remove gates once the task has started', async () => {
      await plan()
      await create_task({ goal: 'root', verify_command: FAIL })
      await expect(update_task({ task_id: '1', verify_command: null })).rejects.toThrow(/only be changed while the task is pending/)
      await expect(update_task({ task_id: '1', acceptance_criteria: [] })).rejects.toThrow(/acceptance_criteria/)
      expect(task('1').verify_command).toBe(FAIL)
    })

    it('still allows adding approval after the task has started', async () => {
      await plan()
      await create_task({ goal: 'root' })
      await update_task({ task_id: '1', requires_approval: true })
      expect(task('1').requires_approval).toBe(true)
      await expect(update_task({ task_id: '1', requires_approval: false })).rejects.toThrow(/requires_approval/)
    })
  })

  describe('set_status completed', () => {
    it('refuses without evidence for every criterion', async () => {
      await plan()
      await create_task({ goal: 'root', acceptance_criteria: ['a', 'b'] })
      await expect(set_status({ task_id: '1', status: 'completed', evidence: ['only a'] })).rejects.toThrow(/Missing evidence for 1 of 2.*"b"/)
      expect(task('1').status).toBe('active')
    })

    it('refuses when the verify command fails, showing its output', async () => {
      await plan()
      await create_task({ goal: 'root', verify_command: FAIL })
      await expect(set_status({ task_id: '1', status: 'completed' })).rejects.toThrow(/verification failed[\s\S]*exit 1[\s\S]*2 tests failed/)
      expect(task('1').status).toBe('active')
    })

    it('completes when evidence is given and the command passes', async () => {
      await plan()
      await create_task({ goal: 'root', acceptance_criteria: ['a'], verify_command: PASS })
      await set_status({ task_id: '1', status: 'completed', evidence: ['done in x.ts'], result: 'ok' })
      expect(task('1')).toMatchObject({ status: 'completed', result: 'ok' })
    })

    it('waits for review when approval is required, keeping the result', async () => {
      await plan()
      await create_task({ goal: 'root', requires_approval: true })
      const r = await set_status({ task_id: '1', status: 'completed', result: 'built it' }) as { awaiting_review?: boolean; message?: string }
      expect(r.awaiting_review).toBe(true)
      expect(r.message).toMatch(/waiting for a human/)
      expect(task('1')).toMatchObject({ status: 'active', result: 'built it' })
      expect(task('1').review_requested_at).not.toBeNull()
    })

    it('abandoning a task cancels its review request', async () => {
      await plan()
      await create_task({ goal: 'root', requires_approval: true })
      await set_status({ task_id: '1', status: 'completed' })
      await set_status({ task_id: '1', status: 'abandoned', reason: 'not needed' })
      expect(task('1')).toMatchObject({ status: 'abandoned', review_requested_at: null })
    })

    it('records verification events in the history', async () => {
      await plan()
      await create_task({ goal: 'root', verify_command: FAIL })
      await set_status({ task_id: '1', status: 'completed' }).catch(() => {})
      const types = (await get_history({})).events.map((e) => e.type)
      expect(types[0]).toBe('verification_failed')
    })
  })

  describe('verify_task', () => {
    it('runs the command without completing', async () => {
      await plan()
      await create_task({ goal: 'root', verify_command: FAIL })
      const r = await verify_task({ task_id: '1' })
      expect(r.check).toMatchObject({ passed: false, exit_code: 1 })
      expect(r.check?.output).toContain('2 tests failed')
      expect(task('1').status).toBe('active')
    })

    it('explains when there is nothing to run', async () => {
      await plan()
      await create_task({ goal: 'root' })
      expect((await verify_task({ task_id: '1' })).message).toMatch(/no verification gates/)
    })
  })

  describe('next_task', () => {
    it('says fix after a failed check', async () => {
      await plan()
      await create_task({ goal: 'root', verify_command: FAIL })
      await verify_task({ task_id: '1' })
      const r = await next_task({})
      expect(r).toMatchObject({ action: 'fix', task_id: '1' })
      expect(r.hint).toMatch(/failed/)
    })

    it('skips tasks waiting for review and lists them', async () => {
      await plan()
      await provision_tasks({ tasks: { '1': { goal: 'root', status: 'active' }, '1.1': { goal: 'a', status: 'active', requires_approval: true }, '1.2': { goal: 'b' } } })
      await set_status({ task_id: '1.1', status: 'completed' })
      expect(await next_task({})).toMatchObject({ action: 'start', task_id: '1.2' })
      await set_status({ task_id: '1.2', status: 'abandoned', reason: 'skip' })
      const r = await next_task({})
      expect(r.action).toBe('none')
      expect(r.awaiting_review).toEqual([expect.objectContaining({ id: '1.1' })])
      expect(r.message).toMatch(/waiting for a human/)
    })

    it('mentions gates in the hint', async () => {
      await plan()
      await create_task({ goal: 'root', status: 'pending', acceptance_criteria: ['a', 'b'], verify_command: PASS })
      expect((await next_task({})).hint).toMatch(/2 acceptance criteria[\s\S]*verify_task/)
    })
  })
})
