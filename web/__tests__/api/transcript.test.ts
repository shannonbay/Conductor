import { describe, it, expect } from 'vitest'
import { NextRequest } from 'next/server'
import { POST as POSTProject } from '@/app/api/plans/route.js'
import { GET as GETSessions } from '@/app/api/plans/[id]/sessions/route.js'
import { GET as GETTranscript } from '@/app/api/plans/[id]/sessions/[sessionId]/transcript/route.js'
import {
  insertTranscriptMessage,
  getTranscriptMessages,
  createSession,
  getDb,
} from '@/lib/db.js'

// ─── Helpers ──────────────────────────────────────────────────────────────────

function makeRequest(method: string, url: string): NextRequest {
  return new NextRequest(url, { method })
}

async function createProject(name = 'Test Plan') {
  const req = new NextRequest('http://localhost/api/plans', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name, working_dir: '/tmp/test' }),
  })
  const res = await POSTProject(req)
  return (await res.json()) as { id: string }
}

function createTestSession(planId: string, sessionId: string) {
  createSession({
    id: sessionId,
    plan_id: planId,
    root_task_id: '1',
    nickname: 'test-session',
    status: 'completed',
    autonomy_level: 'full',
    model: 'claude-sonnet-4-6',
    started_at: new Date().toISOString(),
  })
}

// ─── DB helpers ───────────────────────────────────────────────────────────────

describe('insertTranscriptMessage / getTranscriptMessages', () => {
  it('inserts and retrieves a single message', () => {
    // Need a plan + session in DB for FK constraints
    const db = getDb()
    const planId = `plan_${Math.random().toString(36).slice(2, 8)}`
    const sessionId = `sess_${Math.random().toString(36).slice(2, 8)}`
    const now = new Date().toISOString()
    db.prepare(`INSERT INTO plans (id, name, description, status, working_dir, created_at, updated_at) VALUES (?, ?, NULL, 'active', '/tmp', ?, ?)`).run(planId, 'Test', now, now)
    createTestSession(planId, sessionId)

    insertTranscriptMessage({
      id: 'msg_1',
      session_id: sessionId,
      plan_id: planId,
      role: 'user',
      content: [{ type: 'text', text: 'Hello' }],
      turn_index: 0,
    })

    const msgs = getTranscriptMessages(sessionId)
    expect(msgs).toHaveLength(1)
    expect(msgs[0].role).toBe('user')
    expect(msgs[0].turn_index).toBe(0)
    expect(msgs[0].content).toEqual([{ type: 'text', text: 'Hello' }])
  })

  it('returns messages ordered by turn_index ascending', () => {
    const db = getDb()
    const planId = `plan_${Math.random().toString(36).slice(2, 8)}`
    const sessionId = `sess_${Math.random().toString(36).slice(2, 8)}`
    const now = new Date().toISOString()
    db.prepare(`INSERT INTO plans (id, name, description, status, working_dir, created_at, updated_at) VALUES (?, ?, NULL, 'active', '/tmp', ?, ?)`).run(planId, 'Test', now, now)
    createTestSession(planId, sessionId)

    // Insert out of order
    insertTranscriptMessage({ id: 'msg_b', session_id: sessionId, plan_id: planId, role: 'assistant', content: [{ type: 'text', text: 'Hi' }], turn_index: 1 })
    insertTranscriptMessage({ id: 'msg_a', session_id: sessionId, plan_id: planId, role: 'user', content: [{ type: 'text', text: 'Hello' }], turn_index: 0 })
    insertTranscriptMessage({ id: 'msg_c', session_id: sessionId, plan_id: planId, role: 'user', content: [{ type: 'tool_result', tool_use_id: 'x', content: '{}' }], turn_index: 2 })

    const msgs = getTranscriptMessages(sessionId)
    expect(msgs.map((m) => m.turn_index)).toEqual([0, 1, 2])
    expect(msgs[0].role).toBe('user')
    expect(msgs[1].role).toBe('assistant')
  })

  it('returns empty array for unknown session', () => {
    const msgs = getTranscriptMessages('sess_nonexistent')
    expect(msgs).toEqual([])
  })

  it('isolates messages by session_id', () => {
    const db = getDb()
    const planId = `plan_${Math.random().toString(36).slice(2, 8)}`
    const sessA = `sess_a_${Math.random().toString(36).slice(2, 6)}`
    const sessB = `sess_b_${Math.random().toString(36).slice(2, 6)}`
    const now = new Date().toISOString()
    db.prepare(`INSERT INTO plans (id, name, description, status, working_dir, created_at, updated_at) VALUES (?, ?, NULL, 'active', '/tmp', ?, ?)`).run(planId, 'Test', now, now)
    createTestSession(planId, sessA)
    createTestSession(planId, sessB)

    insertTranscriptMessage({ id: 'msg_s1', session_id: sessA, plan_id: planId, role: 'user', content: [], turn_index: 0 })
    insertTranscriptMessage({ id: 'msg_s2', session_id: sessB, plan_id: planId, role: 'user', content: [], turn_index: 0 })

    expect(getTranscriptMessages(sessA)).toHaveLength(1)
    expect(getTranscriptMessages(sessB)).toHaveLength(1)
  })
})

// ─── GET /api/plans/:id/sessions ──────────────────────────────────────────────

describe('GET /api/plans/:id/sessions', () => {
  it('returns 404 for unknown plan', async () => {
    const res = await GETSessions(
      makeRequest('GET', 'http://localhost/api/plans/plan_nope/sessions'),
      { params: Promise.resolve({ id: 'plan_nope' }) },
    )
    expect(res.status).toBe(404)
  })

  it('returns empty array when plan has no sessions', async () => {
    const project = await createProject()
    const res = await GETSessions(
      makeRequest('GET', `http://localhost/api/plans/${project.id}/sessions`),
      { params: Promise.resolve({ id: project.id }) },
    )
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body).toEqual([])
  })

  it('returns sessions for a plan ordered by started_at DESC', async () => {
    const project = await createProject()
    const now = new Date().toISOString()
    createSession({
      id: `sess_first`,
      plan_id: project.id,
      root_task_id: '1',
      nickname: 'first',
      status: 'completed',
      autonomy_level: 'full',
      model: 'claude-sonnet-4-6',
      started_at: new Date(Date.now() - 10_000).toISOString(),
    })
    createSession({
      id: `sess_second`,
      plan_id: project.id,
      root_task_id: '1',
      nickname: 'second',
      status: 'completed',
      autonomy_level: 'full',
      model: 'claude-sonnet-4-6',
      started_at: now,
    })

    const res = await GETSessions(
      makeRequest('GET', `http://localhost/api/plans/${project.id}/sessions`),
      { params: Promise.resolve({ id: project.id }) },
    )
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body).toHaveLength(2)
    // Most recent first
    expect(body[0].nickname).toBe('second')
    expect(body[1].nickname).toBe('first')
  })
})

// ─── GET /api/plans/:id/sessions/:sessionId/transcript ────────────────────────

describe('GET /api/plans/:id/sessions/:sessionId/transcript', () => {
  it('returns 404 for unknown plan', async () => {
    const res = await GETTranscript(
      makeRequest('GET', 'http://localhost/api/plans/plan_nope/sessions/sess_x/transcript'),
      { params: Promise.resolve({ id: 'plan_nope', sessionId: 'sess_x' }) },
    )
    expect(res.status).toBe(404)
  })

  it('returns 404 for unknown session', async () => {
    const project = await createProject()
    const res = await GETTranscript(
      makeRequest('GET', `http://localhost/api/plans/${project.id}/sessions/sess_nope/transcript`),
      { params: Promise.resolve({ id: project.id, sessionId: 'sess_nope' }) },
    )
    expect(res.status).toBe(404)
  })

  it('returns 404 when session belongs to a different plan', async () => {
    const planA = await createProject('Plan A')
    const planB = await createProject('Plan B')
    createTestSession(planA.id, 'sess_plan_a')

    const res = await GETTranscript(
      makeRequest('GET', `http://localhost/api/plans/${planB.id}/sessions/sess_plan_a/transcript`),
      { params: Promise.resolve({ id: planB.id, sessionId: 'sess_plan_a' }) },
    )
    expect(res.status).toBe(404)
  })

  it('returns empty array when session has no transcript', async () => {
    const project = await createProject()
    createTestSession(project.id, 'sess_empty')

    const res = await GETTranscript(
      makeRequest('GET', `http://localhost/api/plans/${project.id}/sessions/sess_empty/transcript`),
      { params: Promise.resolve({ id: project.id, sessionId: 'sess_empty' }) },
    )
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body).toEqual([])
  })

  it('returns transcript messages ordered by turn_index', async () => {
    const project = await createProject()
    createTestSession(project.id, 'sess_with_msgs')

    insertTranscriptMessage({ id: 'tm_1', session_id: 'sess_with_msgs', plan_id: project.id, role: 'user', content: [{ type: 'text', text: 'start' }], turn_index: 0 })
    insertTranscriptMessage({ id: 'tm_2', session_id: 'sess_with_msgs', plan_id: project.id, role: 'assistant', content: [{ type: 'text', text: 'ok' }], turn_index: 1 })

    const res = await GETTranscript(
      makeRequest('GET', `http://localhost/api/plans/${project.id}/sessions/sess_with_msgs/transcript`),
      { params: Promise.resolve({ id: project.id, sessionId: 'sess_with_msgs' }) },
    )
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body).toHaveLength(2)
    expect(body[0].turn_index).toBe(0)
    expect(body[0].role).toBe('user')
    expect(body[1].turn_index).toBe(1)
    expect(body[1].role).toBe('assistant')
    expect(body[0].content).toEqual([{ type: 'text', text: 'start' }])
  })
})
