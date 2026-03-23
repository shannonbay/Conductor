import { describe, it, expect, vi, beforeEach } from 'vitest'
import { NextRequest } from 'next/server'
import { POST as POSTProject } from '@/app/api/projects/route.js'
import { POST as POSTTask } from '@/app/api/projects/[id]/tasks/route.js'
import { GET as GETEvents } from '@/app/api/projects/[id]/events/route.js'
import { recordEvent } from '@/lib/event-log.js'

// vi.mock is hoisted, so the mock variable must be created with vi.hoisted()
const broadcastMock = vi.hoisted(() => vi.fn())
vi.mock('@/lib/ws-broadcaster.js', () => ({
  broadcast: broadcastMock,
  registerClient: vi.fn(),
  unregisterClient: vi.fn(),
  clientCount: vi.fn().mockReturnValue(0),
}))

beforeEach(() => {
  broadcastMock.mockClear()
})

async function createProject(name = 'Test Project') {
  const req = new NextRequest('http://localhost/api/projects', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name, working_dir: '/tmp/test' }),
  })
  const res = await POSTProject(req)
  return (await res.json()) as { id: string }
}

// ── recordEvent → broadcast pipeline ─────────────────────────────────────────

describe('recordEvent broadcasts to WebSocket clients', () => {
  it('calls broadcast with { type: "event", event } for every recordEvent call', async () => {
    const project = await createProject('Broadcast Test')
    broadcastMock.mockClear() // ignore project_created broadcast from createProject

    recordEvent({
      projectId: project.id,
      taskId: project.id,
      eventType: 'project_updated',
      actor: 'human',
      payload: { name: 'Renamed' },
    })

    expect(broadcastMock).toHaveBeenCalledOnce()
    const [calledProjectId, message] = broadcastMock.mock.calls[0]
    expect(calledProjectId).toBe(project.id)
    expect(message.type).toBe('event')
    expect(message.event.event_type).toBe('project_updated')
    expect(message.event.actor).toBe('human')
    expect(message.event.payload).toEqual({ name: 'Renamed' })
  })

  it('broadcast payload includes a generated id and valid created_at', async () => {
    const project = await createProject('Fields Test')
    broadcastMock.mockClear()

    recordEvent({ projectId: project.id, taskId: project.id, eventType: 'project_updated', actor: 'human' })

    const message = broadcastMock.mock.calls[0][1]
    expect(message.event.id).toBeTruthy()
    expect(new Date(message.event.created_at).toString()).not.toBe('Invalid Date')
  })
})

// ── getEvents ordering ────────────────────────────────────────────────────────

describe('GET /api/projects/:id/events ordering', () => {
  it('returns events newest-first (DESC by created_at)', async () => {
    const project = await createProject('Order Test')

    for (const goal of ['First', 'Second', 'Third']) {
      await POSTTask(
        new NextRequest(`http://localhost/api/projects/${project.id}/tasks`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ goal, plan: ['step'] }),
        }),
        { params: Promise.resolve({ id: project.id }) },
      )
    }

    const res = await GETEvents(
      new NextRequest(`http://localhost/api/projects/${project.id}/events`),
      { params: Promise.resolve({ id: project.id }) },
    )
    const events = (await res.json()) as Array<{ created_at: string }>

    expect(events.length).toBeGreaterThan(1)
    for (let i = 0; i < events.length - 1; i++) {
      expect(events[i].created_at >= events[i + 1].created_at).toBe(true)
    }
  })
})
