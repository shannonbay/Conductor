'use client'

import { useStore } from '@/lib/store'

const eventLabels: Record<string, string> = {
  task_created: 'created task',
  task_updated: 'updated task',
  status_changed: 'changed status',
  task_locked: 'locked task',
  task_unlocked: 'unlocked task',
  agent_started: 'started agent',
  agent_completed: 'agent completed',
  agent_failed: 'agent failed',
  agent_paused: 'paused agent',
  agent_resumed: 'resumed agent',
  agent_cancelled: 'cancelled agent',
  human_prompt: 'sent instruction',
  agent_message: 'said',
  project_created: 'created project',
  project_updated: 'updated project',
  project_archived: 'archived project',
  project_restored: 'restored project',
  task_deleted: 'deleted task',
}

function formatTime(iso: string): string {
  const d = new Date(iso)
  return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
}

function ActorPill({ actor }: { actor: 'human' | 'agent' }) {
  return (
    <span className={`text-xs rounded px-1.5 py-0.5 font-medium ${actor === 'agent' ? 'bg-blue-100 text-blue-700' : 'bg-gray-100 text-gray-600'}`}>
      {actor === 'agent' ? '🤖 Agent' : '👤 You'}
    </span>
  )
}

export function ActivityFeed() {
  const events = useStore((s) => s.events)

  if (events.length === 0) {
    return <p className="text-xs text-gray-400 text-center py-4">No activity yet</p>
  }

  return (
    <div className="space-y-2">
      {events.map((event) => {
        const payload = event.payload as Record<string, unknown>
        const label = eventLabels[event.event_type] ?? event.event_type
        const detail = event.event_type === 'status_changed'
          ? `${payload['from']} → ${payload['to']}${payload['reason'] ? `: ${payload['reason']}` : ''}`
          : event.task_id

        return (
          <div key={event.id} className="flex items-start gap-2 text-xs">
            <span className="text-gray-400 flex-shrink-0 tabular-nums">{formatTime(event.created_at)}</span>
            <ActorPill actor={event.actor} />
            <span className="text-gray-600 min-w-0">
              {label}{' '}
              {event.event_type === 'agent_failed' && payload['error']
                ? <span className="text-red-500 break-words">{String(payload['error'])}</span>
                : event.event_type === 'human_prompt' && payload['message']
                ? <span className="text-gray-500 italic break-words">{String(payload['message'])}</span>
                : event.event_type === 'agent_message' && payload['text']
                ? <span className="text-gray-500 break-words whitespace-pre-wrap">{String(payload['text'])}</span>
                : <span className="font-mono text-gray-400">{detail}</span>
              }
            </span>
          </div>
        )
      })}
    </div>
  )
}
