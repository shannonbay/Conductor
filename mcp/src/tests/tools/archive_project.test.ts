import { describe, it, expect } from 'vitest'
import { archive_project } from '../../tools/archive_project.js'
import { create_project } from '../../tools/create_project.js'
import { getOpenProject } from '../../session.js'
import { getProject } from '../../db.js'

describe('archive_project', () => {
  it('throws for unknown project id', async () => {
    await expect(archive_project({ project_id: 'nonexistent' })).rejects.toThrow('not found')
  })

  it('sets project status to archived', async () => {
    const p = await create_project({ name: 'Test' })
    await archive_project({ project_id: p.id })
    expect(getProject(p.id)!.status).toBe('archived')
  })

  it('returns archived status in response', async () => {
    const p = await create_project({ name: 'Test' })
    const result = await archive_project({ project_id: p.id })
    expect(result.status).toBe('archived')
    expect(result.id).toBe(p.id)
  })

  it('clears session when archiving the open project', async () => {
    const p = await create_project({ name: 'Open One' })
    expect(getOpenProject()).toBe(p.id)
    await archive_project({ project_id: p.id })
    expect(getOpenProject()).toBeNull()
  })

  it('does not clear session when archiving a non-open project', async () => {
    const p1 = await create_project({ name: 'First' })
    const p2 = await create_project({ name: 'Second' })
    // p2 is now open
    expect(getOpenProject()).toBe(p2.id)
    await archive_project({ project_id: p1.id })
    expect(getOpenProject()).toBe(p2.id)
  })
})
