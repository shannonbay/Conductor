'use client'

import { useState } from 'react'
import type { ProposedTask } from '@/lib/planning'

interface Props {
  proposed: ProposedTask[]
  projectId: string
  parentTaskId: string
  onClose: () => void
  onAccepted: () => void
}

export function PlanDraftOverlay({ proposed, projectId, parentTaskId, onClose, onAccepted }: Props) {
  const [tasks, setTasks] = useState<(ProposedTask & { accepted: boolean })[]>(
    proposed.map((t) => ({ ...t, accepted: true })),
  )
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)

  function toggleTask(i: number) {
    setTasks((prev) => prev.map((t, idx) => idx === i ? { ...t, accepted: !t.accepted } : t))
  }

  function updateGoal(i: number, goal: string) {
    setTasks((prev) => prev.map((t, idx) => idx === i ? { ...t, goal } : t))
  }

  async function handleAccept() {
    const accepted = tasks.filter((t) => t.accepted)
    if (accepted.length === 0) { onClose(); return }
    setLoading(true)
    setError(null)
    const res = await fetch(`/api/projects/${projectId}/tasks/${parentTaskId}/plan/accept`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ tasks: accepted.map(({ goal, plan, suggested_depends_on }) => ({ goal, plan, depends_on: suggested_depends_on })) }),
    })
    const data = await res.json()
    if (!res.ok) { setError(data.error); setLoading(false) }
    else onAccepted()
  }

  const acceptedCount = tasks.filter((t) => t.accepted).length

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4">
      <div className="bg-white rounded-xl shadow-xl w-full max-w-2xl max-h-[80vh] flex flex-col">
        <div className="px-6 py-4 border-b flex items-center justify-between flex-shrink-0">
          <h2 className="font-semibold text-gray-900">AI-Proposed Plan</h2>
          <button onClick={onClose} className="text-gray-400 hover:text-gray-700">✕</button>
        </div>

        <div className="overflow-y-auto flex-1 p-6 space-y-4">
          <p className="text-sm text-gray-500">Review and edit the proposed tasks. Uncheck any you don't want to create.</p>
          {tasks.map((task, i) => (
            <div
              key={i}
              className={`rounded-lg border-2 p-4 transition-colors ${task.accepted ? 'border-blue-200 bg-blue-50' : 'border-gray-200 bg-gray-50 opacity-60'}`}
            >
              <div className="flex items-start gap-3">
                <input
                  type="checkbox"
                  checked={task.accepted}
                  onChange={() => toggleTask(i)}
                  className="mt-0.5 flex-shrink-0"
                />
                <div className="flex-1 min-w-0">
                  <input
                    value={task.goal}
                    onChange={(e) => updateGoal(i, e.target.value)}
                    className="w-full text-sm font-medium bg-transparent border-0 border-b border-transparent hover:border-gray-300 focus:border-blue-400 focus:outline-none px-0 py-0.5"
                  />
                  <ol className="mt-2 space-y-0.5">
                    {task.plan.map((step, j) => (
                      <li key={j} className="text-xs text-gray-600 flex gap-1">
                        <span className="text-gray-400 flex-shrink-0">{j + 1}.</span>
                        {step}
                      </li>
                    ))}
                  </ol>
                  {task.suggested_depends_on.length > 0 && (
                    <p className="text-xs text-gray-400 mt-1">
                      Depends on: {task.suggested_depends_on.join(', ')}
                    </p>
                  )}
                </div>
              </div>
            </div>
          ))}
        </div>

        {error && <p className="px-6 text-sm text-red-600">{error}</p>}

        <div className="px-6 py-4 border-t flex justify-end gap-3 flex-shrink-0">
          <button onClick={onClose} className="px-4 py-2 text-sm text-gray-600 hover:text-gray-900">
            Dismiss
          </button>
          <button
            onClick={handleAccept}
            disabled={loading || acceptedCount === 0}
            className="px-4 py-2 text-sm bg-blue-600 text-white rounded-lg hover:bg-blue-700 disabled:opacity-50"
          >
            {loading ? 'Creating…' : `Accept ${acceptedCount} task${acceptedCount !== 1 ? 's' : ''}`}
          </button>
        </div>
      </div>
    </div>
  )
}
