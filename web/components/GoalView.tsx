'use client'

import Link from 'next/link'
import { useCallback, useEffect, useState } from 'react'
import type { Goal, GoalMemory, GoalRun, IntervalConfig, HealthResult, ToolCallRecord, Schedule } from '@/lib/db'

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
  schedule: Schedule | null
  webhook_enabled: boolean
  health: HealthResult[]
  tool_calls: ToolCallRecord[]
  suggestions: { category: string; approved_in_a_row: number }[]
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
                : data.schedule ? `${data.schedule.kind === 'interval' ? `Every ${data.schedule.minutes} min${data.schedule.active_hours ? ` (${data.schedule.active_hours})` : ''}` : `Cron ${data.schedule.expr}`} · next run ${goal.status === 'active' ? when(goal.next_run_at) : '— paused'}`
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

        <Suggestions data={data} busy={busy} patch={patch} />

        <div className="grid md:grid-cols-2 gap-8">
          <HealthSection data={data} goalId={goalId} busy={busy} call={call} />
          <GuardSection calls={data.tool_calls} hasRules={Object.keys(goal.tool_map).length > 0} />
        </div>

        <MemorySection memory={data.memory} goalId={goalId} busy={busy} call={call} />

        <Settings data={data} busy={busy} patch={patch} call={call} />
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

function Settings({ data, busy, patch, call }: { data: GoalData; busy: string | null; patch: (body: object, label?: string) => Promise<boolean>; call: Call }) {
  const { goal } = data
  const [instructions, setInstructions] = useState(goal.instructions)
  const [objective, setObjective] = useState(goal.objective)
  const [scheduleKind, setScheduleKind] = useState<'manual' | 'interval' | 'cron'>(data.schedule?.kind ?? 'manual')
  const [minutes, setMinutes] = useState(data.schedule?.kind === 'interval' ? String(data.schedule.minutes) : '30')
  const [hours, setHours] = useState(data.schedule?.kind === 'interval' ? data.schedule.active_hours ?? '' : '')
  const [cron, setCron] = useState(data.schedule?.kind === 'cron' ? data.schedule.expr : '0 9 * * 1-5')
  const [healthCommand, setHealthCommand] = useState(goal.health_command ?? '')
  const [healthEvery, setHealthEvery] = useState(goal.health_every_minutes)
  const [healthTriggers, setHealthTriggers] = useState(goal.health_triggers_run)
  const [toolMap, setToolMap] = useState<[string, string][]>(Object.entries(goal.tool_map))
  const [secret, setSecret] = useState<string | null>(null)
  const enableWebhook = async () => {
    const r = await fetch(`/api/goals/${data.plan.id}/webhook`, { method: 'POST' })
    if (r.ok) setSecret((await r.json()).secret)
  }
  const [autonomy, setAutonomy] = useState<Record<string, (typeof MODES)[number]>>(goal.autonomy)
  const [newCategory, setNewCategory] = useState('')
  const [limits, setLimits] = useState(goal.limits)
  const [retention, setRetention] = useState(goal.item_retention_days)
  // Every category the goal knows about: configured, seen in decisions, or named by a tool rule
  const categories = [...new Set([...Object.keys(autonomy), ...Object.keys(data.approval_stats), ...Object.values(goal.tool_map)])].sort()
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
            <span className="block text-xs font-medium text-gray-600">Schedule</span>
            <select value={scheduleKind} onChange={(e) => setScheduleKind(e.target.value as typeof scheduleKind)} className={`${input} bg-white`}>
              <option value="manual">Manual only</option>
              <option value="interval">Every N minutes</option>
              <option value="cron">Cron</option>
            </select>
          </label>
          {scheduleKind === 'interval' && (<>
            <label className="space-y-1">
              <span className="block text-xs font-medium text-gray-600">Minutes</span>
              <input value={minutes} onChange={(e) => setMinutes(e.target.value.replace(/\D/g, ''))} className={`${input} w-24`} />
            </label>
            <label className="space-y-1">
              <span className="block text-xs font-medium text-gray-600">Active hours</span>
              <input value={hours} onChange={(e) => setHours(e.target.value)} placeholder="08:00-20:00" className={`${input} w-32`} />
            </label>
          </>)}
          {scheduleKind === 'cron' && (
            <label className="space-y-1">
              <span className="block text-xs font-medium text-gray-600">Cron (minute hour day month weekday, local time)</span>
              <input value={cron} onChange={(e) => setCron(e.target.value)} placeholder="0 9 * * 1-5" className={`${input} w-56 font-mono`} />
            </label>
          )}
        </div>

        <div className="space-y-2">
          <p className="text-xs font-medium text-gray-600">Webhook — let another system start a run</p>
          {data.webhook_enabled || secret ? (
            <div className="flex items-center gap-2 text-xs">
              <span className="text-green-700">On</span>
              <button type="button" className="px-2 py-1 border border-gray-200 rounded-md" onClick={enableWebhook}>New secret</button>
              <button type="button" className="px-2 py-1 text-gray-500 hover:text-red-600"
                onClick={async () => { setSecret(null); await call('webhook', `/api/goals/${data.plan.id}/webhook`, { method: 'DELETE' }) }}>Turn off</button>
            </div>
          ) : (
            <button type="button" className="px-2 py-1 text-xs border border-gray-200 rounded-md" onClick={enableWebhook}>Turn on</button>
          )}
          {secret && (
            <div className="text-xs bg-amber-50 border border-amber-200 rounded-md p-2 space-y-1">
              <p>Copy this now — the secret won&apos;t be shown again.</p>
              <pre className="whitespace-pre-wrap break-all font-mono text-[11px] text-gray-800">
                {`curl -X POST ${typeof location !== 'undefined' ? location.origin : ''}/api/goals/${data.plan.id}/trigger -H "Authorization: Bearer ${secret}"`}
              </pre>
            </div>
          )}
        </div>

        <div className="space-y-2">
          <p className="text-xs font-medium text-gray-600">Health check — a command that exits 0 while the goal is met (the last number it prints is charted)</p>
          <input value={healthCommand} onChange={(e) => setHealthCommand(e.target.value)} placeholder="node scripts/unread-older-than-a-day.js" className={`${input} w-full font-mono`} />
          <div className="flex flex-wrap items-center gap-4 text-xs text-gray-600">
            <label className="flex items-center gap-2">Every
              <input value={healthEvery} onChange={(e) => setHealthEvery(Number(e.target.value.replace(/\D/g, '')) || 1)} className={`${input} w-20`} /> minutes</label>
            <label className="flex items-center gap-2"><input type="checkbox" checked={healthTriggers} onChange={(e) => setHealthTriggers(e.target.checked)} /> Start a run when it fails</label>
          </div>
        </div>

        <div className="space-y-2">
          <p className="text-xs font-medium text-gray-600">Tool rules — which tools count as which action (enforced by the goal-guard hook)</p>
          {toolMap.map(([pattern, category], i) => (
            <div key={i} className="flex gap-2">
              <input value={pattern} onChange={(e) => setToolMap(toolMap.map((r, j) => (j === i ? [e.target.value, r[1]] : r)))} placeholder="mcp__gmail__send*" className={`${input} flex-1 font-mono text-xs`} />
              <span className="text-gray-400 self-center">→</span>
              <input value={category} onChange={(e) => setToolMap(toolMap.map((r, j) => (j === i ? [r[0], e.target.value] : r)))} placeholder="email.send" className={`${input} w-40 font-mono text-xs`} />
              <button type="button" onClick={() => setToolMap(toolMap.filter((_, j) => j !== i))} className="text-xs text-gray-400 hover:text-red-600">Remove</button>
            </div>
          ))}
          <button type="button" onClick={() => setToolMap([...toolMap, ['', '']])} className="px-2 py-1 text-xs border border-gray-200 rounded-md">Add rule</button>
          {toolMap.length > 0 && <p className="text-xs text-gray-500">Rules only apply with the guard installed: <code>npm run setup-hooks --prefix mcp -- --guard</code></p>}
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
              schedule: scheduleKind === 'manual' ? null
                : scheduleKind === 'interval' ? { kind: 'interval', minutes: Number(minutes) || 30, active_hours: hours.trim() || null }
                : { kind: 'cron', expr: cron },
              health_command: healthCommand.trim() || null,
              health_every_minutes: healthEvery,
              health_triggers_run: healthTriggers,
              tool_map: Object.fromEntries(toolMap.filter(([p, c]) => p.trim() && c.trim()).map(([p, c]) => [p.trim(), c.trim()])),
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

function Suggestions({ data, busy, patch }: { data: GoalData; busy: string | null; patch: (body: object, label?: string) => Promise<boolean> }) {
  if (data.suggestions.length === 0) return null
  return (
    <div className="space-y-2">
      {data.suggestions.map((sug) => (
        <div key={sug.category} className="flex items-center gap-3 bg-blue-50 border border-blue-200 rounded-lg px-4 py-3 text-sm">
          <span className="flex-1 text-blue-900">
            You approved the last <b>{sug.approved_in_a_row}</b> <code className="text-xs">{sug.category}</code> proposals in a row. Let the agent do these on its own?
          </span>
          <button disabled={busy !== null} onClick={() => patch({ autonomy: { ...data.goal.autonomy, [sug.category]: 'auto' } }, 'promote')}
            className="px-3 py-1.5 text-sm bg-blue-600 text-white rounded-md hover:bg-blue-700 disabled:opacity-50">Switch to auto</button>
        </div>
      ))}
    </div>
  )
}

/** Tiny trend line of health values, oldest → newest. */
function Sparkline({ values }: { values: number[] }) {
  if (values.length < 2) return null
  const w = 160
  const h = 32
  const min = Math.min(...values)
  const max = Math.max(...values)
  const span = max - min || 1
  const pts = values.map((v, i) => `${(i / (values.length - 1)) * w},${h - 2 - ((v - min) / span) * (h - 4)}`).join(' ')
  return (
    <svg width={w} height={h} className="text-gray-500" role="img" aria-label={`Trend from ${values[0]} to ${values[values.length - 1]}`}>
      <polyline points={pts} fill="none" stroke="currentColor" strokeWidth="1.5" />
    </svg>
  )
}

function HealthSection({ data, goalId, busy, call }: { data: GoalData; goalId: string; busy: string | null; call: Call }) {
  const last = data.health[0]
  const values = [...data.health].reverse().map((h) => h.value).filter((v): v is number => v !== null)
  return (
    <Section title="Health">
      {!data.goal.health_command ? (
        <Empty>No health check. Add a command in Settings that exits 0 while the goal is being met.</Empty>
      ) : (
        <div className="bg-white rounded-lg border border-gray-200 px-4 py-3 space-y-2">
          <div className="flex items-center gap-3">
            {last ? (
              <span className={`text-xs px-1.5 py-0.5 rounded ${last.passed ? 'bg-green-100 text-green-700' : 'bg-red-100 text-red-700'}`}>{last.passed ? 'healthy' : 'failing'}</span>
            ) : <span className="text-xs text-gray-400">not checked yet</span>}
            {last && last.value !== null && <span className="text-lg font-semibold text-gray-800 tabular-nums">{last.value}</span>}
            <Sparkline values={values} />
            <button onClick={() => call('health', `/api/goals/${goalId}/health`)} disabled={busy !== null}
              className="ml-auto text-xs px-2 py-1 border border-gray-200 rounded-md hover:bg-gray-50 disabled:opacity-50">{busy === 'health' ? 'Checking…' : 'Check now'}</button>
          </div>
          <code className="block text-xs text-gray-500 truncate">{data.goal.health_command}</code>
          {last && !last.passed && last.output && <pre className="text-[11px] bg-gray-50 rounded p-2 max-h-24 overflow-auto whitespace-pre-wrap">{last.output}</pre>}
          {last && (
            <p className="text-xs text-gray-400">
              Last checked {when(last.created_at)} · every {data.goal.health_every_minutes} min{data.goal.health_triggers_run ? ' · failures start a run' : ''}
            </p>
          )}
        </div>
      )}
    </Section>
  )
}

function GuardSection({ calls, hasRules }: { calls: ToolCallRecord[]; hasRules: boolean }) {
  return (
    <Section title="Guard">
      {!hasRules ? (
        <Empty>No tool rules. Map tools to action categories in Settings so the goal-guard hook can enforce autonomy on them.</Empty>
      ) : calls.length === 0 ? (
        <Empty>No guarded tool calls yet.</Empty>
      ) : (
        <ul className="bg-white rounded-lg border border-gray-200 divide-y divide-gray-100">
          {calls.map((c) => (
            <li key={c.id} className="px-4 py-2 text-xs flex items-center gap-2" title={c.reason ?? undefined}>
              <span className={c.decision === 'allow' ? 'text-green-600' : 'text-red-600'}>{c.decision === 'allow' ? 'allowed' : 'blocked'}</span>
              <code className="truncate">{c.tool_name}</code>
              <span className="text-gray-400">{c.category}</span>
              <span className="text-gray-400 ml-auto">{when(c.created_at)}</span>
            </li>
          ))}
        </ul>
      )}
    </Section>
  )
}
