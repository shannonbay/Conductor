import { describe, it, expect } from 'vitest'
import { list_plans } from '../../tools/list_plans.js'
import { create_plan } from '../../tools/create_plan.js'
import { archive_plan } from '../../tools/archive_plan.js'

describe('list_plans', () => {
  it('returns empty list when no plans', async () => {
    const result = await list_plans({})
    expect(result.plans).toEqual([])
  })

  it('returns active plans by default', async () => {
    const p = await create_plan({ name: 'Active' })
    const result = await list_plans({})
    expect(result.plans.map(x => x.id)).toContain(p.id)
  })

  it('excludes archived plans from active filter', async () => {
    const p = await create_plan({ name: 'To Archive' })
    await archive_plan({ plan_id: p.id })
    const result = await list_plans({ status: 'active' })
    expect(result.plans.map(x => x.id)).not.toContain(p.id)
  })

  it('returns archived plans with archived filter', async () => {
    const p = await create_plan({ name: 'Archived' })
    await archive_plan({ plan_id: p.id })
    const result = await list_plans({ status: 'archived' })
    expect(result.plans.map(x => x.id)).toContain(p.id)
  })

  it('returns all plans with all filter', async () => {
    const p1 = await create_plan({ name: 'Active' })
    const p2 = await create_plan({ name: 'Archived' })
    await archive_plan({ plan_id: p2.id })
    const result = await list_plans({ status: 'all' })
    const ids = result.plans.map(x => x.id)
    expect(ids).toContain(p1.id)
    expect(ids).toContain(p2.id)
  })

  it('each plan includes tree_stats', async () => {
    await create_plan({ name: 'Test' })
    const result = await list_plans({})
    expect(result.plans[0].tree_stats).toBeDefined()
    expect(result.plans[0].tree_stats.total_tasks).toBe(0)
  })
})
