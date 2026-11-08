import { nanoid } from 'nanoid'
import { insertEvent } from './db.js'

/**
 * Writes an MCP change to the shared events table (actor "agent") so it shows
 * up in the web activity feed and get_history next to changes made in the UI.
 * Plan-level events use the plan ID as task_id, matching the web app.
 */
export function record(
  planId: string, taskId: string, eventType: string, payload: Record<string, unknown> = {},
  opts: { actor?: 'agent' | 'human'; via?: string } = {},
): void {
  insertEvent({
    id: nanoid(),
    plan_id: planId,
    task_id: taskId,
    event_type: eventType,
    actor: opts.actor ?? 'agent',
    payload: { ...payload, via: opts.via ?? 'mcp' },
  })
}
