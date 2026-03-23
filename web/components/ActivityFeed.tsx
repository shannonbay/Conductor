'use client'

import { useEffect, useRef } from 'react'
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
  tool_call: 'ran',
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

function ActorPill({ actor, nickname }: { actor: 'human' | 'agent'; nickname?: string }) {
  return (
    <span className={`text-xs rounded px-1.5 py-0.5 font-medium ${actor === 'agent' ? 'bg-blue-100 text-blue-700' : 'bg-gray-100 text-gray-600'}`}>
      {actor === 'agent' ? `🤖 ${nickname || 'Agent'}` : '👤 You'}
    </span>
  )
}

export function ActivityFeed() {
  const events = useStore((s) => s.events)
  const sessionNicknames = useStore((s) => s.sessionNicknames)
  const bottomRef = useRef<HTMLDivElement>(null)
  // scrollAnchorRef is the outer scrollable container (passed via data-scroll-container)
  // We walk up from bottomRef to find the nearest overflow-y container and only
  // auto-scroll when the user is within 80px of the bottom.
  useEffect(() => {
    const bottom = bottomRef.current
    if (!bottom) return
    // Walk up the DOM to find the nearest scrollable ancestor
    let scrollEl: HTMLElement | null = bottom.parentElement
    while (scrollEl && scrollEl !== document.body) {
      const overflow = window.getComputedStyle(scrollEl).overflowY
      if (overflow === 'auto' || overflow === 'scroll') break
      scrollEl = scrollEl.parentElement
    }
    if (!scrollEl || scrollEl === document.body) {
      bottom.scrollIntoView({ block: 'nearest' })
      return
    }
    const distanceFromBottom = scrollEl.scrollHeight - scrollEl.scrollTop - scrollEl.clientHeight
    if (distanceFromBottom <= 80) {
      bottom.scrollIntoView({ block: 'nearest' })
    }
  }, [events.length])

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
          <div key={event.id} className="flex items-start gap-2 text-xs animate-in fade-in-0 duration-200">
            <span className="text-gray-400 flex-shrink-0 tabular-nums">{formatTime(event.created_at)}</span>
            <ActorPill actor={event.actor} nickname={event.session_id ? sessionNicknames[event.session_id] : undefined} />
            <span className="text-gray-600 min-w-0">
              {label}{' '}
              {event.event_type === 'agent_failed' && payload['error']
                ? <span className="text-red-500 break-words">{String(payload['error'])}</span>
                : event.event_type === 'human_prompt' && payload['message']
                ? <span className="text-gray-500 italic break-words">{String(payload['message'])}</span>
                : event.event_type === 'agent_message' && payload['text']
                ? <span className="text-gray-500 break-words whitespace-pre-wrap">{String(payload['text'])}</span>
                : event.event_type === 'tool_call'
                ? <span className="font-mono text-gray-400">
                    {payload['command'] ? String(payload['command'])
                      : payload['path'] ? String(payload['path'])
                      : payload['query'] ? String(payload['query'])
                      : String(payload['tool'])}
                    {payload['exit_code'] != null && Number(payload['exit_code']) !== 0
                      ? <span className="text-amber-500 ml-1">(exit {String(payload['exit_code'])})</span>
                      : null}
                    {payload['error']
                      ? <span className="text-red-400 ml-1">{String(payload['error'])}</span>
                      : null}
                  </span>
                : <span className="font-mono text-gray-400">{detail}</span>
              }
            </span>
          </div>
        )
      })}
      <div ref={bottomRef} />
    </div>
  )
}
