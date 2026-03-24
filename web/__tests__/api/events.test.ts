import { describe, it, expect } from 'vitest'
import { NextRequest } from 'next/server'
import { POST as POSTProject } from '@/app/api/plans/route.js'
import { POST as POSTTask } from '@/app/api/plans/[id]/tasks/route.js'
import { GET as GETEvents } from '@/app/api/plans/[id]/events/route.js'

function makeRequest(method: string, url: string, body?: unknown): NextRequest {
  return new NextRequest(url, {
    method,
    headers: body ? { 'Content-Type': 'application/json' } : {},
    body: body ? JSON.stringify(body) : undefined,
  })
}

async function createProject(name = 'Test Project') {
  const res = await POSTProject(makeRequest('POST', 'http://localhost/api/projects', { name, working_dir: '/tmp/test' }))
  return (await res.json()) as { id: string }
}

async function createTask(planId: string, body: object) {
  return POSTTask(
    makeRequest('POST', `http://localhost/api/plans/${planId}/tasks`, body),
    { params: Promise.resolve({ id: planId }) },
  )
}

async function getEvents(planId: string) {
  const res = await GETEvents(
    makeRequest('GET', `http://localhost/api/plans/${planId}/events`),
    { params: Promise.resolve({ id: planId }) },
  )
  return { status: res.status, body: await res.json() }
}

// ── GET /api/plans/:id/events ─────────────────────────────────────────────

describe('GET /api/plans/:id/events', () => {
  it('returns 404 for unknown project', async () => {
    const { status } = await getEvents('plan_does_not_exist')
    expect(status).toBe(404)
  })

  it('returns only the plan_created event for a new project with no tasks', async () => {
    const project = await createProject()
    const { status, body } = await getEvents(project.id)
    expect(status).toBe(200)
    expect(body).toHaveLength(1)
    expect(body[0].event_type).toBe('plan_created')
  })

  it('returns events after task creation in oldest-first order', async () => {
    const project = await createProject()
    await createTask(project.id, { goal: 'Root',status: 'active' })

    const { status, body } = await getEvents(project.id)
    expect(status).toBe(200)
    expect(body.length).toBeGreaterThan(1)
    // oldest-first: plan_created comes before task_created
    expect(body[0].event_type).toBe('plan_created')
    const taskEvent = body.find((e: { event_type: string }) => e.event_type === 'task_created')
    expect(taskEvent).toBeDefined()
    expect(taskEvent.actor).toBe('human')
  })

  it('accumulates events across multiple task creations', async () => {
    const project = await createProject()
    await createTask(project.id, { goal: 'Root' })
    await createTask(project.id, { goal: 'Child A', parent_id: '1' })
    await createTask(project.id, { goal: 'Child B', parent_id: '1' })

    const { body } = await getEvents(project.id)
    const taskEvents = body.filter((e: { event_type: string }) => e.event_type === 'task_created')
    expect(taskEvents.length).toBe(3)
  })

  it('events have required fields', async () => {
    const project = await createProject()
    await createTask(project.id, { goal: 'Root' })

    const { body } = await getEvents(project.id)
    const event = body[0]
    expect(event).toHaveProperty('id')
    expect(event).toHaveProperty('plan_id', project.id)
    expect(event).toHaveProperty('task_id')
    expect(event).toHaveProperty('event_type')
    expect(event).toHaveProperty('actor')
    expect(event).toHaveProperty('payload')
    expect(event).toHaveProperty('created_at')
  })
})

// ── appendEvent dedup (store logic) ─────────────────────────────────────────

describe('store appendEvent deduplication', () => {
  it('does not add duplicate events with the same id', async () => {
    // Import dynamically so the in-memory store is fresh per test-file run
    const { useStore } = await import('@/lib/store.js')
    const store = useStore.getState()

    const event = {
      id: 'evt_dedup_test',
      plan_id: 'plan_x',
      task_id: '1',
      event_type: 'task_created',
      actor: 'human' as const,
      session_id: null,
      payload: {},
      created_at: new Date().toISOString(),
    }

    store.appendEvent(event)
    store.appendEvent(event) // duplicate
    store.appendEvent(event) // duplicate

    const events = useStore.getState().events.filter((e) => e.id === 'evt_dedup_test')
    expect(events).toHaveLength(1)
  })

  it('does add events with different ids', async () => {
    const { useStore } = await import('@/lib/store.js')
    const store = useStore.getState()
    const before = useStore.getState().events.length

    const base = {
      plan_id: 'plan_x',
      task_id: '1',
      event_type: 'task_updated',
      actor: 'agent' as const,
      session_id: null,
      payload: {},
      created_at: new Date().toISOString(),
    }

    store.appendEvent({ ...base, id: 'evt_unique_1' })
    store.appendEvent({ ...base, id: 'evt_unique_2' })

    expect(useStore.getState().events.length).toBe(before + 2)
  })
})
