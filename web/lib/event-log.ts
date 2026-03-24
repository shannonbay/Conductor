import { nanoid } from 'nanoid'
import { insertEvent } from './db'
import { broadcast } from './ws-broadcaster'

export type EventType =
  | 'task_created'
  | 'task_updated'
  | 'status_changed'
  | 'task_locked'
  | 'task_unlocked'
  | 'approval_requested'
  | 'approval_granted'
  | 'agent_started'
  | 'agent_completed'
  | 'agent_failed'
  | 'agent_paused'
  | 'agent_resumed'
  | 'agent_cancelled'
  | 'human_prompt'
  | 'agent_message'
  | 'tool_call'
  | 'plan_created'
  | 'plan_updated'
  | 'plan_archived'
  | 'plan_restored'
  | 'task_deleted'

interface RecordEventOptions {
  planId: string
  taskId: string
  eventType: EventType
  actor: 'human' | 'agent'
  sessionId?: string | null
  payload?: Record<string, unknown>
}

export function recordEvent(opts: RecordEventOptions): void {
  const event = {
    id: nanoid(),
    plan_id: opts.planId,
    task_id: opts.taskId,
    event_type: opts.eventType,
    actor: opts.actor,
    session_id: opts.sessionId ?? null,
    payload: opts.payload ?? {},
    created_at: new Date().toISOString(),
  }
  insertEvent(event)
  broadcast(opts.planId, { type: 'event', event })
}
