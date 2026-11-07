import { describe, it, expect } from 'vitest'
import { get_history } from '../../tools/get_history.js'
import { create_plan } from '../../tools/create_plan.js'
import { create_task } from '../../tools/create_task.js'
import { provision_tasks } from '../../tools/provision_tasks.js'
import { update_task } from '../../tools/update_task.js'
import { set_status } from '../../tools/set_status.js'
import { archive_plan } from '../../tools/archive_plan.js'
import { open_plan } from '../../tools/open_plan.js'
import { insertEvent } from '../../db.js'
import { getOpenPlan } from '../../session.js'

describe('get_history', () => {
  it('throws when no plan is open', async () => {
    await expect(get_history({})).rejects.toThrow('No plan is open')
  })

  it('records MCP changes as agent events, newest first', async () => {
    await create_plan({ name: 'Test' })
    await create_task({ goal: 'root' })
    await set_status({ task_id: '1', status: 'completed', result: 'done' })

    const h = await get_history({})
    expect(h.events.map((e) => e.type)).toEqual(['status_changed', 'task_created', 'plan_created'])
    expect(h.events.every((e) => e.actor === 'agent' && e.via === 'mcp')).toBe(true)
    expect(h.events[0]).toMatchObject({
      task_id: '1',
      details: { from: 'active', to: 'completed', result: 'done', previous_result: null },
    })
    expect(h.events[2].task_id).toBeNull() // plan-level event
  })

  it('records old and new values for update_task', async () => {
    await create_plan({ name: 'Test' })
    await create_task({ goal: 'root', status: 'pending', initial_state: { n: 1 } })
    await update_task({ task_id: '1', goal: 'renamed', notes: 'hi', state_patch: { n: 2, m: 3 } })

    const [e] = (await get_history({ limit: 1 })).events
    expect(e).toMatchObject({
      type: 'task_updated',
      details: {
        fields: ['goal', 'notes', 'state'],
        before: { goal: 'root', notes: null, state: { n: 1, m: null } },
        after: { goal: 'renamed', notes: 'hi', state: { n: 2, m: 3 } },
      },
    })
  })

  it('does not record no-op updates', async () => {
    await create_plan({ name: 'Test' })
    await create_task({ goal: 'root' })
    await update_task({ task_id: '1' })
    expect((await get_history({})).events.map((e) => e.type)).not.toContain('task_updated')
  })

  it('filters to a task and its sub-tasks', async () => {
    await create_plan({ name: 'Test' })
    await provision_tasks({ tasks: { '1': { goal: 'root' }, '1.1': { goal: 'a' }, '1.1.1': { goal: 'a1' }, '1.2': { goal: 'b' } } })
    const ids = (await get_history({ task_id: '1.1' })).events.map((e) => e.task_id).sort()
    expect(ids).toEqual(['1.1', '1.1.1'])
  })

  it('records archive and restore', async () => {
    const plan = await create_plan({ name: 'Test' })
    await archive_plan({ plan_id: plan.id })
    await open_plan({ plan_id: plan.id })
    const types = (await get_history({})).events.map((e) => e.type)
    expect(types.slice(0, 2)).toEqual(['plan_restored', 'plan_archived'])
  })

  it('includes changes made in the web UI', async () => {
    await create_plan({ name: 'Test' })
    await create_task({ goal: 'root' })
    insertEvent({ id: 'ui1', plan_id: getOpenPlan()!, task_id: '1', event_type: 'task_updated', actor: 'human', payload: { changes: ['notes'] } })
    const [e] = (await get_history({ limit: 1 })).events
    expect(e).toMatchObject({ actor: 'human', via: 'ui', type: 'task_updated', details: { changes: ['notes'] } })
  })

  it('respects limit', async () => {
    await create_plan({ name: 'Test' })
    await create_task({ goal: 'root' })
    expect((await get_history({ limit: 1 })).count).toBe(1)
  })
})
