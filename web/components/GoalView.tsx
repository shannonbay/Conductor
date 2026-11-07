'use client'

import Link from 'next/link'
import { useCallback, useEffect, useState } from 'react'
import type { Goal, GoalMemory, GoalRun, IntervalConfig } from '@/lib/db'

type Action = { category: string; summary: string; params?: Record<string, unknown> }
interface Item {
  id: string
  goal: string
  status: string
  result: string | null
  notes: string | null
  external_ref: string | null
  action: Action | null
  awaiting_review: boolean
  approved_to_execute: boolean
  updated_at: string
}
interface GoalData {
  plan: { id: string; name: string; working_dir: string }
  goal: Goal
  interval: IntervalConfig | null
  open_run: GoalRun | null
  runs: GoalRun[]
  needs_you: Item[]
  open_items: Item[]
  recently_resolved: Item[]
  memory: GoalMemory[]
  approval_stats: Record<string, { approved: number; rejected: number }>
}

const MODES = ['off', 'propose', 'auto'] as const

function when(iso: string | null) {
  if (!iso) return '—'
  const d = new Date(iso)
  const mins = Math.round((Date.now() - d.getTime()) / 60_000)
  if (mins >= 0 && mins < 1) return 'just now'
  if (mins > 0 && mins < 60) return `${mins} min ago`
  if (mins < 0 && mins > -60) return `in ${-mins} min`
  return d.toLocaleString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })
}

const runStyle: Record<GoalRun['status'], string> = {
  queued: 'bg-gray-100 text-gray-600',
  running: 'bg-blue-100 text-blue-700',
  completed: 'bg-green-100 text-green-700',
  failed: 'bg-red-100 text-red-700',
  timed_out: 'bg-red-100 text-red-700',
  skipped: 'bg-gray-100 text-gray-500',
}

export function GoalView({ goalId }: { goalId: string }) {
  const [data, setData] = useState<GoalData | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState<string | null>(null)

  const load = useCallback(async () => {
    const res = await fetch(`/api/goals/${goalId}`)
    if (res.ok) setData(await res.json())
  }, [goalId])

  // Live updates: the plan WebSocket fires on every change (a goal is a plan)
  useEffect(() => {
    load()
    let ws: WebSocket | null = null
    let closed = false
    const connect = () => {
      ws = new WebSocket(`${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/api/plans/${goalId}/ws`)
      ws.onmessage = () => load()
      ws.onclose = () => { if (!closed) setTimeout(connect, 3000) }
    }
    connect()
    const poll = setInterval(load, 15_000) // keeps relative times and run status fresh
    return () => { closed = true; ws?.close(); clearInterval(poll) }
  }, [goalId, load])

  async function call(label: string, url: string, init: RequestInit = { method: 'POST' }) {
    setBusy(label)
    setError(null)
    try {
      const res = await fetch(url, { headers: { 'Content-Type': 'application/json' }, ...init })
      const body = await res.json().catch(() => ({}))
      if (!res.ok) { setError(body.error ?? `Request failed (${res.status})`); return false }
      await load()
      return true
    } finally {
      setBusy(null)
    }
  }

  if (!data) return <div className="p-10 text-sm text-gray-400">Loading…</div>
  const { plan, goal, open_run } = data
  const patch = (body: object, label = 'save') => call(label, `/api/goals/${goalId}`, { method: 'PATCH', body: JSON.stringify(body) })

  return (
    <div className="min-h-screen bg-gray-50">
      <header className="bg-white border-b px-6 py-4">
        <div className="max-w-5xl mx-auto flex items-start justify-between gap-4">
          <div className="min-w-0">
            <Link href="/" className="text-xs text-gray-400 hover:text-gray-700">← Conductor</Link>
            <div className="flex items-center gap-2 mt-1">
              <h1 className="text-xl font-semibold text-gray-900">{plan.name}</h1>
              <span className={`text-xs px-1.5 py-0.5 rounded ${goal.status === 'active' ? 'bg-green-100 text-green-700' : 'bg-gray-100 text-gray-500'}`}>{goal.status}</span>
            </div>
            <p className="text-sm text-gray-600 mt-1">{goal.objective}</p>
            <p className="text-xs text-gray-400 mt-1">
              {open_run ? (open_run.status === 'running' ? `Run in progress since ${when(open_run.started_at)}` : 'Run queued — starts when Claude Code is free')
                : data.interval ? `Every ${data.interval.minutes} min${data.interval.active_hours ? ` (${data.interval.active_hours})` : ''} · next run ${goal.status === 'active' ? when(goal.next_run_at) : '— paused'}`
                : 'Runs only when you click Run now'}
            </p>
          </div>
          <div className="flex gap-2 flex-shrink-0">
            {open_run?.status === 'running' ? (
              <button onClick={() => call('cancel', `/api/goals/${goalId}/run`, { method: 'DELETE' })} disabled={busy !== null}
                className="px-3 py-1.5 text-sm border border-red-200 text-red-600 rounded-lg hover:bg-red-50 disabled:opacity-50">Cancel run</button>
            ) : (
              <button onClick={() => call('run', `/api/goals/${goalId}/run`)} disabled={busy !== null || goal.status !== 'active' || open_run !== null}
                className="px-3 py-1.5 text-sm bg-gray-900 text-white rounded-lg hover:bg-gray-700 disabled:opacity-50">{busy === 'run' ? 'Queuing…' : 'Run now'}</button>
            )}
            <button onClick={() => patch({ status: goal.status === 'active' ? 'paused' : 'active' }, 'status')} disabled={busy !== null}
              className="px-3 py-1.5 text-sm border border-gray-200 text-gray-700 rounded-lg hover:bg-gray-50 disabled:opacity-50">
              {goal.status === 'active' ? 'Pause' : 'Resume'}
            </button>
            <Link href={`/plans/${goalId}`} className="px-3 py-1.5 text-sm text-gray-500 hover:text-gray-900">Task tree</Link>
          </div>
        </div>
      </header>

      <main className="max-w-5xl mx-auto px-6 py-8 space-y-8">
        {error && <p className="text-sm text-red-600 bg-red-50 rounded-lg px-3 py-2">{error}</p>}

        <NeedsYou items={data.needs_you} goalId={goalId} busy={busy} call={call} />

        <div className="grid md:grid-cols-2 gap-8">
          <Section title={`Open items (${data.open_items.length})`}>
            {data.open_items.length === 0 ? <Empty>Nothing open.</Empty> : (
              <ul className="divide-y divide-gray-100 bg-white rounded-lg border border-gray-200">
                {data.open_items.map((i) => (
                  <li key={i.id} className="px-4 py-2.5 text-sm">
                    <div className="flex items-center gap-2">
                      <span className="text-xs font-mono text-gray-400">{i.id}</span>
                      <span className="flex-1 min-w-0 truncate text-gray-800">{i.goal}</span>
                      {i.approved_to_execute && <span className="text-[10px] px-1.5 py-0.5 rounded bg-green-100 text-green-700">approved — next run</span>}
                    </div>
                    {i.external_ref && <p className="text-xs text-gray-400 font-mono truncate mt-0.5">{i.external_ref}</p>}
                  </li>
                ))}
              </ul>
            )}
            {data.recently_resolved.length > 0 && (
              <details className="mt-3">
                <summary className="text-xs text-gray-500 cursor-pointer">Recently resolved ({data.recently_resolved.length})</summary>
                <ul className="mt-2 space-y-1">
                  {data.recently_resolved.map((i) => (
                    <li key={i.id} className="text-xs text-gray-600 flex gap-2">
                      <span className={i.status === 'completed' ? 'text-green-600' : 'text-gray-400'}>{i.status === 'completed' ? '✓' : '✗'}</span>
                      <span className="truncate">{i.goal}{i.result ? ` — ${i.result}` : ''}</span>
                    </li>
                  ))}
                </ul>
              </details>
            )}
          </Section>

          <Section title="Runs">
            {data.runs.length === 0 ? <Empty>No runs yet.</Empty> : (
              <ul className="space-y-2">
                {data.runs.map((r) => (
                  <li key={r.id} className="bg-white rounded-lg border border-gray-200 px-4 py-2.5 text-sm">
                    <div className="flex items-center gap-2 text-xs">
                      <span className={`px-1.5 py-0.5 rounded ${runStyle[r.status]}`}>{r.status.replace('_', ' ')}</span>
                      <span className="text-gray-500">{r.trigger}</span>
                      <span className="text-gray-400 ml-auto">{when(r.started_at)}</span>
                    </div>
                    {r.status === 'skipped' ? <p className="text-xs text-gray-500 mt-1">{r.skip_reason}</p>
                      : r.summary && <p className="text-gray-700 mt-1 whitespace-pre-wrap">{r.summary}</p>}
                    {(r.items_created > 0 || r.items_resolved > 0) && (
                      <p className="text-xs text-gray-400 mt-1">{r.items_created} added · {r.items_resolved} resolved</p>
                    )}
                  </li>
                ))}
              </ul>
            )}
          </Section>
        </div>

        <MemorySection memory={data.memory} goalId={goalId} busy={busy} call={call} />

        <Settings data={data} busy={busy} patch={patch} />
      </main>
    </div>
  )
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section>
      <h2 className="text-sm font-medium text-gray-500 uppercase tracking-wide mb-3">{title}</h2>
      {children}
    </section>
  )
}

const Empty = ({ children }: { children: React.ReactNode }) => <p className="text-sm text-gray-400">{children}</p>

type Call = (label: string, url: string, init?: RequestInit) => Promise<boolean>

function NeedsYou({ items, goalId, busy, call }: { items: Item[]; goalId: string; busy: string | null; call: Call }) {
  const [rejecting, setRejecting] = useState<string | null>(null)
  const [feedback, setFeedback] = useState('')
  if (items.length === 0) return null
  return (
    <Section title={`Needs you (${items.length})`}>
      <div className="space-y-3">
        {items.map((i) => (
          <div key={i.id} className="bg-amber-50 border border-amber-200 rounded-lg p-4 space-y-2">
            <div className="flex items-start gap-2">
              <span className="text-xs font-mono text-amber-700 mt-0.5">{i.id}</span>
              <div className="flex-1 min-w-0">
                <p className="text-sm font-medium text-gray-900">{i.goal}</p>
                {i.action && (
                  <p className="text-sm text-gray-700 mt-0.5">
                    <span className="text-xs font-mono px-1.5 py-0.5 rounded bg-white border border-amber-200 mr-2">{i.action.category}</span>
                    {i.action.summary}
                  </p>
                )}
              </div>
            </div>
            {i.action?.params && Object.keys(i.action.params).length > 0 && (
              <details className="text-xs"><summary className="cursor-pointer text-amber-800">Details</summary>
                <pre className="mt-1 bg-white rounded p-2 overflow-auto text-gray-700">{JSON.stringify(i.action.params, null, 2)}</pre>
              </details>
            )}
            {i.notes && <p className="text-xs text-gray-600 whitespace-pre-wrap">{i.notes}</p>}
            {rejecting === i.id ? (
              <div className="space-y-2">
                <textarea autoFocus value={feedback} onChange={(e) => setFeedback(e.target.value)} rows={2}
                  placeholder="What should change? This becomes memory, so later runs learn from it."
                  className="w-full border border-amber-200 rounded-md px-2 py-1.5 text-sm bg-white resize-none focus:outline-none focus:ring-1 focus:ring-amber-400" />
                <div className="flex gap-2">
                  <button disabled={busy !== null || !feedback.trim()} className="px-3 py-1.5 text-sm bg-red-600 text-white rounded-md hover:bg-red-700 disabled:opacity-50"
                    onClick={async () => {
                      if (await call('reject', `/api/plans/${goalId}/tasks/${i.id}/reject`, { method: 'POST', body: JSON.stringify({ feedback }) })) {
                        setRejecting(null); setFeedback('')
                      }
                    }}>Send back</button>
                  <button onClick={() => setRejecting(null)} className="px-3 py-1.5 text-sm text-gray-600">Cancel</button>
                </div>
              </div>
            ) : (
              <div className="flex gap-2">
                <button onClick={() => call('approve', `/api/plans/${goalId}/tasks/${i.id}/approve`)} disabled={busy !== null}
                  className="px-3 py-1.5 text-sm bg-green-600 text-white rounded-md hover:bg-green-700 disabled:opacity-50">Approve</button>
                <button onClick={() => { setRejecting(i.id); setFeedback('') }} disabled={busy !== null}
                  className="px-3 py-1.5 text-sm border border-red-200 text-red-600 bg-white rounded-md hover:bg-red-50 disabled:opacity-50">Reject…</button>
              </div>
            )}
          </div>
        ))}
      </div>
    </Section>
  )
}

function MemorySection({ memory, goalId, busy, call }: { memory: GoalMemory[]; goalId: string; busy: string | null; call: Call }) {
  const [kind, setKind] = useState<GoalMemory['kind']>('rule')
  const [text, setText] = useState('')
  const active = memory.filter((m) => m.active)
  const inactive = memory.filter((m) => !m.active)
  const sourceLabel: Record<GoalMemory['source'], string> = { human: 'you', agent: 'agent', feedback: 'your feedback' }
  const row = (m: GoalMemory) => (
    <li key={m.id} className={`flex items-start gap-3 px-4 py-2.5 text-sm ${m.active ? '' : 'opacity-50'}`}>
      <span className="text-[10px] uppercase tracking-wide text-gray-400 w-16 flex-shrink-0 mt-0.5">{m.kind}</span>
      <span className="flex-1 text-gray-800">{m.text}</span>
      <span className="text-xs text-gray-400 flex-shrink-0">{sourceLabel[m.source]}</span>
      <button title={m.pinned ? 'Unpin' : 'Pin: always include in the brief'} className={`text-xs ${m.pinned ? 'text-amber-600' : 'text-gray-300 hover:text-gray-600'}`}
        onClick={() => call('mem', `/api/goals/${goalId}/memory/${m.id}`, { method: 'PATCH', body: JSON.stringify({ pinned: !m.pinned }) })}>📌</button>
      <button className="text-xs text-gray-400 hover:text-gray-800"
        onClick={() => call('mem', `/api/goals/${goalId}/memory/${m.id}`, { method: 'PATCH', body: JSON.stringify({ active: !m.active }) })}>{m.active ? 'Disable' : 'Enable'}</button>
      <button className="text-xs text-gray-400 hover:text-red-600"
        onClick={() => call('mem', `/api/goals/${goalId}/memory/${m.id}`, { method: 'DELETE' })}>Delete</button>
    </li>
  )
  const chars = active.reduce((n, m) => n + m.text.length, 0)
  return (
    <Section title={`Memory (${active.length})`}>
      <div className="bg-white rounded-lg border border-gray-200">
        {memory.length === 0 ? <p className="px-4 py-3 text-sm text-gray-400">No memory yet. Add rules here, or reject a proposal with feedback — it becomes memory automatically.</p> : (
          <ul className="divide-y divide-gray-100">{active.map(row)}{inactive.map(row)}</ul>
        )}
        <form className="flex gap-2 p-3 border-t border-gray-100"
          onSubmit={async (e) => {
            e.preventDefault()
            if (await call('mem-add', `/api/goals/${goalId}/memory`, { method: 'POST', body: JSON.stringify({ kind, text }) })) setText('')
          }}>
          <select value={kind} onChange={(e) => setKind(e.target.value as GoalMemory['kind'])} className="border border-gray-200 rounded-md px-2 text-sm bg-white">
            <option value="rule">rule</option><option value="fact">fact</option><option value="preference">preference</option>
          </select>
          <input value={text} onChange={(e) => setText(e.target.value)} placeholder="Never archive mail from the bank."
            className="flex-1 border border-gray-200 rounded-md px-2 py-1.5 text-sm focus:outline-none focus:ring-1 focus:ring-gray-400" />
          <button disabled={busy !== null || !text.trim()} className="px-3 py-1.5 text-sm bg-gray-900 text-white rounded-md disabled:opacity-50">Add</button>
        </form>
      </div>
      {chars > 4000 && <p className="text-xs text-amber-700 mt-2">Active memory is over the 4,000-character brief budget; runs see pinned items plus the most recently used. Consider pinning or disabling some.</p>}
    </Section>
  )
}

function Settings({ data, busy, patch }: { data: GoalData; busy: string | null; patch: (body: object, label?: string) => Promise<boolean> }) {
  const { goal } = data
  const [instructions, setInstructions] = useState(goal.instructions)
  const [objective, setObjective] = useState(goal.objective)
  const [minutes, setMinutes] = useState(data.interval ? String(data.interval.minutes) : '')
  const [hours, setHours] = useState(data.interval?.active_hours ?? '')
  const [autonomy, setAutonomy] = useState<Record<string, (typeof MODES)[number]>>(goal.autonomy)
  const [newCategory, setNewCategory] = useState('')
  const [limits, setLimits] = useState(goal.limits)
  const [retention, setRetention] = useState(goal.item_retention_days)
  const categories = [...new Set([...Object.keys(autonomy), ...Object.keys(data.approval_stats)])].sort()
  const input = 'border border-gray-200 rounded-md px-2 py-1.5 text-sm focus:outline-none focus:ring-1 focus:ring-gray-400'

  return (
    <details className="bg-white rounded-lg border border-gray-200">
      <summary className="px-4 py-3 text-sm font-medium text-gray-700 cursor-pointer">Settings</summary>
      <div className="px-4 pb-4 space-y-5">
        <label className="block space-y-1">
          <span className="text-xs font-medium text-gray-600">Objective</span>
          <input value={objective} onChange={(e) => setObjective(e.target.value)} className={`${input} w-full`} />
        </label>
        <label className="block space-y-1">
          <span className="text-xs font-medium text-gray-600">Standing instructions</span>
          <textarea value={instructions} onChange={(e) => setInstructions(e.target.value)} rows={5} className={`${input} w-full resize-y`} />
        </label>

        <div className="flex flex-wrap items-end gap-4">
          <label className="space-y-1">
            <span className="block text-xs font-medium text-gray-600">Run every (minutes, empty = manual only)</span>
            <input value={minutes} onChange={(e) => setMinutes(e.target.value.replace(/\D/g, ''))} className={`${input} w-28`} />
          </label>
          <label className="space-y-1">
            <span className="block text-xs font-medium text-gray-600">Active hours</span>
            <input value={hours} onChange={(e) => setHours(e.target.value)} placeholder="08:00-20:00" className={`${input} w-32`} disabled={!minutes} />
          </label>
        </div>

        <div>
          <p className="text-xs font-medium text-gray-600 mb-1">What the agent may do on its own</p>
          <p className="text-xs text-gray-500 mb-2"><b>off</b>: never · <b>propose</b>: asks you first (default for anything not listed) · <b>auto</b>: does it and records it</p>
          <table className="w-full text-sm">
            <tbody>
              {categories.map((c) => {
                const s = data.approval_stats[c]
                return (
                  <tr key={c} className="border-t border-gray-100">
                    <td className="py-1.5 font-mono text-xs">{c}</td>
                    <td className="py-1.5 text-xs text-gray-400">{s ? `${s.approved} approved · ${s.rejected} rejected` : ''}</td>
                    <td className="py-1.5 text-right">
                      <div className="inline-flex rounded-md border border-gray-200 overflow-hidden">
                        {MODES.map((m) => (
                          <button key={m} type="button" onClick={() => setAutonomy({ ...autonomy, [c]: m })}
                            className={`px-2 py-1 text-xs ${(autonomy[c] ?? 'propose') === m ? 'bg-gray-900 text-white' : 'bg-white text-gray-600 hover:bg-gray-50'}`}>{m}</button>
                        ))}
                      </div>
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>
          <div className="flex gap-2 mt-2">
            <input value={newCategory} onChange={(e) => setNewCategory(e.target.value.trim())} placeholder="email.archive" className={`${input} font-mono text-xs`} />
            <button type="button" disabled={!newCategory} onClick={() => { setAutonomy({ ...autonomy, [newCategory]: 'propose' }); setNewCategory('') }}
              className="px-2 py-1 text-xs border border-gray-200 rounded-md disabled:opacity-50">Add category</button>
          </div>
        </div>

        <div className="flex flex-wrap gap-4">
          {([['max_run_minutes', 'Max minutes per run'], ['max_items_per_run', 'Max items per run'], ['max_runs_per_day', 'Max runs per day']] as const).map(([k, label]) => (
            <label key={k} className="space-y-1">
              <span className="block text-xs font-medium text-gray-600">{label}</span>
              <input value={limits[k]} onChange={(e) => setLimits({ ...limits, [k]: Number(e.target.value.replace(/\D/g, '')) || 1 })} className={`${input} w-24`} />
            </label>
          ))}
          <label className="space-y-1">
            <span className="block text-xs font-medium text-gray-600">Hide resolved items after (days)</span>
            <input value={retention} onChange={(e) => setRetention(Number(e.target.value.replace(/\D/g, '')) || 1)} className={`${input} w-24`} />
          </label>
        </div>

        <div className="flex items-center gap-3">
          <button disabled={busy !== null}
            onClick={() => patch({
              objective, instructions, autonomy, limits, item_retention_days: retention,
              interval: minutes ? { minutes: Number(minutes), active_hours: hours.trim() || null } : null,
            })}
            className="px-4 py-2 text-sm bg-gray-900 text-white rounded-lg hover:bg-gray-700 disabled:opacity-50">{busy === 'save' ? 'Saving…' : 'Save settings'}</button>
          {goal.status !== 'retired' && (
            <button disabled={busy !== null} onClick={() => patch({ status: 'retired' }, 'retire')} className="text-sm text-gray-400 hover:text-red-600">Retire goal</button>
          )}
          <span className="text-xs text-gray-400 ml-auto font-mono truncate">{data.plan.working_dir}</span>
        </div>
      </div>
    </details>
  )
}
