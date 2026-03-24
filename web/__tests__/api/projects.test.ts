import { describe, it, expect } from 'vitest'
import { GET, POST } from '@/app/api/plans/route.js'
import { GET as GETById, PATCH as PATCHById, DELETE as DELETEById } from '@/app/api/plans/[id]/route.js'
import { POST as POSTArchive } from '@/app/api/plans/[id]/archive/route.js'
import { POST as POSTRestore } from '@/app/api/plans/[id]/restore/route.js'
import { NextRequest } from 'next/server'

function makeRequest(method: string, url: string, body?: unknown): NextRequest {
  return new NextRequest(url, {
    method,
    headers: body ? { 'Content-Type': 'application/json' } : {},
    body: body ? JSON.stringify(body) : undefined,
  })
}

async function jsonResponse(res: Response) {
  return { status: res.status, body: await res.json() }
}

describe('GET /api/projects', () => {
  it('returns empty list when no projects', async () => {
    const req = makeRequest('GET', 'http://localhost/api/projects')
    const res = await GET(req)
    const { status, body } = await jsonResponse(res)
    expect(status).toBe(200)
    expect(body).toEqual([])
  })
})

describe('POST /api/projects', () => {
  it('creates a project and returns it with tree_stats', async () => {
    const req = makeRequest('POST', 'http://localhost/api/projects', { name: 'My Project', working_dir: '/tmp/test' })
    const res = await POST(req)
    const { status, body } = await jsonResponse(res)
    expect(status).toBe(201)
    expect(body.name).toBe('My Project')
    expect(body.status).toBe('active')
    expect(body.tree_stats.total_tasks).toBe(0)
    expect(body.id).toMatch(/^plan_/)
  })

  it('returns 400 when name is missing', async () => {
    const req = makeRequest('POST', 'http://localhost/api/projects', {})
    const res = await POST(req)
    expect(res.status).toBe(400)
  })
})

describe('GET /api/plans/:id', () => {
  it('returns project with stats', async () => {
    const createReq = makeRequest('POST', 'http://localhost/api/projects', { name: 'Test', working_dir: '/tmp/test' })
    const createRes = await POST(createReq)
    const { body: project } = await jsonResponse(createRes)

    const getReq = makeRequest('GET', `http://localhost/api/plans/${project.id}`)
    const getRes = await GETById(getReq, { params: Promise.resolve({ id: project.id }) })
    const { status, body } = await jsonResponse(getRes)
    expect(status).toBe(200)
    expect(body.id).toBe(project.id)
    expect(body.tree_stats).toBeDefined()
  })

  it('returns 404 for unknown project', async () => {
    const req = makeRequest('GET', 'http://localhost/api/plans/plan_unknown')
    const res = await GETById(req, { params: Promise.resolve({ id: 'plan_unknown' }) })
    expect(res.status).toBe(404)
  })
})

describe('PATCH /api/plans/:id', () => {
  it('updates project name', async () => {
    const { body: project } = await jsonResponse(await POST(makeRequest('POST', 'http://localhost/api/projects', { name: 'Old Name', working_dir: '/tmp/test' })))
    const patchReq = makeRequest('PATCH', `http://localhost/api/plans/${project.id}`, { name: 'New Name' })
    const res = await PATCHById(patchReq, { params: Promise.resolve({ id: project.id }) })
    const { status, body } = await jsonResponse(res)
    expect(status).toBe(200)
    expect(body.name).toBe('New Name')
  })
})

describe('POST /api/plans/:id/archive', () => {
  it('archives a project', async () => {
    const { body: project } = await jsonResponse(await POST(makeRequest('POST', 'http://localhost/api/projects', { name: 'Archive Me', working_dir: '/tmp/test' })))
    const archiveReq = makeRequest('POST', `http://localhost/api/plans/${project.id}/archive`)
    const res = await POSTArchive(archiveReq, { params: Promise.resolve({ id: project.id }) })
    const { status, body } = await jsonResponse(res)
    expect(status).toBe(200)
    expect(body.status).toBe('archived')
  })
})

describe('POST /api/plans/:id/restore', () => {
  it('restores an archived project', async () => {
    const { body: project } = await jsonResponse(await POST(makeRequest('POST', 'http://localhost/api/projects', { name: 'Restore Me', working_dir: '/tmp/test' })))
    await POSTArchive(makeRequest('POST', `http://localhost/api/plans/${project.id}/archive`), { params: Promise.resolve({ id: project.id }) })
    const restoreReq = makeRequest('POST', `http://localhost/api/plans/${project.id}/restore`)
    const res = await POSTRestore(restoreReq, { params: Promise.resolve({ id: project.id }) })
    const { status, body } = await jsonResponse(res)
    expect(status).toBe(200)
    expect(body.status).toBe('active')
  })
})

describe('DELETE /api/plans/:id', () => {
  it('deletes a project and it no longer appears in GET /api/projects', async () => {
    // Create a project
    const { body: project } = await jsonResponse(
      await POST(makeRequest('POST', 'http://localhost/api/projects', { name: 'Delete Me', working_dir: '/tmp/test' }))
    )
    expect(project.id).toMatch(/^plan_/)

    // Delete it
    const deleteReq = makeRequest('DELETE', `http://localhost/api/plans/${project.id}`)
    const deleteRes = await DELETEById(deleteReq, { params: Promise.resolve({ id: project.id }) })
    expect(deleteRes.status).toBe(200)

    // Confirm it no longer appears in the project list
    const listReq = makeRequest('GET', 'http://localhost/api/projects')
    const listRes = await GET(listReq)
    const { body: projects } = await jsonResponse(listRes)
    const ids = projects.map((p: { id: string }) => p.id)
    expect(ids).not.toContain(project.id)
  })

  it('returns 404 when deleting a non-existent project', async () => {
    const deleteReq = makeRequest('DELETE', 'http://localhost/api/plans/plan_does_not_exist')
    const res = await DELETEById(deleteReq, { params: Promise.resolve({ id: 'plan_does_not_exist' }) })
    expect(res.status).toBe(404)
  })

  it('returns 404 when fetching a deleted project by id', async () => {
    // Create and immediately delete
    const { body: project } = await jsonResponse(
      await POST(makeRequest('POST', 'http://localhost/api/projects', { name: 'Gone', working_dir: '/tmp/test' }))
    )
    await DELETEById(
      makeRequest('DELETE', `http://localhost/api/plans/${project.id}`),
      { params: Promise.resolve({ id: project.id }) }
    )

    // Fetching it by ID should now return 404
    const getReq = makeRequest('GET', `http://localhost/api/plans/${project.id}`)
    const getRes = await GETById(getReq, { params: Promise.resolve({ id: project.id }) })
    expect(getRes.status).toBe(404)
  })
})
