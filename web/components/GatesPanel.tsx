'use client'

import { useCallback, useEffect, useState } from 'react'
import { useStore } from '@/lib/store'
import type { GateStatus, Task, Verification } from '@/lib/db'

interface Props {
  planId: string
  task: Task
}

const gateLabel: Record<Verification['gate'], string> = {
  command: 'Verify command',
  criteria: 'Acceptance criteria',
  approval: 'Review',
  override: 'Override',
}

function formatTime(iso: string) {
  return new Date(iso).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })
}

/**
 * Verification gates for one task: review actions, gate editor, "Run checks",
 * and the history of check results (the evidence behind a completion).
 */
export function GatesPanel({ planId, task }: Props) {
  const { refreshTree, events } = useStore()
  const [gates, setGates] = useState<GateStatus | null>(null)
  const [history, setHistory] = useState<Verification[]>([])
  const [editing, setEditing] = useState(false)
  const [busy, setBusy] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [feedback, setFeedback] = useState('')
  const [showReject, setShowReject] = useState(false)

  // Editor fields
  const [criteriaText, setCriteriaText] = useState('')
  const [command, setCommand] = useState('')
  const [timeout, setTimeoutS] = useState('')
  const [approval, setApproval] = useState(false)

  const base = `/api/plans/${planId}/tasks/${task.id}`

  const load = useCallback(async () => {
    const res = await fetch(base)
    if (!res.ok) return
    const data = await res.json()
    setGates(data.gates)
    setHistory(data.verifications ?? [])
  }, [base])

  // Reload when the task changes or new activity arrives (e.g. an agent ran a check)
  useEffect(() => { load() }, [load, task.updated_at, events.length])

  function startEditing() {
    setCriteriaText((task.acceptance_criteria ?? []).join('\n'))
    setCommand(task.verify_command ?? '')
    setTimeoutS(task.verify_timeout_s ? String(task.verify_timeout_s) : '')
    setApproval(task.requires_approval)
    setError(null)
    setEditing(true)
  }

  async function call(label: string, path: string, init: RequestInit = { method: 'POST' }) {
    setBusy(label)
    setError(null)
    try {
      const res = await fetch(path, { headers: { 'Content-Type': 'application/json' }, ...init })
      const data = await res.json().catch(() => ({}))
      if (!res.ok) {
        setError(data.error ?? `Request failed (${res.status})`)
        return false
      }
      await Promise.all([load(), refreshTree(planId)])
      return true
    } finally {
      setBusy(null)
    }
  }

  async function saveGates() {
    const criteria = criteriaText.split('\n').map((l) => l.trim()).filter(Boolean)
    const ok = await call('save', base, {
      method: 'PATCH',
      body: JSON.stringify({
        acceptance_criteria: criteria,
        verify_command: command.trim() || null,
        verify_timeout_s: timeout.trim() ? Number(timeout) : null,
        requires_approval: approval,
      }),
    })
    if (ok) setEditing(false)
  }

  async function reject() {
    if (!feedback.trim()) { setError('Say what needs to change so the agent can fix it.'); return }
    if (await call('reject', `${base}/reject`, { method: 'POST', body: JSON.stringify({ feedback }) })) {
      setFeedback('')
      setShowReject(false)
    }
  }

  const finished = task.status === 'completed' || task.status === 'abandoned'
  const criteria = task.acceptance_criteria ?? []
  // Ticked once evidence was accepted, or once the task is completed (a human completing it judged them met)
  const criteriaMet = task.status === 'completed' || history.some((v) => v.gate === 'criteria' && v.passed)

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between">
        <p className="text-xs font-medium text-gray-500">Verification</p>
        {!editing && !finished && (
          <button onClick={startEditing} className="text-xs text-gray-500 hover:text-gray-900">
            {gates ? 'Edit gates' : '+ Add gates'}
          </button>
        )}
      </div>

      {/* Waiting for review */}
      {gates?.awaiting_review && (
        <div className="rounded-lg border border-amber-200 bg-amber-50 p-3 space-y-2">
          <p className="text-sm font-medium text-amber-900">Waiting for your review</p>
          <p className="text-xs text-amber-800">All automatic checks passed. Approve to complete the task, or send it back with feedback.</p>
          {showReject ? (
            <div className="space-y-2">
              <textarea
                autoFocus
                value={feedback}
                onChange={(e) => setFeedback(e.target.value)}
                placeholder="What needs to change? This is added to the task's notes for the agent."
                rows={3}
                className="w-full border border-amber-200 rounded-md px-2 py-1.5 text-sm bg-white focus:outline-none focus:ring-1 focus:ring-amber-400 resize-none"
              />
              <div className="flex gap-2">
                <button onClick={reject} disabled={busy !== null} className="flex-1 px-3 py-1.5 text-sm bg-red-600 text-white rounded-md hover:bg-red-700 disabled:opacity-50">
                  {busy === 'reject' ? 'Sending…' : 'Send back'}
                </button>
                <button onClick={() => setShowReject(false)} className="px-3 py-1.5 text-sm text-gray-600 hover:text-gray-900">Cancel</button>
              </div>
            </div>
          ) : (
            <div className="flex gap-2">
              <button
                onClick={() => call('approve', `${base}/approve`)}
                disabled={busy !== null}
                className="flex-1 px-3 py-1.5 text-sm bg-green-600 text-white rounded-md hover:bg-green-700 disabled:opacity-50"
              >
                {busy === 'approve' ? 'Approving…' : 'Approve'}
              </button>
              <button
                onClick={() => setShowReject(true)}
                disabled={busy !== null}
                className="flex-1 px-3 py-1.5 text-sm border border-red-200 text-red-600 rounded-md hover:bg-red-50 bg-white"
              >
                Reject…
              </button>
            </div>
          )}
        </div>
      )}

      {/* Editor */}
      {editing ? (
        <div className="space-y-3 rounded-lg border border-gray-200 p-3">
          <label className="block">
            <span className="text-xs text-gray-600">Acceptance criteria — one per line</span>
            <textarea
              value={criteriaText}
              onChange={(e) => setCriteriaText(e.target.value)}
              placeholder={'GET /users returns 401 without a token\nNew code has unit tests'}
              rows={3}
              className="mt-1 w-full border border-gray-200 rounded-md px-2 py-1.5 text-sm focus:outline-none focus:ring-1 focus:ring-gray-400 resize-none"
            />
          </label>
          <label className="block">
            <span className="text-xs text-gray-600">Verify command — runs in the plan folder, must exit 0</span>
            <input
              value={command}
              onChange={(e) => setCommand(e.target.value)}
              placeholder="npm test -- auth"
              className="mt-1 w-full border border-gray-200 rounded-md px-2 py-1.5 text-sm font-mono focus:outline-none focus:ring-1 focus:ring-gray-400"
            />
          </label>
          <div className="flex items-center gap-4">
            <label className="flex items-center gap-2 text-xs text-gray-600">
              Timeout (s)
              <input
                value={timeout}
                onChange={(e) => setTimeoutS(e.target.value.replace(/\D/g, ''))}
                placeholder="300"
                className="w-16 border border-gray-200 rounded-md px-2 py-1 text-sm focus:outline-none focus:ring-1 focus:ring-gray-400"
              />
            </label>
            <label className="flex items-center gap-2 text-xs text-gray-600">
              <input type="checkbox" checked={approval} onChange={(e) => setApproval(e.target.checked)} />
              Needs my approval
            </label>
          </div>
          <div className="flex gap-2">
            <button onClick={saveGates} disabled={busy !== null} className="flex-1 px-3 py-1.5 text-sm bg-gray-900 text-white rounded-md hover:bg-gray-700 disabled:opacity-50">
              {busy === 'save' ? 'Saving…' : 'Save gates'}
            </button>
            <button onClick={() => setEditing(false)} className="px-3 py-1.5 text-sm text-gray-600 hover:text-gray-900">Cancel</button>
          </div>
        </div>
      ) : gates ? (
        <div className="space-y-2 text-sm">
          {criteria.length > 0 && (
            <ul className="space-y-1">
              {criteria.map((c, i) => (
                <li key={i} className="flex gap-2 text-gray-700">
                  {criteriaMet ? <span className="text-green-700">✓</span> : <span className="text-gray-400">☐</span>}
                  <span className="break-words">{c}</span>
                </li>
              ))}
            </ul>
          )}
          {gates.verify_command && (
            <div className="flex items-center gap-2">
              <code className="flex-1 min-w-0 truncate text-xs bg-gray-50 border border-gray-100 rounded px-2 py-1" title={gates.verify_command}>
                {gates.verify_command}
              </code>
              {gates.last_command && (
                <span className={gates.last_command.passed ? 'text-xs text-green-700' : 'text-xs text-red-600'}>
                  {gates.last_command.passed ? '✓ passed' : `✗ exit ${gates.last_command.exit_code ?? '—'}`}
                </span>
              )}
              {!finished && (
                <button
                  onClick={() => call('run', `${base}/verify`)}
                  disabled={busy !== null}
                  className="text-xs px-2 py-1 border border-gray-200 rounded-md hover:bg-gray-50 disabled:opacity-50 flex-shrink-0"
                >
                  {busy === 'run' ? 'Running…' : 'Run checks'}
                </button>
              )}
            </div>
          )}
          {gates.requires_approval && !gates.awaiting_review && (
            <p className="text-xs text-gray-500">
              {gates.approved ? `Approved ${formatTime(gates.approved.at)}` : 'Needs your approval before it can be completed.'}
            </p>
          )}
        </div>
      ) : (
        !finished && <p className="text-xs text-gray-400">No gates — this task can be completed without checks.</p>
      )}

      {error && <p className="text-xs text-red-600 bg-red-50 rounded-md px-2 py-1.5">{error}</p>}

      {/* Evidence history */}
      {history.length > 0 && (
        <details className="text-xs">
          <summary className="cursor-pointer text-gray-500">Check history ({history.length})</summary>
          <ul className="mt-2 space-y-2">
            {history.map((v) => (
              <li key={v.id} className="border-l-2 pl-2" style={{ borderColor: v.passed ? '#16a34a' : '#dc2626' }}>
                <div className="flex items-center gap-2 text-gray-600">
                  <span className={v.passed ? 'text-green-700' : 'text-red-600'}>{v.passed ? '✓' : '✗'}</span>
                  <span className="font-medium">{gateLabel[v.gate]}</span>
                  <span className="text-gray-400">{v.actor === 'agent' ? 'agent' : 'you'} · {formatTime(v.created_at)}</span>
                  {v.duration_ms != null && <span className="text-gray-400">· {(v.duration_ms / 1000).toFixed(1)}s</span>}
                </div>
                {v.command && <code className="block text-gray-500 truncate" title={v.command}>{v.command}{v.exit_code != null && ` → exit ${v.exit_code}`}</code>}
                {v.evidence && (
                  <ul className="mt-1 space-y-0.5">
                    {v.evidence.map((e, i) => (
                      <li key={i} className="text-gray-600"><span className="text-gray-400">{criteria[i] ?? `Criterion ${i + 1}`}:</span> {e}</li>
                    ))}
                  </ul>
                )}
                {v.output && (v.gate === 'command' ? (
                  <details className="mt-1">
                    <summary className="cursor-pointer text-gray-400">Output</summary>
                    <pre className="mt-1 max-h-48 overflow-auto bg-gray-50 rounded p-2 text-[11px] text-gray-700 whitespace-pre-wrap">{v.output}</pre>
                  </details>
                ) : (
                  <p className="text-gray-600 italic mt-0.5">{v.output}</p>
                ))}
              </li>
            ))}
          </ul>
        </details>
      )}
    </div>
  )
}
