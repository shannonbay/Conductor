import { describe, it, expect } from 'vitest'
import { open_plan } from '../../tools/open_plan.js'
import { create_plan } from '../../tools/create_plan.js'
import { create_task } from '../../tools/create_task.js'
import { archive_plan } from '../../tools/archive_plan.js'
import { getOpenPlan } from '../../session.js'
import { getPlan } from '../../db.js'

describe('open_plan', () => {
  it('throws for unknown plan id', async () => {
    await expect(open_plan({ plan_id: 'nonexistent' })).rejects.toThrow('not found')
  })

  it('sets the open plan in session', async () => {
    const p = await create_plan({ name: 'Test' })
    // Create a second plan to change session
    await create_plan({ name: 'Other' })
    expect(getOpenPlan()).not.toBe(p.id)

    await open_plan({ plan_id: p.id })
    expect(getOpenPlan()).toBe(p.id)
  })

  it('returns empty-tree message when plan has no tasks', async () => {
    const p = await create_plan({ name: 'Empty' })
    const result = await open_plan({ plan_id: p.id })
    expect(result).toHaveProperty('message')
    expect((result as { message: string }).message).toContain('empty')
  })

  it('returns context when plan has tasks', async () => {
    const p = await create_plan({ name: 'With Tasks' })
    await create_task({ goal: 'root' })
    const result = await open_plan({ plan_id: p.id })
    expect(result).toHaveProperty('focus')
    expect(result).toHaveProperty('tree_stats')
  })

  it('auto-reactivates archived plans', async () => {
    const p = await create_plan({ name: 'Was Archived' })
    await archive_plan({ plan_id: p.id })
    expect(getPlan(p.id)!.status).toBe('archived')

    await open_plan({ plan_id: p.id })
    expect(getPlan(p.id)!.status).toBe('active')
  })
})
