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
  | 'project_created'
  | 'project_updated'
  | 'project_archived'
  | 'project_restored'
  | 'task_deleted'

interface RecordEventOptions {
  projectId: string
  taskId: string
  eventType: EventType
  actor: 'human' | 'agent'
  sessionId?: string | null
  payload?: Record<string, unknown>
}

export function recordEvent(opts: RecordEventOptions): void {
  const event = {
    id: nanoid(),
    project_id: opts.projectId,
    task_id: opts.taskId,
    event_type: opts.eventType,
    actor: opts.actor,
    session_id: opts.sessionId ?? null,
    payload: opts.payload ?? {},
    created_at: new Date().toISOString(),
  }
  insertEvent(event)
  broadcast(opts.projectId, { type: 'event', event })
}
