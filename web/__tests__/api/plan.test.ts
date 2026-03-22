import { describe, it, expect, vi } from 'vitest'
import { NextRequest } from 'next/server'
import { POST as POSTProject } from '@/app/api/projects/route.js'
import { POST as POSTTask } from '@/app/api/projects/[id]/tasks/route.js'
import { POST as POSTPlan } from '@/app/api/projects/[id]/tasks/[taskId]/plan/route.js'
import { POST as POSTAcceptPlan } from '@/app/api/projects/[id]/tasks/[taskId]/plan/accept/route.js'
import { POST as POSTModifyPlan } from '@/app/api/projects/[id]/tasks/[taskId]/modify-plan/route.js'
import { POST as POSTAcceptModify } from '@/app/api/projects/[id]/tasks/[taskId]/modify-plan/accept/route.js'
import { getTask, getChildren } from '@/lib/db.js'

vi.mock('@/lib/planning.js', () => ({
  generatePlan: vi.fn(),
  modifyPlan: vi.fn(),
}))

function req(method: string, url: string, body?: unknown) {
  return new NextRequest(url, {
    method,
    headers: body ? { 'Content-Type': 'application/json' } : {},
    body: body ? JSON.stringify(body) : undefined,
  })
}

async function json(res: Response) {
  return { status: res.status, body: await res.json() }
}

async function setup() {
  const projRes = await POSTProject(req('POST', 'http://localhost/api/projects', { name: 'Plan Test' }))
  const project = await projRes.json()

  const taskRes = await POSTTask(
    req('POST', `http://localhost/api/projects/${project.id}/tasks`, { goal: 'Root task', plan: ['step 1'] }),
    { params: Promise.resolve({ id: project.id }) },
  )
  const task = await taskRes.json()

  return { projectId: project.id, taskId: task.id }
}

describe('POST /tasks/:id/plan', () => {
  it('calls generatePlan and returns draft without creating tasks', async () => {
    const { generatePlan } = await import('@/lib/planning.js')
    const proposed = [{ goal: 'Sub A', plan: ['step'], suggested_depends_on: [] }]
    ;(generatePlan as ReturnType<typeof vi.fn>).mockResolvedValue(proposed)

    const { projectId, taskId } = await setup()
    const res = await POSTPlan(
      req('POST', `http://localhost`, { instruction: 'focus on speed' }),
      { params: Promise.resolve({ id: projectId, taskId }) },
    )
    const { status, body } = await json(res)
    expect(status).toBe(200)
    expect(body.proposed).toHaveLength(1)
    expect(body.proposed[0].goal).toBe('Sub A')
    // No children created
    expect(getChildren(projectId, taskId)).toHaveLength(0)
  })
})

describe('POST /tasks/:id/plan/accept', () => {
  it('creates tasks from accepted proposal', async () => {
    const { projectId, taskId } = await setup()
    const res = await POSTAcceptPlan(
      req('POST', `http://localhost`, {
        tasks: [
          { goal: 'Child A', plan: ['step A'] },
          { goal: 'Child B', plan: ['step B'] },
        ],
      }),
      { params: Promise.resolve({ id: projectId, taskId }) },
    )
    const { status, body } = await json(res)
    expect(status).toBe(201)
    expect(body.created).toHaveLength(2)
    expect(getTask(projectId, `${taskId}.1`)).toBeDefined()
    expect(getTask(projectId, `${taskId}.2`)).toBeDefined()
  })

  it('returns 400 for empty tasks array', async () => {
    const { projectId, taskId } = await setup()
    const res = await POSTAcceptPlan(
      req('POST', `http://localhost`, { tasks: [] }),
      { params: Promise.resolve({ id: projectId, taskId }) },
    )
    expect(res.status).toBe(400)
  })
})

describe('POST /tasks/:id/modify-plan', () => {
  it('calls modifyPlan and returns diff without mutating DB', async () => {
    const { modifyPlan } = await import('@/lib/planning.js')
    const diff = { unchanged: [], modified: [], added: [{ goal: 'New', plan: ['s'], suggested_depends_on: [] }], removed: [] }
    ;(modifyPlan as ReturnType<typeof vi.fn>).mockResolvedValue(diff)

    const { projectId, taskId } = await setup()

    // Add a child first
    await POSTAcceptPlan(
      req('POST', `http://localhost`, { tasks: [{ goal: 'Existing', plan: ['step'] }] }),
      { params: Promise.resolve({ id: projectId, taskId }) },
    )

    const res = await POSTModifyPlan(
      req('POST', `http://localhost`, { instruction: 'add a testing phase' }),
      { params: Promise.resolve({ id: projectId, taskId }) },
    )
    const { status, body } = await json(res)
    expect(status).toBe(200)
    expect(body.diff).toBeDefined()
    // Still only 1 child (not committed)
    expect(getChildren(projectId, taskId)).toHaveLength(1)
  })
})

describe('POST /tasks/:id/modify-plan/accept', () => {
  it('adds new tasks and removes pending ones atomically', async () => {
    const { projectId, taskId } = await setup()

    // Create two pending children
    await POSTAcceptPlan(
      req('POST', `http://localhost`, {
        tasks: [
          { goal: 'Keep this', plan: ['s'] },
          { goal: 'Remove this', plan: ['s'] },
        ],
      }),
      { params: Promise.resolve({ id: projectId, taskId }) },
    )

    const res = await POSTAcceptModify(
      req('POST', `http://localhost`, {
        removed: [`${taskId}.2`],
        added: [{ goal: 'New child', plan: ['new step'], suggested_depends_on: [] }],
      }),
      { params: Promise.resolve({ id: projectId, taskId }) },
    )
    const { status, body } = await json(res)
    expect(status).toBe(200)

    const children = getChildren(projectId, taskId)
    // "Keep this" is still present
    expect(children.some((c) => c.goal === 'Keep this')).toBe(true)
    // "Remove this" is gone
    expect(children.every((c) => c.goal !== 'Remove this')).toBe(true)
    // "New child" was added
    expect(children.some((c) => c.goal === 'New child')).toBe(true)
  })

  it('does not remove completed tasks even if requested', async () => {
    const { projectId, taskId } = await setup()
    await POSTAcceptPlan(
      req('POST', `http://localhost`, { tasks: [{ goal: 'Completed task', plan: ['s'] }] }),
      { params: Promise.resolve({ id: projectId, taskId }) },
    )

    // Mark as completed
    const { updateTask } = await import('@/lib/db.js')
    updateTask(projectId, `${taskId}.1`, { status: 'completed' })

    const res = await POSTAcceptModify(
      req('POST', `http://localhost`, { removed: [`${taskId}.1`] }),
      { params: Promise.resolve({ id: projectId, taskId }) },
    )
    await json(res)
    // Completed task should still exist
    expect(getTask(projectId, `${taskId}.1`)).toBeDefined()
  })
})
