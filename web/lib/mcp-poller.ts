import { getDb } from './db'
import { broadcast, clientCount } from './ws-broadcaster'

// Per-plan high-water mark: ISO timestamp of the last change we detected.
const cursors = new Map<string, string>()

let pollInterval: ReturnType<typeof setInterval> | null = null

/**
 * Begin watching a plan for MCP-driven SQLite changes.
 * Sets the cursor to now so we only detect future mutations.
 */
export function startWatchingPlan(planId: string): void {
  if (!cursors.has(planId)) {
    cursors.set(planId, new Date().toISOString())
  }
}

/**
 * Start the polling loop (1 s interval). No-op if already running.
 */
export function startPoller(): void {
  if (pollInterval !== null) return
  pollInterval = setInterval(pollOnce, 1000)
}

/**
 * Stop the polling loop. Used in tests to avoid open handles.
 */
export function stopPoller(): void {
  if (pollInterval !== null) {
    clearInterval(pollInterval)
    pollInterval = null
  }
}

function pollOnce(): void {
  const db = getDb()
  const stmt = db.prepare(
    'SELECT 1 FROM tasks WHERE plan_id = ? AND updated_at > ? LIMIT 1'
  )

  for (const [planId, lastSeen] of cursors) {
    if (clientCount(planId) === 0) continue

    const row = stmt.get(planId, lastSeen)
    if (row) {
      cursors.set(planId, new Date().toISOString())
      broadcast(planId, { type: 'mcp_update' })
    }
  }
}
