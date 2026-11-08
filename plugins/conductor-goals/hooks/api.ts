/**
 * Conductor as this plugin uses it: the `conductor` MCP server's tools,
 * called through `$.tool.call`. No web app is needed. An error answer throws
 * with the server's own message; a missing server throws too (the tool isn't
 * there), which the pane shows as "not connected".
 */
import type { EngineInterface } from 'claude-code'

import type { Schedule, TodoList } from '../types'
import type { OverviewGoal } from './model'

type $ = EngineInterface

export const DEFAULT_URL = 'http://localhost:3000'

/** Settings from the plugin's userConfig, set by `register`. */
export const settings = { url: DEFAULT_URL, pollSeconds: 15, alerts: 'all', osNotifications: true, maxConcurrent: 2 }

export function configure(options: Readonly<Record<string, unknown>>): void {
  const url = typeof options.url === 'string' && options.url.trim() ? options.url.trim() : DEFAULT_URL
  const poll = typeof options.poll_seconds === 'number' ? options.poll_seconds : 15
  const concurrent = typeof options.max_concurrent_runs === 'number' ? options.max_concurrent_runs : 2
  settings.url = url.replace(/\/+$/, '')
  settings.pollSeconds = Math.min(Math.max(Math.round(poll), 5), 600)
  settings.alerts = typeof options.alerts === 'string' ? options.alerts : 'all'
  settings.osNotifications = options.os_notifications !== false
  settings.maxConcurrent = Math.min(Math.max(Math.round(concurrent), 1), 5)
}

/**
 * The web app's address, for "Open in browser" links (the web app is
 * optional): the configured one, or one saved by the old /conductor-url command.
 */
export async function baseUrl($: $): Promise<string> {
  if (settings.url !== DEFAULT_URL) return settings.url
  const stored = await $.store.get('url')
  return typeof stored === 'string' && /^https?:\/\//.test(stored) ? stored.replace(/\/+$/, '') : DEFAULT_URL
}

export async function goalPageUrl($: $, goalId: string): Promise<string> {
  return `${await baseUrl($)}/goals/${encodeURIComponent(goalId)}`
}

/** The text a tool answered with, whether core or a hook answered. */
function resultText(r: { text?: string; result?: unknown }): string {
  if (typeof r.text === 'string') return r.text
  const res = r.result
  if (typeof res === 'string') return res
  if (Array.isArray(res)) return res.map((b) => (typeof b === 'object' && b && 'text' in b ? String((b as { text: unknown }).text) : '')).join('')
  return JSON.stringify(res ?? null)
}

/** Calls one `conductor` MCP tool and returns its JSON answer. */
async function call<T>($: $, name: string, input: Record<string, unknown> = {}): Promise<T> {
  const r = await $.tool.call({ tool: `mcp__conductor__${name}`, ...input } as never)
  if (r.deny !== undefined) throw new Error(r.deny)
  const text = resultText(r)
  if (r.isError === true || text.startsWith('Error:')) throw new Error(text.replace(/^Error:\s*/, '').replace(/^<tool_use_error>|<\/tool_use_error>$/g, ''))
  try {
    return JSON.parse(text) as T
  } catch {
    throw new Error(`Unexpected answer from conductor: ${text.slice(0, 200)}`)
  }
}

/** The overview; `{ changed: false }` when it matches `etag`. */
export async function fetchOverview($: $, etag: string | null): Promise<{ changed: false } | { changed: true; goals: OverviewGoal[]; etag: string | null }> {
  const res = await call<{ changed: boolean; etag: string; goals?: OverviewGoal[] }>($, 'goals_overview', etag ? { etag } : {})
  if (!res.changed) return { changed: false }
  return { changed: true, goals: res.goals ?? [], etag: res.etag }
}

export async function approve($: $, goalId: string, itemId: string): Promise<void> {
  await call($, 'decide_item', { goal_id: goalId, item_id: itemId, decision: 'approve' })
}

export async function reject($: $, goalId: string, itemId: string, feedback: string): Promise<void> {
  await call($, 'decide_item', { goal_id: goalId, item_id: itemId, decision: 'reject', feedback })
}

export async function runNow($: $, goalId: string): Promise<void> {
  await call($, 'run_goal', { goal_id: goalId })
}

/** Marks the goal's open run cancelled; answers the subagent doing it, to stop. */
export async function cancelRunRecord($: $, goalId: string): Promise<{ runId: string; agentId: string | null }> {
  const r = await call<{ cancelled: string; agent_id: string | null }>($, 'cancel_run', { goal_id: goalId })
  return { runId: r.cancelled, agentId: r.agent_id }
}

export async function setGoalStatus($: $, goalId: string, status: 'active' | 'paused'): Promise<void> {
  await call($, 'set_goal_status', { goal_id: goalId, status })
}

export async function deleteMemory($: $, goalId: string, memoryId: string): Promise<void> {
  await call($, 'delete_memory', { goal_id: goalId, memory_id: memoryId })
}

/** null: the goal runs only on demand. */
export async function setSchedule($: $, goalId: string, schedule: Schedule | null, oneOff = false): Promise<{ next_run_at: string | null }> {
  return call($, 'set_schedule', { goal_id: goalId, schedule, ...(oneOff && { one_off: true }) })
}

export type CreatedGoal = { id: string; next_run_at: string | null; one_off: boolean; queued_run: string | null }

export async function createGoal(
  $: $, input: { name: string; objective: string; working_dir: string; schedule?: Schedule | null; one_off?: boolean },
): Promise<CreatedGoal> {
  return call<CreatedGoal>($, 'create_goal', input)
}

// ── The runner's calls ────────────────────────────────────────────────────────

/** A run the scheduler claimed for this session to start. */
export type ClaimedRun = {
  run_id: string
  goal_id: string
  name: string
  working_dir: string
  trigger: string
  max_run_minutes: number
  prompt: string
}

export async function tick($: $, holder: string, trackedRunIds: string[]): Promise<{ leader: boolean; claimed: ClaimedRun[] }> {
  const r = await call<{ leader: boolean; claimed: ClaimedRun[] }>($, 'goals_tick', {
    holder, tracked_run_ids: trackedRunIds, max_concurrent: settings.maxConcurrent,
  })
  return { leader: r.leader, claimed: r.claimed ?? [] }
}

export async function releaseLease($: $, holder: string): Promise<void> {
  await call($, 'goals_tick', { holder, release: true })
}

export async function attachAgent($: $, runId: string, agentId: string): Promise<void> {
  await call($, 'attach_agent', { run_id: runId, agent_id: agentId })
}

/** Ends a run that is still open; `changed` is false when it had already ended (end_run). */
export async function failRun($: $, runId: string, status: 'failed' | 'timed_out', reason: string): Promise<{ changed: boolean }> {
  return call<{ changed: boolean }>($, 'fail_run', { run_id: runId, status, reason })
}

// ── The person's to-do lists ──────────────────────────────────────────────────

export async function fetchTodos($: $, dir: string): Promise<TodoList[]> {
  return (await call<{ lists: TodoList[] }>($, 'todo_list', { working_dir: dir })).lists
}

export async function addTodo($: $, input: { dir: string; text: string; listId?: string; by?: 'human' | 'agent' }): Promise<{ list_id: string; item_id: string }> {
  return call($, 'todo_add', { working_dir: input.dir, text: input.text, added_by: input.by ?? 'human', ...(input.listId && { list_id: input.listId }) })
}

export async function setTodo($: $, listId: string, itemId: string, status: 'pending' | 'active' | 'completed', notes?: string): Promise<void> {
  await call($, 'todo_set', { list_id: listId, item_id: itemId, status, ...(notes !== undefined && { notes }) })
}
