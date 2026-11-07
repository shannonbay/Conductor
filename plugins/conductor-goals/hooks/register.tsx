/**
 * Conductor goals beside the chat. Polls the Conductor web app (default
 * http://localhost:3000) and shows each goal's proposals waiting for you,
 * with Approve / Reject, plus run status and the health trend. Also keeps a
 * status line entry and raises a toast when a new proposal arrives or a run
 * fails. Everything goes through the web app's own API, so approving here is
 * the same as approving on the goal page.
 */
import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { GoalCard, Item, Snapshot } from '../types'

const PANE = 'conductor-goals'
const DEFAULT_URL = 'http://localhost:3000'
const POLL_MS = 15_000

const EMPTY: Snapshot = { reachable: false, error: null, goals: [], fetchedAt: 0 }
const snapshot = atom({ plugin: 'conductor-goals', key: 'snapshot' } as const, EMPTY, { shape: 'snapshot-1' })
const rejecting = atom({ plugin: 'conductor-goals', key: 'rejecting' } as const, null)
const busy = atom({ plugin: 'conductor-goals', key: 'busy' } as const, null)
const notice = atom({ plugin: 'conductor-goals', key: 'notice' } as const, null)

// What the web app returns (only the fields used here).
type ListRow = { id: string; name: string; status: string }
type Detail = {
  goal: { status: string; next_run_at: string | null }
  open_run: { status: string } | null
  runs: { id: string; status: string; summary: string | null; ended_at: string | null; started_at: string | null }[]
  needs_you: { id: string; goal: string; action: { category?: string; summary?: string } | null }[]
  health: { passed: boolean; value: number | null }[]
}

type $ = EngineInterface

async function baseUrl($: $): Promise<string> {
  const stored = await $.store.get('url')
  return typeof stored === 'string' && stored ? stored.replace(/\/+$/, '') : DEFAULT_URL
}

/** Calls the web app; throws with its error message on a non-2xx answer. */
async function api($: $, path: string, init: { method?: string; body?: unknown } = {}): Promise<unknown> {
  const res = await $.http.fetch(`${await baseUrl($)}${path}`, {
    method: init.method ?? 'GET',
    ...(init.body !== undefined && { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(init.body) }),
  })
  let data: unknown = null
  try {
    data = res.text ? JSON.parse(res.text) : null
  } catch {
    data = null
  }
  if (!res.ok) {
    const message = (data as { error?: unknown } | null)?.error
    throw new Error(typeof message === 'string' ? message : `HTTP ${res.status}`)
  }
  return data
}

function toCard(row: ListRow, d: Detail): GoalCard {
  const last = d.runs.find((r) => r.status !== 'queued' && r.status !== 'running') ?? null
  const latest = d.health[0]
  return {
    id: row.id,
    name: row.name,
    status: d.goal.status,
    needsYou: d.needs_you.map((t): Item => ({
      id: t.id,
      title: t.goal,
      category: t.action?.category ?? null,
      summary: t.action?.summary ?? null,
    })),
    running: d.open_run?.status === 'running',
    lastRun: last ? { id: last.id, status: last.status, summary: last.summary, at: last.ended_at ?? last.started_at } : null,
    nextRunAt: d.goal.next_run_at,
    health: latest ? { passed: latest.passed, value: latest.value } : null,
    trend: d.health.map((h) => h.value).filter((v): v is number => v !== null).reverse(),
  }
}

// Proposals and failed runs already announced. Null until the first read, so
// what was already waiting when the mod loaded doesn't toast.
let seenItems: Set<string> | null = null
let seenFailures: Set<string> | null = null

function announce($: $, goals: GoalCard[]): void {
  const items = goals.flatMap((g) => g.needsYou.map((i) => ({ key: `${g.id}/${i.id}`, goal: g, item: i })))
  const failures = goals.filter((g) => g.lastRun && (g.lastRun.status === 'failed' || g.lastRun.status === 'timed_out'))

  if (seenItems && seenFailures) {
    const fresh = items.filter((x) => !seenItems!.has(x.key))
    if (fresh.length === 1) $.ui.toast(`Conductor · ${fresh[0]!.goal.name}: "${fresh[0]!.item.title}" needs you`)
    else if (fresh.length > 1) $.ui.toast(`Conductor: ${fresh.length} new proposals need you`)
    for (const g of failures) {
      if (!seenFailures.has(g.lastRun!.id)) $.ui.toast(`Conductor · ${g.name}: run failed${g.lastRun!.summary ? ` — ${g.lastRun!.summary}` : ''}`)
    }
  }
  seenItems = new Set(items.map((x) => x.key))
  seenFailures = new Set(failures.map((g) => g.lastRun!.id))
}

function statusLine($: $, s: Snapshot): void {
  if (!s.reachable) {
    $.ui.status('Conductor: offline')
    return
  }
  const waiting = s.goals.reduce((n, g) => n + g.needsYou.length, 0)
  const running = s.goals.filter((g) => g.running).map((g) => g.name)
  const parts = [
    waiting > 0 ? `${waiting} need${waiting === 1 ? 's' : ''} you` : null,
    running.length > 0 ? `${running.join(', ')} running` : null,
  ].filter(Boolean)
  $.ui.status(s.goals.length === 0 ? undefined : `Conductor: ${parts.length > 0 ? parts.join(' · ') : 'all clear'}`)
}

async function refresh($: $): Promise<Snapshot> {
  const now = await $.clock.now()
  let next: Snapshot
  try {
    const rows = ((await api($, '/api/goals?status=all')) as ListRow[]).filter((g) => g.status !== 'retired')
    const goals = await Promise.all(rows.map(async (row) => toCard(row, (await api($, `/api/goals/${row.id}`)) as Detail)))
    next = { reachable: true, error: null, goals, fetchedAt: now }
    announce($, goals)
  } catch (err) {
    const previous = await read($, snapshot)
    next = { ...previous, reachable: false, error: err instanceof Error ? err.message : String(err), fetchedAt: now }
  }
  await update($, snapshot, () => next)
  statusLine($, next)
  return next
}

/** Runs one button's request, shows its error if any, then re-reads. */
async function act($: $, label: string, path: string, body?: unknown): Promise<boolean> {
  await update($, busy, () => label)
  let ok = false
  try {
    await api($, path, { method: 'POST', body })
    await update($, notice, () => null)
    ok = true
  } catch (err) {
    await update($, notice, () => `Couldn't ${label}: ${err instanceof Error ? err.message : String(err)}`)
  }
  await update($, busy, () => null)
  await refresh($)
  return ok
}

const BARS = '▁▂▃▄▅▆▇█'
function spark(values: number[]): string {
  if (values.length < 2) return ''
  const min = Math.min(...values)
  const span = Math.max(...values) - min || 1
  return values.slice(-12).map((v) => BARS[Math.round(((v - min) / span) * (BARS.length - 1))]).join('')
}

function ago(iso: string | null, now: number): string {
  if (!iso) return '—'
  const s = Math.round((now - Date.parse(iso)) / 1000)
  if (s < 0) {
    const m = Math.round(-s / 60)
    return m < 60 ? `in ${m}m` : m < 1440 ? `in ${Math.round(m / 60)}h` : `in ${Math.round(m / 1440)}d`
  }
  if (s < 60) return 'just now'
  if (s < 3600) return `${Math.floor(s / 60)}m ago`
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`
  return `${Math.floor(s / 86400)}d ago`
}

function findGoal(goals: GoalCard[], name: string): GoalCard | undefined {
  const q = name.trim().toLowerCase()
  return goals.find((g) => g.name.toLowerCase() === q) ?? goals.find((g) => g.name.toLowerCase().startsWith(q))
}

// Whether this copy of the module has registered its commands and started
// polling. session.start does it, but a mod loaded into a session that had
// already started (a restart, a resume, a reload) may not get one, so the
// first prompt or command does it instead.
let started = false

async function start($: $, openPane: boolean): Promise<void> {
  if (started) return
  started = true
  await $.command.register({ name: 'goals', description: 'Show Conductor goals in a pane' })
  await $.command.register({ name: 'goal-run', description: 'Run a Conductor goal now', argumentHint: '<goal name>' })
  await $.command.register({ name: 'conductor-url', description: 'Set the Conductor web app address (default http://localhost:3000)', argumentHint: '[url]' })
  $.clock.every(POLL_MS, () => {
    void refresh($)
  })
  const first = await refresh($)
  if (openPane && first.goals.length > 0) void $.ui.open({ id: PANE, title: 'Goals' })
}

/** Startup must never block the session or a prompt; a failure retries on the next prompt. */
async function safeStart($: $, openPane: boolean): Promise<void> {
  try {
    await start($, openPane)
  } catch {
    started = false
  }
}

export const register: Register = (on) => {
  on('session.start', async ($, e, next) => {
    await safeStart($, true)
    return next(e)
  })

  on('prompt.submit', async ($, e, next) => {
    await safeStart($, false)
    return next(e)
  })

  on('command.run', { command: 'goals' }, async ($) => {
    const s = await refresh($)
    await $.ui.open({ id: PANE, title: 'Goals' })
    return { text: s.reachable ? 'Goals pane opened.' : `Goals pane opened, but Conductor isn't reachable at ${await baseUrl($)}.` }
  })

  on('command.run', { command: 'goal-run' }, async ($, e) => {
    const s = await refresh($)
    if (!s.reachable) return { text: `Conductor isn't reachable at ${await baseUrl($)}.` }
    if (!e.args.trim()) return { text: `Usage: /goal-run <goal name>. Goals: ${s.goals.map((g) => g.name).join(', ') || 'none'}` }
    const goal = findGoal(s.goals, e.args)
    if (!goal) return { text: `No goal matches "${e.args.trim()}". Goals: ${s.goals.map((g) => g.name).join(', ')}` }
    const ok = await act($, 'start the run', `/api/goals/${goal.id}/run`)
    return { text: ok ? `Started a run of ${goal.name}.` : ((await read($, notice)) ?? 'The run did not start.') }
  })

  on('command.run', { command: 'conductor-url' }, async ($, e) => {
    const url = e.args.trim()
    if (!url) return { text: `Conductor web app: ${await baseUrl($)}` }
    if (!/^https?:\/\//.test(url)) return { text: 'Give a full address, e.g. http://localhost:3000' }
    await $.store.set('url', url)
    const s = await refresh($)
    return { text: s.reachable ? `Connected to ${url}.` : `Saved ${url}, but it isn't reachable: ${s.error}` }
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const { Box, Text, Button, Input } = $.ui.resolve(e)
    const s = await read($, snapshot)
    const open = await read($, rejecting)
    const doing = await read($, busy)
    const message = await read($, notice)
    const now = await $.clock.now()

    if (!s.reachable && s.goals.length === 0) {
      return (
        <Box flexDirection="column">
          <Text>Conductor isn't reachable.</Text>
          <Text dimColor>Start it with `npm run dev` in Conductor/web, or set the address with /conductor-url.</Text>
          {s.error && <Text dimColor>{s.error}</Text>}
          <Button key="retry" label="Retry" onPress={() => void refresh($)} />
        </Box>
      )
    }

    return (
      <Box flexDirection="column">
        {!s.reachable && <Text color="yellow">Offline — showing the last read ({ago(new Date(s.fetchedAt).toISOString(), now)}).</Text>}
        {s.goals.length === 0 && <Text dimColor>No goals yet. Create one in the web app.</Text>}
        {s.goals.map((g) => (
          <Box key={g.id} flexDirection="column" marginBottom={1}>
            <Box>
              <Text bold>{g.name}</Text>
              <Text dimColor> {g.status}</Text>
              {g.running && <Text color="cyan"> · running</Text>}
            </Box>
            <Text dimColor>
              {g.lastRun ? `last run ${g.lastRun.status} ${ago(g.lastRun.at, now)}` : 'no runs yet'}
              {g.status === 'active' && g.nextRunAt ? ` · next ${ago(g.nextRunAt, now)}` : ''}
            </Text>
            {g.health && (
              <Text>
                <Text color={g.health.passed ? 'green' : 'red'}>{g.health.passed ? 'healthy' : 'failing'}</Text>
                {g.health.value !== null ? ` ${g.health.value}` : ''} <Text dimColor>{spark(g.trend)}</Text>
              </Text>
            )}
            {g.needsYou.map((item) => {
              const key = `${g.id}/${item.id}`
              return (
                <Box key={key} flexDirection="column" marginTop={1}>
                  <Text color="yellow">● {item.title}</Text>
                  {(item.category || item.summary) && (
                    <Text dimColor>
                      {'  '}
                      {item.category ? `${item.category}: ` : ''}
                      {item.summary ?? ''}
                    </Text>
                  )}
                  {open === key && Input ? (
                    <Box flexDirection="column">
                      <Input
                        key={`feedback-${key}`}
                        label="What should change? (becomes memory)"
                        submitLabel="Send back"
                        autoFocus
                        onSubmit={(text) => {
                          if (!text.trim()) return
                          void act($, 'reject', `/api/plans/${g.id}/tasks/${item.id}/reject`, { feedback: text.trim() }).then((ok) => {
                            if (ok) void update($, rejecting, () => null)
                          })
                        }}
                      />
                      <Button key={`cancel-${key}`} label="Cancel" plain onPress={() => void update($, rejecting, () => null)} />
                    </Box>
                  ) : (
                    <Box>
                      <Button
                        key={`approve-${key}`}
                        label={doing === 'approve' ? 'Approving…' : 'Approve'}
                        variant="primary"
                        onPress={() => void act($, 'approve', `/api/plans/${g.id}/tasks/${item.id}/approve`)}
                      />
                      <Text> </Text>
                      <Button key={`reject-${key}`} label="Reject…" onPress={() => void update($, rejecting, () => key)} />
                    </Box>
                  )}
                </Box>
              )
            })}
            {g.status === 'active' && !g.running && (
              <Box marginTop={g.needsYou.length > 0 ? 1 : 0}>
                <Button key={`run-${g.id}`} label="Run now" plain onPress={() => void act($, 'start the run', `/api/goals/${g.id}/run`)} />
              </Box>
            )}
          </Box>
        ))}
        {message && <Text color="red">{message}</Text>}
        <Box>
          <Text dimColor>Updated {ago(new Date(s.fetchedAt).toISOString(), now)} </Text>
          <Button key="refresh" label="Refresh" plain onPress={() => void refresh($)} />
        </Box>
      </Box>
    )
  })
}
