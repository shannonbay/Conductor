'use client'

import { useEffect, useRef } from 'react'
import { useStore } from './store'
import type { TreeNode, AgentSession, Event } from './db'

const AGENT_LIFECYCLE_TYPES = new Set([
  'agent_started',
  'agent_completed',
  'agent_failed',
  'agent_cancelled',
  'agent_paused',
  'agent_resumed',
])

const TREE_MUTATION_TYPES = new Set([
  'task_created',
  'task_updated',
  'status_changed',
  'task_deleted',
])

export function usePlanWebSocket(planId: string) {
  const { setTree, setAgentSession, setSessionNickname, appendEvent, setEvents } = useStore()

  // Keep a stable ref to the latest store actions so the closure inside useEffect
  // always calls the current version without needing them as dependencies.
  const actionsRef = useRef({ setTree, setAgentSession, setSessionNickname, appendEvent, setEvents })
  actionsRef.current = { setTree, setAgentSession, setSessionNickname, appendEvent, setEvents }

  useEffect(() => {
    let destroyed = false
    let ws: WebSocket | null = null
    let retryCount = 0
    let retryTimeout: ReturnType<typeof setTimeout> | null = null

    function connect() {
      if (destroyed) return

      const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:'
      const url = `${protocol}//${window.location.host}/api/plans/${planId}/ws`
      ws = new WebSocket(url)

      ws.onopen = () => {
        retryCount = 0 // reset backoff on successful connection
        // Re-sync event history to catch anything missed while disconnected.
        // setEvents replaces the list; appendEvent deduplicates subsequent WS events.
        fetchEvents(planId).then(actionsRef.current.setEvents)
      }

      ws.onmessage = (msg) => {
        try {
          const data = JSON.parse(msg.data) as { type: string; [key: string]: unknown }
          const actions = actionsRef.current

          switch (data.type) {
            case 'event': {
              const event = data.event as Event
              actions.appendEvent(event)

              // Refresh tree on any task mutation
              if (TREE_MUTATION_TYPES.has(event.event_type)) {
                fetchTree(planId).then(actions.setTree)
              }

              // Refresh session state on agent lifecycle events
              if (AGENT_LIFECYCLE_TYPES.has(event.event_type)) {
                fetchSession(planId).then((session) => {
                  actions.setAgentSession(session)
                  if (session?.id && session.nickname) {
                    actions.setSessionNickname(session.id, session.nickname)
                  }
                })
              }
              break
            }

            // Legacy raw agent-lifecycle messages emitted directly by agent-runner
            // (in addition to the recordEvent / 'event' pathway). Just refresh session.
            case 'agent_started':
            case 'agent_completed':
            case 'agent_failed':
            case 'agent_cancelled':
            case 'agent_paused':
            case 'agent_resumed': {
              fetchSession(planId).then((session) => {
                actions.setAgentSession(session)
                if (session?.id && session.nickname) {
                  actions.setSessionNickname(session.id, session.nickname)
                }
              })
              break
            }

            case 'tool_call':
            case 'mcp_update': {
              // Re-fetch tree to show agent's changes
              fetchTree(planId).then(actions.setTree)
              break
            }
          }
        } catch {
          // ignore malformed messages
        }
      }

      ws.onerror = () => ws?.close()

      ws.onclose = () => {
        if (destroyed) return
        // Exponential backoff: 1s, 2s, 4s, 8s … capped at 30s
        const delay = Math.min(1000 * Math.pow(2, retryCount), 30_000)
        retryCount++
        retryTimeout = setTimeout(connect, delay)
      }
    }

    connect()

    return () => {
      destroyed = true
      if (retryTimeout) clearTimeout(retryTimeout)
      ws?.close()
    }
  }, [planId])
}

async function fetchTree(planId: string): Promise<TreeNode[]> {
  const res = await fetch(`/api/plans/${planId}/tasks`)
  if (!res.ok) return []
  return res.json()
}

async function fetchSession(planId: string): Promise<AgentSession | null> {
  const res = await fetch(`/api/plans/${planId}/agent/status`)
  if (!res.ok) return null
  return res.json()
}

async function fetchEvents(planId: string): Promise<Event[]> {
  const res = await fetch(`/api/plans/${planId}/events`)
  if (!res.ok) return []
  return res.json()
}
