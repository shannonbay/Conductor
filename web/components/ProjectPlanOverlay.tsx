'use client'

import { useState } from 'react'
import type { ProjectPlanProposal } from '@/lib/project-planner'
import type { ProposedTask } from '@/lib/planning'

interface Props {
  projectId: string
  loading: boolean
  error: string | null
  proposal: ProjectPlanProposal | null
  onClose: () => void
  onRetry: () => void
  onAccepted: () => void
}

export function ProjectPlanOverlay({ projectId, loading, error, proposal, onClose, onRetry, onAccepted }: Props) {
  const [rootGoal, setRootGoal] = useState('')
  const [rootGoalSet, setRootGoalSet] = useState(false)
  const [children, setChildren] = useState<(ProposedTask & { accepted: boolean })[]>([])
  const [childrenSet, setChildrenSet] = useState(false)
  const [accepting, setAccepting] = useState(false)
  const [acceptError, setAcceptError] = useState<string | null>(null)

  // Sync proposal into local editable state when it first arrives
  if (proposal && !rootGoalSet) {
    setRootGoal(proposal.root.goal)
    setRootGoalSet(true)
  }
  if (proposal && !childrenSet) {
    setChildren(proposal.children.map(c => ({ ...c, accepted: true })))
    setChildrenSet(true)
  }

  function toggleChild(i: number) {
    setChildren(prev => prev.map((c, idx) => idx === i ? { ...c, accepted: !c.accepted } : c))
  }

  function updateChildGoal(i: number, goal: string) {
    setChildren(prev => prev.map((c, idx) => idx === i ? { ...c, goal } : c))
  }

  async function handleAccept() {
    if (!proposal) return
    const accepted = children.filter(c => c.accepted)
    setAccepting(true)
    setAcceptError(null)
    try {
      const res = await fetch(`/api/projects/${projectId}/generate-plan/accept`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          root: { goal: rootGoal.trim() || proposal.root.goal, plan: proposal.root.plan },
          children: accepted.map(({ goal, plan, suggested_depends_on }) => ({
            goal,
            plan,
            depends_on: suggested_depends_on,
          })),
        }),
      })
      const data = await res.json()
      if (!res.ok) throw new Error(data.error ?? 'Failed to create tasks')
      onAccepted()
    } catch (e) {
      setAcceptError(e instanceof Error ? e.message : 'Error')
    } finally {
      setAccepting(false)
    }
  }

  const acceptedCount = children.filter(c => c.accepted).length

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4">
      <div className="bg-white rounded-xl shadow-xl w-full max-w-2xl max-h-[85vh] flex flex-col">
        <div className="px-6 py-4 border-b flex items-center justify-between flex-shrink-0">
          <h2 className="font-semibold text-gray-900">AI-Generated Plan</h2>
          <button onClick={onClose} className="text-gray-400 hover:text-gray-700">✕</button>
        </div>

        <div className="overflow-y-auto flex-1 p-6">
          {loading && (
            <div className="flex flex-col items-center justify-center py-12 gap-3 text-gray-500">
              <div className="w-6 h-6 border-2 border-gray-300 border-t-gray-600 rounded-full animate-spin" />
              <p className="text-sm">Claude is exploring your project…</p>
            </div>
          )}

          {error && !loading && (
            <div className="flex flex-col items-center justify-center py-12 gap-4 text-center">
              <p className="text-sm text-red-600">{error}</p>
              <button onClick={onRetry} className="px-4 py-2 text-sm bg-gray-900 text-white rounded-lg hover:bg-gray-700">
                Retry
              </button>
            </div>
          )}

          {proposal && !loading && (
            <div className="space-y-5">
              <p className="text-sm text-gray-500">Review the proposed task tree. Edit goals, uncheck tasks you don't want.</p>

              {/* Root task */}
              <div className="rounded-lg border-2 border-violet-200 bg-violet-50 p-4">
                <p className="text-xs font-medium text-violet-500 uppercase tracking-wide mb-2">Root task</p>
                <input
                  value={rootGoal}
                  onChange={e => setRootGoal(e.target.value)}
                  className="w-full text-sm font-medium bg-transparent border-0 border-b border-transparent hover:border-gray-300 focus:border-violet-400 focus:outline-none px-0 py-0.5"
                />
                <ol className="mt-2 space-y-0.5">
                  {proposal.root.plan.map((step, i) => (
                    <li key={i} className="text-xs text-gray-600 flex gap-1">
                      <span className="text-gray-400 flex-shrink-0">{i + 1}.</span>
                      {step}
                    </li>
                  ))}
                </ol>
              </div>

              {/* Children */}
              <div className="space-y-3">
                {children.map((child, i) => (
                  <div
                    key={i}
                    className={`rounded-lg border-2 p-4 transition-colors ${child.accepted ? 'border-blue-200 bg-blue-50' : 'border-gray-200 bg-gray-50 opacity-60'}`}
                  >
                    <div className="flex items-start gap-3">
                      <input
                        type="checkbox"
                        checked={child.accepted}
                        onChange={() => toggleChild(i)}
                        className="mt-0.5 flex-shrink-0"
                      />
                      <div className="flex-1 min-w-0">
                        <input
                          value={child.goal}
                          onChange={e => updateChildGoal(i, e.target.value)}
                          className="w-full text-sm font-medium bg-transparent border-0 border-b border-transparent hover:border-gray-300 focus:border-blue-400 focus:outline-none px-0 py-0.5"
                        />
                        <ol className="mt-2 space-y-0.5">
                          {child.plan.map((step, j) => (
                            <li key={j} className="text-xs text-gray-600 flex gap-1">
                              <span className="text-gray-400 flex-shrink-0">{j + 1}.</span>
                              {step}
                            </li>
                          ))}
                        </ol>
                        {child.suggested_depends_on.length > 0 && (
                          <p className="text-xs text-gray-400 mt-1">
                            Depends on: {child.suggested_depends_on.join(', ')}
                          </p>
                        )}
                      </div>
                    </div>
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>

        {(acceptError || (proposal && !loading)) && (
          <div className="px-6 py-4 border-t flex items-center justify-between gap-3 flex-shrink-0">
            <div className="flex-1">
              {acceptError && <p className="text-sm text-red-600">{acceptError}</p>}
            </div>
            <div className="flex gap-3">
              <button onClick={onClose} className="px-4 py-2 text-sm text-gray-600 hover:text-gray-900">
                Dismiss
              </button>
              {proposal && (
                <button
                  onClick={handleAccept}
                  disabled={accepting || acceptedCount === 0}
                  className="px-4 py-2 text-sm bg-blue-600 text-white rounded-lg hover:bg-blue-700 disabled:opacity-50"
                >
                  {accepting ? 'Creating…' : `Create ${acceptedCount + 1} task${acceptedCount + 1 !== 1 ? 's' : ''}`}
                </button>
              )}
            </div>
          </div>
        )}
      </div>
    </div>
  )
}
