import { describe, it, expect } from 'vitest'
import { synthesize } from '../../tools/synthesize.js'
import { create_plan } from '../../tools/create_plan.js'
import { create_task } from '../../tools/create_task.js'
import { set_status } from '../../tools/set_status.js'
import { update_task } from '../../tools/update_task.js'

describe('synthesize', () => {
  it('throws when no project is open', async () => {
    await expect(synthesize({ task_id: '1' })).rejects.toThrow('No plan is open')
  })

  it('throws for unknown task_id', async () => {
    await create_plan({ name: 'Test' })
    await create_task({ goal: 'root' })
    await expect(synthesize({ task_id: '99' })).rejects.toThrow('not found')
  })

  it('groups children into completed, abandoned, pending', async () => {
    await create_plan({ name: 'Test' })
    await create_task({ goal: 'root' })

    await create_task({ goal: 'child 1', parent_id: '1' })
    await update_task({ task_id: '1.1', result: 'done 1' })
    await set_status({ task_id: '1.1', status: 'completed' })

    await create_task({ goal: 'child 2', parent_id: '1' })
    await set_status({ task_id: '1.2', status: 'abandoned', reason: 'failed' })

    await create_task({ goal: 'child 3', parent_id: '1', status: 'pending' })

    const result = await synthesize({ task_id: '1' })

    expect(result.synthesis.completed).toHaveLength(1)
    expect(result.synthesis.completed[0].id).toBe('1.1')
    expect(result.synthesis.completed[0].result).toBe('done 1')

    expect(result.synthesis.abandoned).toHaveLength(1)
    expect(result.synthesis.abandoned[0].id).toBe('1.2')
    expect(result.synthesis.abandoned[0].abandon_reason).toBe('failed')

    expect(result.synthesis.pending).toHaveLength(1)
    expect(result.synthesis.pending[0].id).toBe('1.3')
  })

  it('active children appear in pending bucket', async () => {
    await create_plan({ name: 'Test' })
    await create_task({ goal: 'root' })
    await create_task({ goal: 'active child', parent_id: '1' })  // status=active
    const result = await synthesize({ task_id: '1' })
    // active is not completed or abandoned, so it goes to pending
    expect(result.synthesis.pending[0].status).toBe('active')
  })

  it('response includes context and synthesis key', async () => {
    await create_plan({ name: 'Test' })
    await create_task({ goal: 'root' })
    const result = await synthesize({ task_id: '1' })
    expect(result).toHaveProperty('focus')
    expect(result).toHaveProperty('tree_stats')
    expect(result).toHaveProperty('synthesis')
  })

  it('completed children include state', async () => {
    await create_plan({ name: 'Test' })
    await create_task({ goal: 'root' })
    await create_task({ goal: 'child', parent_id: '1', initial_state: { x: 1 } })
    await update_task({ task_id: '1.1', result: 'done', state_patch: { y: 2 } })
    await set_status({ task_id: '1.1', status: 'completed' })
    const result = await synthesize({ task_id: '1' })
    expect(result.synthesis.completed[0].state).toEqual({ x: 1, y: 2 })
  })
})
