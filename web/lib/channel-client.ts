/**
 * Channel client — used by the Conductor web server to communicate
 * with the Conductor channel server (which bridges to Claude Code).
 */

import { nanoid } from 'nanoid'
import type { PlanProposal } from './plan-generator'
import type { ProposedTask, ModifyDiff } from './planning'
import type { Task } from './db'

const CHANNEL_URL = process.env.CONDUCTOR_CHANNEL_URL ?? 'http://127.0.0.1:8789'

// ── Error types ───────────────────────────────────────────────────────────────

export class ChannelNotConnectedError extends Error {
  constructor() {
    super(
      'Claude Code session not connected. ' +
      'Launch Claude Code with: claude --dangerously-load-development-channels server:conductor-channel',
    )
    this.name = 'ChannelNotConnectedError'
  }
}

export class ChannelBusyError extends Error {
  constructor() {
    super('Claude Code is busy with another request. Please wait and retry.')
    this.name = 'ChannelBusyError'
  }
}

// ── Status ────────────────────────────────────────────────────────────────────

export async function getChannelStatus(): Promise<{ connected: boolean; busy: boolean }> {
  try {
    const res = await fetch(`${CHANNEL_URL}/status`, {
      signal: AbortSignal.timeout(2000),
    })
    if (!res.ok) return { connected: false, busy: false }
    return (await res.json()) as { connected: boolean; busy: boolean }
  } catch {
    return { connected: false, busy: false }
  }
}

export async function requireChannel(): Promise<void> {
  const status = await getChannelStatus()
  if (!status.connected) throw new ChannelNotConnectedError()
}

// ── One-shot request helper ───────────────────────────────────────────────────

async function channelRequest<T>(type: string, payload: unknown, timeoutMs = 60_000): Promise<T> {
  const requestId = nanoid()
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs + 5_000) // extra 5s for network

  try {
    const res = await fetch(`${CHANNEL_URL}/request`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ requestId, type, payload }),
      signal: controller.signal,
    })

    if (res.status === 503) {
      const data = (await res.json()) as { error?: string }
      if (data.error?.includes('not connected')) throw new ChannelNotConnectedError()
      throw new ChannelBusyError()
    }

    if (!res.ok) {
      const data = (await res.json().catch(() => ({}))) as { error?: string }
      throw new Error(data.error ?? `Channel request failed with status ${res.status}`)
    }

    const data = (await res.json()) as { result: T }
    return data.result
  } finally {
    clearTimeout(timer)
  }
}

// ── Plan generation ───────────────────────────────────────────────────────────

export async function generatePlanViaChannel(params: {
  planId: number
  planName: string
  description: string
  workingDir: string
  existingTasksSummary?: string
}): Promise<PlanProposal> {
  return channelRequest<PlanProposal>('generate_plan', params, 120_000)
}

// ── Task planning ─────────────────────────────────────────────────────────────

export async function planTasksViaChannel(params: {
  taskId: string
  planName: string
  goal: string
  parentGoal: string | null
  siblings: Task[]
  instruction?: string
}): Promise<ProposedTask[]> {
  return channelRequest<ProposedTask[]>('plan_tasks', params, 60_000)
}

export async function modifyTasksViaChannel(params: {
  taskId: string
  planName: string
  goal: string
  existingChildren: Task[]
  instruction: string
}): Promise<ModifyDiff> {
  return channelRequest<ModifyDiff>('modify_tasks', params, 60_000)
}

// ── Agent runner ──────────────────────────────────────────────────────────────

export async function startAgentViaChannel(params: {
  planId: string
  rootTaskId: string
  planName: string
  workingDir: string
}): Promise<string> {
  const requestId = nanoid()

  const res = await fetch(`${CHANNEL_URL}/request`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ requestId, type: 'run_agent', payload: params }),
  })

  if (res.status === 503) {
    const data = (await res.json()) as { error?: string }
    if (data.error?.includes('not connected')) throw new ChannelNotConnectedError()
    throw new ChannelBusyError()
  }

  if (!res.ok) {
    throw new Error(`Failed to start agent via channel: ${res.status}`)
  }

  const data = (await res.json()) as { requestId: string }
  return data.requestId
}

export interface AgentEvent {
  type: 'update' | 'done' | 'cancelled' | 'error'
  message?: string
  tool?: string | null
  summary?: string
}

export async function* streamAgentEvents(requestId: string, signal?: AbortSignal): AsyncGenerator<AgentEvent> {
  const res = await fetch(`${CHANNEL_URL}/stream/${requestId}`, { signal })

  if (!res.ok) throw new Error(`Agent stream not found for request ${requestId}`)
  if (!res.body) throw new Error('No response body for SSE stream')

  const reader = res.body.getReader()
  const decoder = new TextDecoder()
  let buffer = ''

  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      buffer += decoder.decode(value, { stream: true })
      const lines = buffer.split('\n')
      buffer = lines.pop() ?? ''
      for (const line of lines) {
        if (line.startsWith('data: ')) {
          const data = line.slice(6).trim()
          if (data) {
            const event = JSON.parse(data) as AgentEvent
            yield event
            if (event.type === 'done' || event.type === 'cancelled' || event.type === 'error') return
          }
        }
      }
    }
  } finally {
    reader.cancel().catch(() => {})
  }
}

export async function cancelAgentViaChannel(requestId: string): Promise<void> {
  await fetch(`${CHANNEL_URL}/control`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ requestId, action: 'cancel' }),
  }).catch(() => {}) // best-effort
}

export async function sendHumanMessageToAgent(requestId: string, message: string): Promise<void> {
  await fetch(`${CHANNEL_URL}/message`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ requestId, message }),
  }).catch(() => {}) // best-effort
}
