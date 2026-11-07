import type { Event, Goal, GoalRun, Task } from '@conductor/core'
import { isProposal } from '@/lib/db'

export type Activity = {
  state: 'running' | 'queued' | 'paused' | 'idle'
  /** One line: what the goal's agent is doing, or what happens next. */
  text: string
  /** When `text` last changed, for a running agent's latest step. */
  at: string | null
}

type Input = {
  goal: Pick<Goal, 'status'>
  openRun: Pick<GoalRun, 'status' | 'trigger' | 'started_at'> | null
  lastRun: Pick<GoalRun, 'summary'> | null
  /** The goal's recent events, newest first. */
  events: Pick<Event, 'event_type' | 'actor' | 'task_id' | 'payload' | 'created_at'>[]
  items: Pick<Task, 'id' | 'goal' | 'status' | 'state' | 'approved_at'>[]
}

const oneLine = (s: string) => s.replace(/\s+/g, ' ').trim()
const str = (v: unknown) => (typeof v === 'string' && v.trim() ? oneLine(v) : null)

/** What one agent event says it did, or null for events that don't describe work. */
function describeEvent(e: Input['events'][number], itemGoal: (id: string) => string | null): string | null {
  const p = e.payload
  switch (e.event_type) {
    case 'agent_message':
      return str(p.message)
    case 'tool_call':
      return str(p.tool) ? `Using ${str(p.tool)}` : null
    case 'task_created': {
      const goal = str(p.goal)
      return goal ? `Added "${goal}"${p.mode === 'propose' ? ' for approval' : ''}` : null
    }
    case 'status_changed': {
      const goal = itemGoal(e.task_id)
      if (!goal) return null
      if (p.to === 'completed') return `Completed "${goal}"`
      if (p.to === 'abandoned') return `Dropped "${goal}"`
      return null
    }
    case 'memory_added':
      return str(p.text) ? `Noted: ${str(p.text)}` : null
    default:
      return null
  }
}

/** A one-line summary of what a goal is doing now, or what it does next. */
export function describeActivity({ goal, openRun, lastRun, events, items }: Input): Activity {
  if (openRun?.status === 'running') {
    const goals = new Map(items.map((t) => [t.id, t.goal]))
    for (const e of events) {
      if (e.created_at < openRun.started_at) break
      if (e.actor !== 'agent') continue
      const text = describeEvent(e, (id) => goals.get(id) ?? null)
      if (text) return { state: 'running', text, at: e.created_at }
    }
    return { state: 'running', text: 'Starting: reading the brief', at: openRun.started_at }
  }
  if (openRun) return { state: 'queued', text: `Queued (${openRun.trigger}) — starts when Claude Code is free`, at: openRun.started_at }
  if (goal.status === 'paused') return { state: 'paused', text: 'Paused', at: null }

  const approved = items.filter((t) => isProposal(t as Task) && t.approved_at !== null && t.status === 'active')
  if (approved.length > 0) {
    const more = approved.length > 1 ? ` and ${approved.length - 1} more` : ''
    return { state: 'idle', text: `Next run carries out "${oneLine(approved[0]!.goal)}"${more}`, at: null }
  }
  const summary = str(lastRun?.summary)
  if (summary) return { state: 'idle', text: `Last run: ${summary}`, at: null }
  return { state: 'idle', text: 'Waiting for its first run', at: null }
}
