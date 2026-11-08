import { describe, it, expect, vi, beforeEach } from 'vitest'
import { insertPlan } from '@/lib/db'
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
  const id = `plan_${Math.random().toString(36).slice(2, 10)}`
  const now = new Date().toISOString()
  insertPlan({ id, name, description: null, status: 'active', working_dir: '/tmp/test', created_at: now, updated_at: now })
  return { id }
}

// ── recordEvent → broadcast pipeline ─────────────────────────────────────────

describe('recordEvent broadcasts to WebSocket clients', () => {
  it('calls broadcast with { type: "event", event } for every recordEvent call', async () => {
    const project = await createProject('Broadcast Test')
    broadcastMock.mockClear() // ignore project_created broadcast from createProject

    recordEvent({
      planId: project.id,
      taskId: project.id,
      eventType: 'plan_updated',
      actor: 'human',
      payload: { name: 'Renamed' },
    })

    expect(broadcastMock).toHaveBeenCalledOnce()
    const [calledProjectId, message] = broadcastMock.mock.calls[0]
    expect(calledProjectId).toBe(project.id)
    expect(message.type).toBe('event')
    expect(message.event.event_type).toBe('plan_updated')
    expect(message.event.actor).toBe('human')
    expect(message.event.payload).toEqual({ name: 'Renamed' })
  })

  it('broadcast payload includes a generated id and valid created_at', async () => {
    const project = await createProject('Fields Test')
    broadcastMock.mockClear()

    recordEvent({ planId: project.id, taskId: project.id, eventType: 'plan_updated', actor: 'human' })

    const message = broadcastMock.mock.calls[0][1]
    expect(message.event.id).toBeTruthy()
    expect(new Date(message.event.created_at).toString()).not.toBe('Invalid Date')
  })
})
