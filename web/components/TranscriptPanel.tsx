'use client'

import { useEffect, useState } from 'react'
import type { AgentSession, TranscriptMessage } from '@/lib/db'

// ── Content block type helpers ────────────────────────────────────────────────

type ContentBlock = Record<string, unknown>

function isTextBlock(b: ContentBlock): b is { type: 'text'; text: string } {
  return b.type === 'text'
}

function isToolUseBlock(b: ContentBlock): b is { type: 'tool_use'; id: string; name: string; input: unknown } {
  return b.type === 'tool_use'
}

function isToolResultBlock(b: ContentBlock): b is { type: 'tool_result'; tool_use_id: string; content: string } {
  return b.type === 'tool_result'
}

// ── Sub-components ────────────────────────────────────────────────────────────

function CollapsibleBlock({ label, children }: { label: string; children: React.ReactNode }) {
  const [open, setOpen] = useState(false)
  return (
    <div className="border border-gray-200 rounded text-xs my-1">
      <button
        className="w-full text-left px-2 py-1 flex items-center gap-1 text-gray-500 hover:bg-gray-50"
        onClick={() => setOpen((v) => !v)}
      >
        <span className="text-gray-400">{open ? '▾' : '▸'}</span>
        {label}
      </button>
      {open && <div className="px-2 pb-2 pt-1 border-t border-gray-100">{children}</div>}
    </div>
  )
}

function AssistantTurn({ blocks }: { blocks: ContentBlock[] }) {
  return (
    <div className="flex gap-2">
      <span className="flex-shrink-0 text-xs font-medium text-blue-600 w-16 pt-0.5">Assistant</span>
      <div className="flex-1 min-w-0 space-y-1">
        {blocks.map((b, i) => {
          if (isTextBlock(b) && b.text.trim()) {
            return (
              <p key={i} className="text-xs text-gray-800 whitespace-pre-wrap break-words">
                {b.text}
              </p>
            )
          }
          if (isToolUseBlock(b)) {
            return (
              <CollapsibleBlock key={i} label={`tool: ${b.name}`}>
                <pre className="text-xs text-gray-600 overflow-x-auto whitespace-pre-wrap break-all">
                  {JSON.stringify(b.input, null, 2)}
                </pre>
              </CollapsibleBlock>
            )
          }
          return null
        })}
      </div>
    </div>
  )
}

function UserTurn({ blocks }: { blocks: ContentBlock[] }) {
  // Plain string content (initial message or injected human message)
  if (blocks.length === 1 && isTextBlock(blocks[0])) {
    return (
      <div className="flex gap-2">
        <span className="flex-shrink-0 text-xs font-medium text-gray-500 w-16 pt-0.5">User</span>
        <p className="flex-1 text-xs text-gray-700 whitespace-pre-wrap break-words">{blocks[0].text}</p>
      </div>
    )
  }

  // Tool result batch
  return (
    <div className="flex gap-2">
      <span className="flex-shrink-0 text-xs font-medium text-gray-500 w-16 pt-0.5">Results</span>
      <div className="flex-1 min-w-0 space-y-1">
        {blocks.map((b, i) => {
          if (isToolResultBlock(b)) {
            let preview = ''
            try {
              const parsed = JSON.parse(b.content)
              preview = typeof parsed === 'object' ? JSON.stringify(parsed).slice(0, 80) : String(b.content).slice(0, 80)
            } catch {
              preview = String(b.content).slice(0, 80)
            }
            return (
              <CollapsibleBlock key={i} label={`result: ${b.tool_use_id.slice(-6)} — ${preview}…`}>
                <pre className="text-xs text-gray-600 overflow-x-auto whitespace-pre-wrap break-all">
                  {b.content}
                </pre>
              </CollapsibleBlock>
            )
          }
          return null
        })}
      </div>
    </div>
  )
}

// ── Main panel ────────────────────────────────────────────────────────────────

interface Props {
  planId: string
}

export function TranscriptPanel({ planId }: Props) {
  const [sessions, setSessions] = useState<AgentSession[]>([])
  const [selectedId, setSelectedId] = useState<string>('')
  const [messages, setMessages] = useState<TranscriptMessage[]>([])
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    fetch(`/api/plans/${planId}/sessions`)
      .then((r) => r.json())
      .then((data: AgentSession[]) => {
        setSessions(data)
        if (data.length > 0 && !selectedId) setSelectedId(data[0].id)
      })
      .catch(() => {/* silent */})
  }, [planId])

  useEffect(() => {
    if (!selectedId) return
    setLoading(true)
    setError(null)
    fetch(`/api/plans/${planId}/sessions/${selectedId}/transcript`)
      .then((r) => r.json())
      .then((data: TranscriptMessage[]) => setMessages(data))
      .catch(() => setError('Failed to load transcript'))
      .finally(() => setLoading(false))
  }, [planId, selectedId])

  if (sessions.length === 0) {
    return <p className="text-xs text-gray-400 text-center py-4">No agent sessions yet</p>
  }

  return (
    <div className="flex flex-col h-full">
      {/* Session selector */}
      <div className="px-4 py-2 border-b flex items-center gap-2 flex-shrink-0">
        <label className="text-xs text-gray-500 flex-shrink-0">Session</label>
        <select
          value={selectedId}
          onChange={(e) => setSelectedId(e.target.value)}
          className="flex-1 text-xs border border-gray-200 rounded px-1.5 py-0.5 bg-white"
        >
          {sessions.map((s) => (
            <option key={s.id} value={s.id}>
              {s.nickname || s.id.slice(-8)} — {s.status} ({new Date(s.started_at).toLocaleString()})
            </option>
          ))}
        </select>
      </div>

      {/* Transcript */}
      <div className="flex-1 overflow-y-auto px-4 py-3 space-y-3">
        {loading && <p className="text-xs text-gray-400">Loading…</p>}
        {error && <p className="text-xs text-red-500">{error}</p>}
        {!loading && !error && messages.length === 0 && (
          <p className="text-xs text-gray-400">No transcript recorded for this session.</p>
        )}
        {messages.map((msg) => {
          const blocks = msg.content as ContentBlock[]
          return msg.role === 'assistant'
            ? <AssistantTurn key={msg.id} blocks={blocks} />
            : <UserTurn key={msg.id} blocks={blocks} />
        })}
      </div>
    </div>
  )
}
