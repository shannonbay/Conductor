import { describe, it, expect } from 'vitest'
import { synthesize } from '../../tools/synthesize.js'
import { create_project } from '../../tools/create_project.js'
import { create_task } from '../../tools/create_task.js'
import { set_status } from '../../tools/set_status.js'
import { navigate } from '../../tools/navigate.js'
import { update_task } from '../../tools/update_task.js'

describe('synthesize', () => {
  it('throws when no project is open', async () => {
    await expect(synthesize({})).rejects.toThrow('No project is open')
  })

  it('throws for unknown target_id', async () => {
    await create_project({ name: 'Test' })
    await create_task({ goal: 'root' })
    await expect(synthesize({ target_id: '99' })).rejects.toThrow('not found')
  })

  it('groups children into completed, abandoned, pending', async () => {
    await create_project({ name: 'Test' })
    await create_task({ goal: 'root' })

    await create_task({ goal: 'child 1' })
    await update_task({ result: 'done 1' })
    await set_status({ status: 'completed' })

    await navigate({ target_id: '1' })
    await create_task({ goal: 'child 2' })
    await set_status({ status: 'abandoned', reason: 'failed' })

    await navigate({ target_id: '1' })
    await create_task({ goal: 'child 3', status: 'pending' })

    await navigate({ target_id: '1' })
    const result = await synthesize({})

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
    await create_project({ name: 'Test' })
    await create_task({ goal: 'root' })
    await create_task({ goal: 'active child' })  // status=active
    await navigate({ target_id: '1' })
    const result = await synthesize({})
    // active is not completed or abandoned, so it goes to pending
    expect(result.synthesis.pending[0].status).toBe('active')
  })

  it('uses target_id override', async () => {
    await create_project({ name: 'Test' })
    await create_task({ goal: 'root' })
    await create_task({ goal: 'child' })
    // focus is on 1.1; synthesize root (1) explicitly
    const result = await synthesize({ target_id: '1' })
    expect(result.focus.id).toBe('1')
  })

  it('response includes context and synthesis key', async () => {
    await create_project({ name: 'Test' })
    await create_task({ goal: 'root' })
    const result = await synthesize({})
    expect(result).toHaveProperty('focus')
    expect(result).toHaveProperty('tree_stats')
    expect(result).toHaveProperty('synthesis')
  })

  it('completed children include state', async () => {
    await create_project({ name: 'Test' })
    await create_task({ goal: 'root' })
    await create_task({ goal: 'child', initial_state: { x: 1 } })
    await update_task({ result: 'done', state_patch: { y: 2 } })
    await set_status({ status: 'completed' })
    await navigate({ target_id: '1' })
    const result = await synthesize({})
    expect(result.synthesis.completed[0].state).toEqual({ x: 1, y: 2 })
  })
})
