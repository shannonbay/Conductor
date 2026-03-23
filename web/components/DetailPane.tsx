'use client'

import { useState, useCallback } from 'react'
import { useRouter } from 'next/navigation'
import { useStore } from '@/lib/store'
import { StatusBadge } from './StatusBadge'
import { PlanDraftOverlay } from './PlanDraftOverlay'
import type { Task } from '@/lib/db'
import type { ProposedTask } from '@/lib/planning'

interface Props {
  projectId: string
}

export function DetailPane({ projectId }: Props) {
  const { selectedTaskId, taskMap, setPlanDraft, planDraft, agentSession } = useStore()
  const task = selectedTaskId ? taskMap.get(selectedTaskId) : null
  const router = useRouter()

  const [notesValue, setNotesValue] = useState('')
  const [notesKey, setNotesKey] = useState(0)
  const [planLoading, setPlanLoading] = useState(false)
  const [agentLoading, setAgentLoading] = useState(false)
  const [instruction, setInstruction] = useState('')
  const [showInstructionInput, setShowInstructionInput] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [statusLoading, setStatusLoading] = useState(false)

  if (!task) {
    return (
      <div className="flex-1 flex items-center justify-center text-gray-400 text-sm p-8 text-center">
        Select a task to see its details
      </div>
    )
  }

  async function handleNotesSave() {
    if (!task) return
    await fetch(`/api/projects/${projectId}/tasks/${task.id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ notes: notesValue }),
    })
    router.refresh()
  }

  async function handleStatusChange(status: Task['status'], reason?: string) {
    if (!task) return
    setStatusLoading(true)
    setError(null)
    const res = await fetch(`/api/projects/${projectId}/tasks/${task.id}/status`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ status, reason }),
    })
    const data = await res.json()
    if (!res.ok) setError(data.error)
    else router.refresh()
    setStatusLoading(false)
  }

  async function handleRunAgent() {
    if (!task) return
    setAgentLoading(true)
    setError(null)
    const res = await fetch(`/api/projects/${projectId}/agent/run`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ task_id: task.id }),
    })
    const data = await res.json()
    if (!res.ok) setError(data.error)
    else router.refresh()
    setAgentLoading(false)
  }

  async function handlePlan() {
    if (!task) return
    setPlanLoading(true)
    setError(null)
    const res = await fetch(`/api/projects/${projectId}/tasks/${task.id}/plan`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ instruction: instruction || undefined }),
    })
    const data = await res.json()
    if (!res.ok) setError(data.error)
    else {
      setPlanDraft(data.proposed)
      setShowInstructionInput(false)
      setInstruction('')
    }
    setPlanLoading(false)
  }

  async function handleCancelAgent() {
    await fetch(`/api/projects/${projectId}/agent/cancel`, { method: 'POST' })
    router.refresh()
  }

  async function handlePauseAgent() {
    await fetch(`/api/projects/${projectId}/agent/pause`, { method: 'POST' })
    router.refresh()
  }

  async function handleResumeAgent() {
    await fetch(`/api/projects/${projectId}/agent/resume`, { method: 'POST' })
    router.refresh()
  }

  const isLocked = Boolean(task.locked_by)
  const agentIsRunning = agentSession?.status === 'running'

  return (
    <div className="flex-1 overflow-y-auto p-5 space-y-5">
      {/* Header */}
      <div className="flex items-start gap-3">
        <span className="text-xs font-mono text-gray-400 mt-1 flex-shrink-0">{task.id}</span>
        <div className="flex-1 min-w-0">
          <h2 className="text-base font-semibold text-gray-900 break-words">{task.goal}</h2>
          <div className="flex items-center gap-2 mt-1">
            <StatusBadge status={task.status} />
            {isLocked && <span className="text-xs text-blue-600">🤖 Agent working</span>}
          </div>
        </div>
      </div>

      {/* Dependencies */}
      {task.depends_on && task.depends_on.length > 0 && (
        <div>
          <p className="text-xs font-medium text-gray-500 mb-1">Depends on</p>
          <div className="flex gap-2 flex-wrap">
            {task.depends_on.map((depId) => (
              <span key={depId} className="text-xs bg-gray-100 rounded px-2 py-0.5 font-mono">{depId}</span>
            ))}
          </div>
        </div>
      )}

      {/* Result */}
      {task.result && (
        <div>
          <p className="text-xs font-medium text-gray-500 mb-1">Result</p>
          <p className="text-sm text-gray-700 whitespace-pre-wrap">{task.result}</p>
        </div>
      )}

      {/* Abandon reason */}
      {task.abandon_reason && (
        <div>
          <p className="text-xs font-medium text-red-500 mb-1">Abandoned reason</p>
          <p className="text-sm text-red-600">{task.abandon_reason}</p>
        </div>
      )}

      {/* State */}
      {Object.keys(task.state).length > 0 && (
        <details>
          <summary className="text-xs font-medium text-gray-500 cursor-pointer mb-1">State</summary>
          <pre className="text-xs bg-gray-50 rounded-lg p-3 overflow-x-auto text-gray-600 mt-2">
            {JSON.stringify(task.state, null, 2)}
          </pre>
        </details>
      )}

      {/* Notes */}
      <div>
        <p className="text-xs font-medium text-gray-500 mb-1">Human Notes</p>
        <textarea
          key={`notes-${task.id}-${notesKey}`}
          defaultValue={task.notes ?? ''}
          onChange={(e) => setNotesValue(e.target.value)}
          onBlur={handleNotesSave}
          placeholder="Add notes for the agent..."
          rows={3}
          className="w-full border border-gray-200 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-1 focus:ring-gray-400 resize-none"
        />
      </div>

      {/* Error */}
      {error && <p className="text-sm text-red-600 bg-red-50 rounded-lg px-3 py-2">{error}</p>}

      {/* Actions */}
      <div className="space-y-2">
        {/* Agent controls */}
        {agentSession ? (
          <div className="flex gap-2">
            {agentSession.status === 'running' && (
              <button onClick={handlePauseAgent} className="flex-1 px-3 py-2 text-sm border border-amber-300 text-amber-700 rounded-lg hover:bg-amber-50">
                Pause Agent
              </button>
            )}
            {agentSession.status === 'paused' && (
              <button onClick={handleResumeAgent} className="flex-1 px-3 py-2 text-sm border border-blue-300 text-blue-700 rounded-lg hover:bg-blue-50">
                Resume Agent
              </button>
            )}
            <button onClick={handleCancelAgent} className="flex-1 px-3 py-2 text-sm border border-red-200 text-red-600 rounded-lg hover:bg-red-50">
              Cancel Agent
            </button>
          </div>
        ) : (
          <button
            onClick={handleRunAgent}
            disabled={agentLoading || isLocked || task.status === 'completed' || task.status === 'abandoned'}
            className="w-full px-3 py-2 text-sm bg-gray-900 text-white rounded-lg hover:bg-gray-700 disabled:opacity-50 disabled:cursor-not-allowed"
          >
            {agentLoading ? 'Starting…' : '🤖 Run Agent'}
          </button>
        )}

        {/* Plan / Modify Plan */}
        {task.status !== 'completed' && task.status !== 'abandoned' && (
          <div className="space-y-2">
            {showInstructionInput ? (
              <div className="space-y-2">
                <textarea
                  autoFocus
                  value={instruction}
                  onChange={(e) => setInstruction(e.target.value)}
                  placeholder="Optional: add an instruction for the planner..."
                  rows={2}
                  className="w-full border border-gray-200 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-1 focus:ring-gray-400 resize-none"
                />
                <div className="flex gap-2">
                  <button
                    onClick={handlePlan}
                    disabled={planLoading}
                    className="flex-1 px-3 py-2 text-sm bg-blue-600 text-white rounded-lg hover:bg-blue-700 disabled:opacity-50"
                  >
                    {planLoading ? 'Planning…' : 'Generate Plan'}
                  </button>
                  <button
                    onClick={() => { setShowInstructionInput(false); setInstruction('') }}
                    className="px-3 py-2 text-sm text-gray-600 hover:text-gray-900"
                  >
                    Cancel
                  </button>
                </div>
              </div>
            ) : (
              <button
                onClick={() => setShowInstructionInput(true)}
                disabled={planLoading}
                className="w-full px-3 py-2 text-sm border border-gray-200 text-gray-700 rounded-lg hover:bg-gray-50"
              >
                ✨ Plan (AI-assisted decomposition)
              </button>
            )}
          </div>
        )}

        {/* Status actions */}
        {task.status === 'active' && (
          <button
            onClick={() => handleStatusChange('completed')}
            disabled={statusLoading}
            className="w-full px-3 py-2 text-sm border border-green-200 text-green-700 rounded-lg hover:bg-green-50"
          >
            Mark Complete
          </button>
        )}
        {task.status === 'pending' && (
          <button
            onClick={() => handleStatusChange('active')}
            disabled={statusLoading}
            className="w-full px-3 py-2 text-sm border border-blue-200 text-blue-700 rounded-lg hover:bg-blue-50"
          >
            Activate
          </button>
        )}
        {(task.status === 'active' || task.status === 'pending') && (
          <button
            onClick={() => {
              const reason = prompt('Reason for abandoning?')
              if (reason) handleStatusChange('abandoned', reason)
            }}
            disabled={statusLoading}
            className="w-full px-3 py-2 text-sm border border-red-200 text-red-600 rounded-lg hover:bg-red-50"
          >
            Abandon
          </button>
        )}
      </div>

      {/* Plan draft overlay */}
      {planDraft && (
        <PlanDraftOverlay
          proposed={planDraft}
          projectId={projectId}
          parentTaskId={task.id}
          onClose={() => setPlanDraft(null)}
          onAccepted={() => { setPlanDraft(null); router.refresh() }}
        />
      )}
    </div>
  )
}
