import { describe, it, expect, afterEach } from 'vitest'
import { next_task } from '../../tools/next_task.js'
import { create_plan } from '../../tools/create_plan.js'
import { provision_tasks } from '../../tools/provision_tasks.js'
import { set_status } from '../../tools/set_status.js'

type Spec = { goal: string; status?: 'active' | 'pending'; depends_on?: string[] }

async function plan(tasks: Record<string, Spec>) {
  await create_plan({ name: 'Test' })
  await provision_tasks({ tasks })
}

describe('next_task', () => {
  afterEach(() => { delete process.env.CONDUCTOR_REQUIRE_DECOMPOSE })

  it('throws when no plan is open', async () => {
    await expect(next_task({})).rejects.toThrow('No plan is open')
  })

  it('reports an empty plan', async () => {
    await create_plan({ name: 'Test' })
    const r = await next_task({})
    expect(r.action).toBe('none')
    expect(r.message).toMatch(/no tasks yet/)
  })

  it('returns the first pending leaf in tree order, not the parent', async () => {
    await plan({ '1': { goal: 'root' }, '1.1': { goal: 'a' }, '1.2': { goal: 'b' } })
    const r = await next_task({})
    expect(r).toMatchObject({ action: 'start', task_id: '1.1' })
    expect(r.context?.focus.id).toBe('1.1')
  })

  it('prefers continuing an active task over starting a later one', async () => {
    await plan({ '1': { goal: 'root' }, '1.1': { goal: 'a' }, '1.2': { goal: 'b', status: 'active' } })
    await set_status({ task_id: '1.1', status: 'completed' })
    expect(await next_task({})).toMatchObject({ action: 'continue', task_id: '1.2' })
  })

  it('skips tasks whose dependencies are unmet', async () => {
    await plan({
      '1': { goal: 'root' },
      '1.1': { goal: 'a', status: 'active' },
      '1.2': { goal: 'b', depends_on: ['1.1'] },
      '1.3': { goal: 'c' },
    })
    await set_status({ task_id: '1.1', status: 'abandoned', reason: 'dead end' })
    expect(await next_task({})).toMatchObject({ action: 'start', task_id: '1.3' })
  })

  it('orders 1.10 after 1.9', async () => {
    const tasks: Record<string, Spec> = { '1': { goal: 'root' } }
    for (let i = 1; i <= 10; i++) tasks[`1.${i}`] = { goal: `t${i}` }
    await plan(tasks)
    for (let i = 1; i <= 9; i++) await set_status({ task_id: `1.${i}`, status: 'abandoned', reason: 'skip' })
    expect(await next_task({})).toMatchObject({ action: 'start', task_id: '1.10' })
  })

  it('returns complete for a parent whose children are all resolved', async () => {
    await plan({ '1': { goal: 'root', status: 'active' }, '1.1': { goal: 'a' }, '1.2': { goal: 'b' } })
    await set_status({ task_id: '1.1', status: 'completed' })
    await set_status({ task_id: '1.2', status: 'abandoned', reason: 'n/a' })
    const r = await next_task({})
    expect(r).toMatchObject({ action: 'complete', task_id: '1' })
    expect(r.hint).toMatch(/synthesize/)
  })

  it('reports blockers when nothing is ready', async () => {
    await plan({ '1': { goal: 'root' }, '1.1': { goal: 'a', status: 'active' }, '1.2': { goal: 'b', depends_on: ['1.1'] } })
    await set_status({ task_id: '1.1', status: 'abandoned', reason: 'dead end' })
    const r = await next_task({})
    expect(r.action).toBe('none')
    expect(r.blocked).toEqual([{ id: '1.2', goal: 'b', waiting_on: [{ id: '1.1', status: 'abandoned' }] }])
  })

  it('reports when everything is done', async () => {
    await plan({ '1': { goal: 'root' } })
    await set_status({ task_id: '1', status: 'completed' })
    const r = await next_task({})
    expect(r.action).toBe('none')
    expect(r.message).toMatch(/archive_plan/)
  })

  it('hints to decompose when CONDUCTOR_REQUIRE_DECOMPOSE=1 and the leaf is not atomic', async () => {
    process.env.CONDUCTOR_REQUIRE_DECOMPOSE = '1'
    await plan({ '1': { goal: 'root' } })
    const r = await next_task({})
    expect(r.action).toBe('start')
    expect(r.hint).toMatch(/provision_tasks/)
  })
})
