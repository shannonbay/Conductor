'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'

/** "New goal" dialog: a persistent goal is an objective agents work on repeatedly. */
export function NewGoalButton() {
  const [open, setOpen] = useState(false)
  const [name, setName] = useState('')
  const [objective, setObjective] = useState('')
  const [instructions, setInstructions] = useState('')
  const [workingDir, setWorkingDir] = useState(() =>
    typeof window === 'undefined' ? '' : (localStorage.getItem('quarterdeck:lastBrowseDir') ?? ''))
  const [interval, setIntervalMinutes] = useState('')
  const [activeHours, setActiveHours] = useState('')
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const router = useRouter()

  async function handleCreate(e: React.FormEvent) {
    e.preventDefault()
    setLoading(true)
    setError(null)
    try {
      const res = await fetch('/api/goals', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: name.trim(),
          objective: objective.trim(),
          instructions,
          working_dir: workingDir.trim(),
          interval_minutes: interval ? Number(interval) : null,
          active_hours: activeHours.trim() || null,
        }),
      })
      const data = await res.json()
      if (!res.ok) throw new Error(data.error ?? 'Failed to create goal')
      router.push(`/goals/${data.id}`)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Error')
      setLoading(false)
    }
  }

  const input = 'w-full border border-gray-200 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-1 focus:ring-gray-400'

  return (
    <>
      <button onClick={() => setOpen(true)} className="px-4 py-2 text-sm border border-gray-300 text-gray-700 rounded-lg hover:bg-gray-50">
        + New goal
      </button>
      {open && (
        <div className="fixed inset-0 bg-black/30 flex items-center justify-center z-50 p-4" onClick={() => setOpen(false)}>
          <form onSubmit={handleCreate} onClick={(e) => e.stopPropagation()} className="bg-white rounded-xl shadow-xl w-full max-w-lg p-6 space-y-4 max-h-[90vh] overflow-y-auto">
            <div>
              <h2 className="text-lg font-semibold text-gray-900">New goal</h2>
              <p className="text-sm text-gray-500 mt-1">
                A standing objective an agent works on repeatedly — each run reads its instructions and memory, handles what&apos;s new, and leaves a summary for the next.
              </p>
            </div>
            <label className="block space-y-1">
              <span className="text-xs font-medium text-gray-600">Name</span>
              <input autoFocus value={name} onChange={(e) => setName(e.target.value)} placeholder="Inbox" className={input} required />
            </label>
            <label className="block space-y-1">
              <span className="text-xs font-medium text-gray-600">Objective — what &ldquo;under control&rdquo; means</span>
              <input value={objective} onChange={(e) => setObjective(e.target.value)} placeholder="No unhandled mail older than a day" className={input} required />
            </label>
            <label className="block space-y-1">
              <span className="text-xs font-medium text-gray-600">Standing instructions</span>
              <textarea
                value={instructions}
                onChange={(e) => setInstructions(e.target.value)}
                rows={4}
                placeholder={'Archive newsletters and receipts.\nFlag anything from Alice or the bank.\nDraft replies to questions addressed to me.'}
                className={`${input} resize-none`}
              />
            </label>
            <label className="block space-y-1">
              <span className="text-xs font-medium text-gray-600">Working directory</span>
              <input value={workingDir} onChange={(e) => setWorkingDir(e.target.value)} placeholder="C:\Users\you\inbox-agent" className={`${input} font-mono`} required />
            </label>
            <div className="grid grid-cols-2 gap-3">
              <label className="block space-y-1">
                <span className="text-xs font-medium text-gray-600">Run every (minutes)</span>
                <input value={interval} onChange={(e) => setIntervalMinutes(e.target.value.replace(/\D/g, ''))} placeholder="Manual only" className={input} />
              </label>
              <label className="block space-y-1">
                <span className="text-xs font-medium text-gray-600">Active hours (optional)</span>
                <input value={activeHours} onChange={(e) => setActiveHours(e.target.value)} placeholder="08:00-20:00" className={input} disabled={!interval} />
              </label>
            </div>
            <p className="text-xs text-gray-500">
              Every action starts as <strong>propose</strong>: the agent asks you before doing it. You can let it act on its own per category later, in the goal&apos;s settings.
            </p>
            {error && <p className="text-sm text-red-600 bg-red-50 rounded-lg px-3 py-2">{error}</p>}
            <div className="flex justify-end gap-2">
              <button type="button" onClick={() => setOpen(false)} className="px-4 py-2 text-sm text-gray-600 hover:text-gray-900">Cancel</button>
              <button type="submit" disabled={loading} className="px-4 py-2 text-sm bg-gray-900 text-white rounded-lg hover:bg-gray-700 disabled:opacity-50">
                {loading ? 'Creating…' : 'Create goal'}
              </button>
            </div>
          </form>
        </div>
      )}
    </>
  )
}
