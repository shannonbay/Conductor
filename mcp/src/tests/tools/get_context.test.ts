import { describe, it, expect } from 'vitest'
import { get_context } from '../../tools/get_context.js'
import { create_project } from '../../tools/create_project.js'
import { create_task } from '../../tools/create_task.js'

describe('get_context', () => {
  it('returns error object (does not throw) when no project is open', async () => {
    const result = await get_context({})
    expect(result).toHaveProperty('error')
    expect((result as { error: string }).error).toContain('No project is open')
  })

  it('returns empty-tree message when project has no tasks', async () => {
    await create_project({ name: 'Empty' })
    const result = await get_context({})
    expect(result).toHaveProperty('message')
    expect((result as { message: string }).message).toContain('empty')
  })

  it('returns full context when project has tasks', async () => {
    await create_project({ name: 'Test' })
    await create_task({ goal: 'root' })
    const result = await get_context({})
    expect(result).toHaveProperty('focus')
    expect(result).toHaveProperty('tree_stats')
    expect(result).toHaveProperty('siblings')
    expect(result).toHaveProperty('children')
  })

  it('is read-only — does not change focus or state', async () => {
    const p = await create_project({ name: 'Test' })
    await create_task({ goal: 'root' })
    await get_context({})
    await get_context({})
    // Focus should still be on task 1
    const result = await get_context({})
    expect((result as { focus: { id: string } }).focus.id).toBe('1')
  })
})
