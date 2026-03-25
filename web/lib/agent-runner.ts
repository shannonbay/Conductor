import { nanoid } from 'nanoid'
import { generateNickname } from './agent-nickname'
import {
  getPlan, getTask, getTreeStats,
  createSession, updateSession, getActiveSession, lockSubtree, unlockSubtree,
} from './db'
import { recordEvent } from './event-log'
import { broadcast } from './ws-broadcaster'
import {
  requireChannel,
  startAgentViaChannel,
  streamAgentEvents,
  cancelAgentViaChannel,
  sendHumanMessageToAgent,
} from './channel-client'

// ─── In-memory abort controllers (cancel) ────────────────────────────────────
const abortControllers = new Map<string, AbortController>()

// ─── Channel request IDs for active agent runs ───────────────────────────────
const agentRequestIds = new Map<string, string>() // planId → channel requestId

// ─── Pending human messages (prompt bar injection) ────────────────────────────
export function enqueueUserMessage(planId: string, message: string): void {
  const requestId = agentRequestIds.get(planId)
  if (requestId) {
    sendHumanMessageToAgent(requestId, message).catch(console.error)
  }
}

// ─── Agent runner ─────────────────────────────────────────────────────────────

export async function startAgent(planId: string, rootTaskId: string): Promise<{ sessionId: string }> {
  const existing = getActiveSession(planId)
  if (existing) throw new Error(`An agent session is already active for this plan: ${existing.id}`)

  const plan = getPlan(planId)
  if (!plan) throw new Error(`Plan ${planId} not found`)

  const task = getTask(planId, rootTaskId)
  if (!task) throw new Error(`Task ${rootTaskId} not found`)

  // Check channel is connected before creating a session
  await requireChannel()

  const sessionId = nanoid()
  const now = new Date().toISOString()

  createSession({
    id: sessionId,
    plan_id: planId,
    root_task_id: rootTaskId,
    nickname: generateNickname(),
    status: 'running',
    autonomy_level: 'full',
    model: 'claude-sonnet-4-6',
    started_at: now,
  })

  lockSubtree(sessionId, planId, rootTaskId)
  recordEvent({ planId, taskId: rootTaskId, eventType: 'agent_started', actor: 'agent', sessionId })
  broadcast(planId, { type: 'agent_started', sessionId, rootTaskId })

  const controller = new AbortController()
  abortControllers.set(planId, controller)

  // Run agent asynchronously (non-blocking)
  runAgentLoop(sessionId, planId, rootTaskId, plan.name, plan.working_dir, controller).catch((err) => {
    console.error('[AgentRunner] Unhandled error:', err)
  })

  return { sessionId }
}

async function runAgentLoop(
  sessionId: string,
  planId: string,
  rootTaskId: string,
  planName: string,
  workingDir: string | null,
  controller: AbortController,
): Promise<void> {
  try {
    const requestId = await startAgentViaChannel({
      planId,
      rootTaskId,
      planName,
      workingDir: workingDir ?? process.cwd(),
    })

    agentRequestIds.set(planId, requestId)

    for await (const event of streamAgentEvents(requestId, controller.signal)) {
      if (controller.signal.aborted) break

      if (event.type === 'update') {
        const eventType = event.tool ? 'tool_call' : 'agent_message'
        broadcast(planId, {
          type: 'agent_turn',
          sessionId,
          message: event.message,
          tool: event.tool ?? null,
        })
        recordEvent({
          planId,
          taskId: rootTaskId,
          eventType,
          actor: 'agent',
          sessionId,
          payload: { message: event.message, tool: event.tool ?? undefined },
        })
      } else if (event.type === 'done') {
        updateSession(sessionId, { status: 'completed', ended_at: new Date().toISOString() })
        recordEvent({ planId, taskId: rootTaskId, eventType: 'agent_completed', actor: 'agent', sessionId })
        broadcast(planId, { type: 'agent_completed', sessionId })
        return
      } else if (event.type === 'cancelled') {
        // Session status already set by cancelAgent(); just return
        return
      } else if (event.type === 'error') {
        throw new Error(event.message ?? 'Agent error')
      }
    }

    // SSE stream ended without a done/cancelled event (e.g. connection dropped)
    if (!controller.signal.aborted) {
      const session = getActiveSession(planId)
      if (session && session.status === 'running') {
        updateSession(sessionId, { status: 'failed', ended_at: new Date().toISOString(), error: 'Stream ended unexpectedly' })
        recordEvent({ planId, taskId: rootTaskId, eventType: 'agent_failed', actor: 'agent', sessionId, payload: { error: 'Stream ended unexpectedly' } })
        broadcast(planId, { type: 'agent_failed', sessionId, error: 'Stream ended unexpectedly' })
      }
    }
  } catch (err) {
    if (controller.signal.aborted) return // cancelled cleanly
    const errMsg = err instanceof Error ? err.message : String(err)
    const session = getActiveSession(planId)
    if (session && session.status !== 'cancelled') {
      updateSession(sessionId, { status: 'failed', ended_at: new Date().toISOString(), error: errMsg })
      recordEvent({ planId, taskId: rootTaskId, eventType: 'agent_failed', actor: 'agent', sessionId, payload: { error: errMsg } })
      broadcast(planId, { type: 'agent_failed', sessionId, error: errMsg })
    }
  } finally {
    unlockSubtree(sessionId, planId)
    abortControllers.delete(planId)
    agentRequestIds.delete(planId)
  }
}

export function pauseAgent(planId: string): void {
  const session = getActiveSession(planId)
  if (!session || session.status !== 'running') throw new Error('No running agent session')
  updateSession(session.id, { status: 'paused' })
  recordEvent({ planId, taskId: session.root_task_id, eventType: 'agent_paused', actor: 'human', sessionId: session.id })
  broadcast(planId, { type: 'agent_paused', sessionId: session.id })
}

export function resumeAgent(planId: string): void {
  const session = getActiveSession(planId)
  if (!session || session.status !== 'paused') throw new Error('No paused agent session')
  updateSession(session.id, { status: 'running' })
  recordEvent({ planId, taskId: session.root_task_id, eventType: 'agent_resumed', actor: 'human', sessionId: session.id })
  broadcast(planId, { type: 'agent_resumed', sessionId: session.id })
}

export async function cancelAgent(planId: string): Promise<void> {
  const session = getActiveSession(planId)
  if (!session) throw new Error('No active agent session')

  const controller = abortControllers.get(planId)
  if (controller) controller.abort()

  // Ask Claude Code to stop via channel (best-effort)
  const requestId = agentRequestIds.get(planId)
  if (requestId) {
    await cancelAgentViaChannel(requestId)
    agentRequestIds.delete(planId)
  }

  updateSession(session.id, { status: 'cancelled', ended_at: new Date().toISOString() })
  unlockSubtree(session.id, planId)
  recordEvent({ planId, taskId: session.root_task_id, eventType: 'agent_cancelled', actor: 'human', sessionId: session.id })
  broadcast(planId, { type: 'agent_cancelled', sessionId: session.id })
}
