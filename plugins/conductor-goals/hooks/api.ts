/**
 * The Conductor web app's API, as this plugin uses it. Every call goes
 * through `$.http.fetch`; a non-2xx answer throws with the app's own error.
 */
import type { EngineInterface } from 'claude-code'

import type { OverviewGoal } from './model'

type $ = EngineInterface

export const DEFAULT_URL = 'http://localhost:3000'

/** Settings from the plugin's userConfig, set by `register`. */
export const settings = { url: DEFAULT_URL, pollSeconds: 15, alerts: 'all', osNotifications: true }

export function configure(options: Readonly<Record<string, unknown>>): void {
  const url = typeof options.url === 'string' && options.url.trim() ? options.url.trim() : DEFAULT_URL
  const poll = typeof options.poll_seconds === 'number' ? options.poll_seconds : 15
  settings.url = url.replace(/\/+$/, '')
  settings.pollSeconds = Math.min(Math.max(Math.round(poll), 5), 600)
  settings.alerts = typeof options.alerts === 'string' ? options.alerts : 'all'
  settings.osNotifications = options.os_notifications !== false
}

/**
 * The web app's address: the configured one, or one saved by the old
 * /conductor-url command while the setting is left at its default.
 */
export async function baseUrl($: $): Promise<string> {
  if (settings.url !== DEFAULT_URL) return settings.url
  const stored = await $.store.get('url')
  return typeof stored === 'string' && /^https?:\/\//.test(stored) ? stored.replace(/\/+$/, '') : DEFAULT_URL
}

export async function goalPageUrl($: $, goalId: string): Promise<string> {
  return `${await baseUrl($)}/goals/${encodeURIComponent(goalId)}`
}

async function call($: $, path: string, init: { method?: string; body?: unknown; headers?: Record<string, string> } = {}) {
  const res = await $.http.fetch(`${await baseUrl($)}${path}`, {
    method: init.method ?? 'GET',
    headers: { ...(init.body !== undefined && { 'Content-Type': 'application/json' }), ...init.headers },
    ...(init.body !== undefined && { body: JSON.stringify(init.body) }),
  })
  let data: unknown = null
  try {
    data = res.text ? JSON.parse(res.text) : null
  } catch {
    data = null
  }
  if (!res.ok && res.status !== 304) {
    const message = (data as { error?: unknown } | null)?.error
    throw new Error(typeof message === 'string' ? message : `HTTP ${res.status}`)
  }
  return { status: res.status, headers: res.headers, data }
}

function header(headers: Record<string, string>, name: string): string | null {
  const key = Object.keys(headers).find((k) => k.toLowerCase() === name)
  return key ? headers[key]! : null
}

/** The overview; `{ changed: false }` when it matches `etag`. */
export async function fetchOverview($: $, etag: string | null): Promise<{ changed: false } | { changed: true; goals: OverviewGoal[]; etag: string | null }> {
  const res = await call($, '/api/goals/overview', etag ? { headers: { 'If-None-Match': etag } } : {})
  if (res.status === 304) return { changed: false }
  return { changed: true, goals: (res.data as { goals: OverviewGoal[] }).goals, etag: header(res.headers, 'etag') }
}

const g = (id: string) => `/api/goals/${encodeURIComponent(id)}`
const task = (goalId: string, itemId: string) => `/api/plans/${encodeURIComponent(goalId)}/tasks/${encodeURIComponent(itemId)}`

export async function approve($: $, goalId: string, itemId: string): Promise<void> {
  await call($, `${task(goalId, itemId)}/approve`, { method: 'POST' })
}

export async function reject($: $, goalId: string, itemId: string, feedback: string): Promise<void> {
  await call($, `${task(goalId, itemId)}/reject`, { method: 'POST', body: { feedback } })
}

export async function runNow($: $, goalId: string): Promise<void> {
  await call($, `${g(goalId)}/run`, { method: 'POST' })
}

export async function cancelRun($: $, goalId: string): Promise<void> {
  await call($, `${g(goalId)}/run`, { method: 'DELETE' })
}

export async function setGoalStatus($: $, goalId: string, status: 'active' | 'paused'): Promise<void> {
  await call($, g(goalId), { method: 'PATCH', body: { status } })
}

export async function deleteMemory($: $, goalId: string, memoryId: string): Promise<void> {
  await call($, `${g(goalId)}/memory/${encodeURIComponent(memoryId)}`, { method: 'DELETE' })
}

export async function createGoal($: $, input: { name: string; objective: string; working_dir: string }): Promise<string> {
  const res = await call($, '/api/goals', { method: 'POST', body: input })
  return (res.data as { id: string }).id
}
