'use client'

import { useEffect, useRef, useState } from 'react'
import { useRouter } from 'next/navigation'
import type { AgentSession } from '@/lib/db'

interface Props {
  session: AgentSession | null
  projectId: string
}

export function AgentBadge({ session, projectId }: Props) {
  const router = useRouter()
  const [open, setOpen] = useState(false)
  const [acting, setActing] = useState(false)
  const ref = useRef<HTMLDivElement>(null)

  // Close on outside click
  useEffect(() => {
    if (!open) return
    function handler(e: MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false)
    }
    document.addEventListener('mousedown', handler)
    return () => document.removeEventListener('mousedown', handler)
  }, [open])

  if (!session) return null

  const isRunning = session.status === 'running'
  const isPaused = session.status === 'paused'
  const nickname = session.nickname || 'Agent'

  async function handlePause() {
    setActing(true)
    await fetch(`/api/projects/${projectId}/agent/pause`, { method: 'POST' })
    router.refresh()
    setActing(false)
    setOpen(false)
  }

  async function handleResume() {
    setActing(true)
    await fetch(`/api/projects/${projectId}/agent/resume`, { method: 'POST' })
    router.refresh()
    setActing(false)
    setOpen(false)
  }

  async function handleCancel() {
    setActing(true)
    await fetch(`/api/projects/${projectId}/agent/cancel`, { method: 'POST' })
    router.refresh()
    setActing(false)
    setOpen(false)
  }

  async function handleTerminateAll() {
    setActing(true)
    await fetch('/api/agent/terminate-all', { method: 'POST' })
    router.refresh()
    setActing(false)
    setOpen(false)
  }

  return (
    <div ref={ref} className="relative">
      <button
        onClick={() => setOpen((o) => !o)}
        className={`text-xs px-2 py-0.5 rounded font-medium ${
          isRunning ? 'bg-blue-100 text-blue-700 hover:bg-blue-200' : 'bg-amber-100 text-amber-700 hover:bg-amber-200'
        }`}
      >
        🤖 {nickname} {session.status}
      </button>

      {open && (
        <div className="absolute right-0 top-full mt-1 z-50 bg-white border border-gray-200 rounded-lg shadow-lg min-w-48 py-1 text-sm">
          <div className="px-3 py-2 border-b">
            <div className="font-medium text-gray-800">🤖 {nickname}</div>
            <div className={`text-xs mt-0.5 ${isRunning ? 'text-blue-600' : 'text-amber-600'}`}>
              ● {session.status}
            </div>
          </div>

          <div className="px-2 py-1.5 flex gap-1.5">
            {isRunning && (
              <button
                onClick={handlePause}
                disabled={acting}
                className="flex-1 px-2 py-1 text-xs border border-amber-300 text-amber-700 rounded hover:bg-amber-50 disabled:opacity-50"
              >
                Pause
              </button>
            )}
            {isPaused && (
              <button
                onClick={handleResume}
                disabled={acting}
                className="flex-1 px-2 py-1 text-xs border border-blue-300 text-blue-700 rounded hover:bg-blue-50 disabled:opacity-50"
              >
                Resume
              </button>
            )}
            <button
              onClick={handleCancel}
              disabled={acting}
              className="flex-1 px-2 py-1 text-xs border border-red-200 text-red-600 rounded hover:bg-red-50 disabled:opacity-50"
            >
              ✕ Cancel
            </button>
          </div>

          <div className="border-t mx-2" />

          <button
            onClick={handleTerminateAll}
            disabled={acting}
            className="w-full text-left px-3 py-1.5 text-xs text-red-600 hover:bg-red-50 disabled:opacity-50"
          >
            Terminate All Agents
          </button>
        </div>
      )}
    </div>
  )
}
