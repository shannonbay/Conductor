'use client'

import { useEffect } from 'react'
import { useStore } from './store'
import type { TreeNode, Task, AgentSession, Event } from './db'

export function useProjectWebSocket(projectId: string) {
  const { setTree, updateTask, removeTask, setAgentSession, appendEvent } = useStore()

  useEffect(() => {
    const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:'
    const url = `${protocol}//${window.location.host}/api/projects/${projectId}/ws`
    const ws = new WebSocket(url)

    ws.onmessage = (msg) => {
      try {
        const data = JSON.parse(msg.data) as { type: string; [key: string]: unknown }
        switch (data.type) {
          case 'event': {
            const event = data.event as Event
            appendEvent(event)
            // Refresh tree data on any tree mutation
            if (['task_created', 'task_updated', 'status_changed', 'task_deleted'].includes(event.event_type)) {
              fetchTree(projectId).then(setTree)
            }
            break
          }
          case 'agent_started':
          case 'agent_completed':
          case 'agent_failed':
          case 'agent_cancelled':
          case 'agent_paused':
          case 'agent_resumed': {
            fetchSession(projectId).then(setAgentSession)
            break
          }
          case 'tool_call': {
            // Re-fetch tree to show agent's changes
            fetchTree(projectId).then(setTree)
            break
          }
        }
      } catch {
        // ignore malformed messages
      }
    }

    ws.onerror = () => ws.close()

    return () => ws.close()
  }, [projectId])
}

async function fetchTree(projectId: string): Promise<TreeNode[]> {
  const res = await fetch(`/api/projects/${projectId}/tasks`)
  if (!res.ok) return []
  return res.json()
}

async function fetchSession(projectId: string): Promise<AgentSession | null> {
  const res = await fetch(`/api/projects/${projectId}/agent/status`)
  if (!res.ok) return null
  return res.json()
}
