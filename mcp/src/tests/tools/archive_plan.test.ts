import { describe, it, expect } from 'vitest'
import { archive_plan } from '../../tools/archive_plan.js'
import { create_plan } from '../../tools/create_plan.js'
import { getOpenPlan } from '../../session.js'
import { getPlan } from '../../db.js'

describe('archive_plan', () => {
  it('throws for unknown plan id', async () => {
    await expect(archive_plan({ plan_id: 'nonexistent' })).rejects.toThrow('not found')
  })

  it('sets plan status to archived', async () => {
    const p = await create_plan({ name: 'Test' })
    await archive_plan({ plan_id: p.id })
    expect(getPlan(p.id)!.status).toBe('archived')
  })

  it('returns archived status in response', async () => {
    const p = await create_plan({ name: 'Test' })
    const result = await archive_plan({ plan_id: p.id })
    expect(result.status).toBe('archived')
    expect(result.id).toBe(p.id)
  })

  it('clears session when archiving the open plan', async () => {
    const p = await create_plan({ name: 'Open One' })
    expect(getOpenPlan()).toBe(p.id)
    await archive_plan({ plan_id: p.id })
    expect(getOpenPlan()).toBeNull()
  })

  it('does not clear session when archiving a non-open plan', async () => {
    const p1 = await create_plan({ name: 'First' })
    const p2 = await create_plan({ name: 'Second' })
    // p2 is now open
    expect(getOpenPlan()).toBe(p2.id)
    await archive_plan({ plan_id: p1.id })
    expect(getOpenPlan()).toBe(p2.id)
  })
})
