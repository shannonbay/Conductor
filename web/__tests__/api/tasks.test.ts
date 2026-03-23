import { describe, it, expect } from 'vitest'
import { NextRequest } from 'next/server'
import { POST as POSTProject } from '@/app/api/projects/route.js'
import { GET as GETTasks, POST as POSTTask } from '@/app/api/projects/[id]/tasks/route.js'
import { GET as GETTask, PATCH as PATCHTask, DELETE as DELETETask } from '@/app/api/projects/[id]/tasks/[taskId]/route.js'
import { POST as POSTStatus } from '@/app/api/projects/[id]/tasks/[taskId]/status/route.js'
import { getTask } from '@/lib/db.js'

function makeRequest(method: string, url: string, body?: unknown): NextRequest {
  return new NextRequest(url, {
    method,
    headers: body ? { 'Content-Type': 'application/json' } : {},
    body: body ? JSON.stringify(body) : undefined,
  })
}

async function json(res: Response) {
  return { status: res.status, body: await res.json() }
}

async function createProject(name = 'Test Project') {
  const res = await POSTProject(makeRequest('POST', 'http://localhost/api/projects', { name, working_dir: '/tmp/test' }))
  return (await res.json()) as { id: string }
}

async function createTask(projectId: string, body: object) {
  const res = await POSTTask(
    makeRequest('POST', `http://localhost/api/projects/${projectId}/tasks`, body),
    { params: Promise.resolve({ id: projectId }) },
  )
  return res
}

describe('POST /api/projects/:id/tasks', () => {
  it('creates root task with ID "1"', async () => {
    const project = await createProject()
    const res = await createTask(project.id, { goal: 'Root task',status: 'active' })
    const { status, body } = await json(res)
    expect(status).toBe(201)
    expect(body.id).toBe('1')
    expect(body.goal).toBe('Root task')
  })

  it('creates child task with correct tree-address ID', async () => {
    const project = await createProject()
    await createTask(project.id, { goal: 'Root' })
    const res = await createTask(project.id, { goal: 'Child A', parent_id: '1' })
    const { body } = await json(res)
    expect(body.id).toBe('1.1')

    const res2 = await createTask(project.id, { goal: 'Child B', parent_id: '1' })
    const { body: body2 } = await json(res2)
    expect(body2.id).toBe('1.2')
  })

  it('rejects depends_on referencing non-sibling', async () => {
    const project = await createProject()
    await createTask(project.id, { goal: 'Root' })
    await createTask(project.id, { goal: 'Child 1', parent_id: '1' })
    // Try to create a second root task that depends_on a child — invalid
    const res = await POSTTask(
      makeRequest('POST', `http://localhost/api/projects/${project.id}/tasks`, {
        goal: 'Root 2',
        plan: ['step'],
        depends_on: ['1.1'], // 1.1 is not a sibling of root level
      }),
      { params: Promise.resolve({ id: project.id }) },
    )
    expect(res.status).toBe(400)
  })

  it('returns 400 for missing goal', async () => {
    const project = await createProject()
    const res = await createTask(project.id, { plan: ['step'] })
    expect(res.status).toBe(400)
  })
})

describe('GET /api/projects/:id/tasks', () => {
  it('returns full tree structure', async () => {
    const project = await createProject()
    await createTask(project.id, { goal: 'Root' })
    await createTask(project.id, { goal: 'Child', parent_id: '1' })

    const res = await GETTasks(makeRequest('GET', `http://localhost/api/projects/${project.id}/tasks`), { params: Promise.resolve({ id: project.id }) })
    const { status, body } = await json(res)
    expect(status).toBe(200)
    expect(body).toHaveLength(1)
    expect(body[0].id).toBe('1')
    expect(body[0].children).toHaveLength(1)
  })
})

describe('GET /api/projects/:id/tasks/:taskId', () => {
  it('returns task with parent, siblings, children, stats', async () => {
    const project = await createProject()
    await createTask(project.id, { goal: 'Root' })
    await createTask(project.id, { goal: 'Child A', parent_id: '1' })
    await createTask(project.id, { goal: 'Child B', parent_id: '1' })

    const res = await GETTask(makeRequest('GET', `http://localhost`), { params: Promise.resolve({ id: project.id, taskId: '1.1' }) })
    const { status, body } = await json(res)
    expect(status).toBe(200)
    expect(body.task.id).toBe('1.1')
    expect(body.parent).toMatchObject({ id: '1' })
    expect(body.siblings).toHaveLength(1)
    expect(body.siblings[0].id).toBe('1.2')
  })
})

describe('PATCH /api/projects/:id/tasks/:taskId', () => {
  it('updates goal', async () => {
    const project = await createProject()
    await createTask(project.id, { goal: 'Original' })
    const res = await PATCHTask(
      makeRequest('PATCH', `http://localhost`, { goal: 'Updated' }),
      { params: Promise.resolve({ id: project.id, taskId: '1' }) },
    )
    const { status, body } = await json(res)
    expect(status).toBe(200)
    expect(body.goal).toBe('Updated')
  })

  it('updates notes', async () => {
    const project = await createProject()
    await createTask(project.id, { goal: 'Task' })
    const res = await PATCHTask(
      makeRequest('PATCH', `http://localhost`, { notes: 'Important note' }),
      { params: Promise.resolve({ id: project.id, taskId: '1' }) },
    )
    const { status, body } = await json(res)
    expect(status).toBe(200)
    expect(body.notes).toBe('Important note')
  })
})

describe('DELETE /api/projects/:id/tasks/:taskId', () => {
  it('removes task and all descendants', async () => {
    const project = await createProject()
    await createTask(project.id, { goal: 'Root' })
    await createTask(project.id, { goal: 'Child', parent_id: '1' })

    const res = await DELETETask(makeRequest('DELETE', `http://localhost`), { params: Promise.resolve({ id: project.id, taskId: '1' }) })
    expect(res.status).toBe(200)
    expect(getTask(project.id, '1')).toBeUndefined()
    expect(getTask(project.id, '1.1')).toBeUndefined()
  })

  it('returns 409 when task is locked by agent', async () => {
    const project = await createProject()
    await createTask(project.id, { goal: 'Root' })
    // Manually lock the task
    const { getDb } = await import('@/lib/db.js')
    getDb().prepare("UPDATE tasks SET locked_by = 'sess_x' WHERE id = '1' AND project_id = ?").run(project.id)

    const res = await DELETETask(makeRequest('DELETE', `http://localhost`), { params: Promise.resolve({ id: project.id, taskId: '1' }) })
    expect(res.status).toBe(409)
  })
})

describe('POST /api/projects/:id/tasks/:taskId/status', () => {
  it('changes status to completed', async () => {
    const project = await createProject()
    await createTask(project.id, { goal: 'Root', status: 'active' })

    const res = await POSTStatus(
      makeRequest('POST', `http://localhost`, { status: 'completed' }),
      { params: Promise.resolve({ id: project.id, taskId: '1' }) },
    )
    const { status, body } = await json(res)
    expect(status).toBe(200)
    expect(body.task.status).toBe('completed')
  })

  it('requires reason when abandoning', async () => {
    const project = await createProject()
    await createTask(project.id, { goal: 'Task', status: 'active' })

    const res = await POSTStatus(
      makeRequest('POST', `http://localhost`, { status: 'abandoned' }),
      { params: Promise.resolve({ id: project.id, taskId: '1' }) },
    )
    expect(res.status).toBe(400)
  })

  it('blocks activation when dependency is not completed', async () => {
    const project = await createProject()
    await createTask(project.id, { goal: 'Root' })
    await createTask(project.id, { goal: 'A', parent_id: '1', status: 'pending' })
    await createTask(project.id, { goal: 'B', parent_id: '1', status: 'pending' })

    // Set 1.2 to depend on 1.1 (which is pending, not completed)
    const { updateTask } = await import('@/lib/db.js')
    updateTask(project.id, '1.2', { depends_on: ['1.1'] })

    const res = await POSTStatus(
      makeRequest('POST', `http://localhost`, { status: 'active' }),
      { params: Promise.resolve({ id: project.id, taskId: '1.2' }) },
    )
    expect(res.status).toBe(400)
  })

  it('includes warning when completing task with unresolved children', async () => {
    const project = await createProject()
    await createTask(project.id, { goal: 'Root', status: 'active' })
    await createTask(project.id, { goal: 'Child', parent_id: '1', status: 'pending' })

    const res = await POSTStatus(
      makeRequest('POST', `http://localhost`, { status: 'completed' }),
      { params: Promise.resolve({ id: project.id, taskId: '1' }) },
    )
    const { status, body } = await json(res)
    expect(status).toBe(200)
    expect(body.warning).toBeDefined()
  })
})
