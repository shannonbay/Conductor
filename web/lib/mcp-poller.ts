import { getPlanRevision } from './db'
import { broadcast, clientCount } from './ws-broadcaster'

// Last plans.revision seen per watched plan. SQLite triggers bump the revision
// on every task insert/update/delete and plan update, from any process (MCP
// server or web app), so a changed number means "something changed" —
// including deletions, which a timestamp column can't reveal.
const lastSeen = new Map<string, number>()

let pollInterval: ReturnType<typeof setInterval> | null = null

/**
 * Begin watching a plan for changes made outside this process (e.g. by the MCP server).
 * Records the current revision so only later changes are reported.
 */
export function startWatchingPlan(planId: string): void {
  if (!lastSeen.has(planId)) {
    const revision = getPlanRevision(planId)
    if (revision !== undefined) lastSeen.set(planId, revision)
  }
}

/** Start the polling loop (1 s interval). No-op if already running. */
export function startPoller(): void {
  if (pollInterval !== null) return
  pollInterval = setInterval(pollOnce, 1000)
}

/** Stop the polling loop. Used in tests to avoid open handles. */
export function stopPoller(): void {
  if (pollInterval !== null) {
    clearInterval(pollInterval)
    pollInterval = null
  }
}

/** Checks every watched plan once and broadcasts `mcp_update` for any that changed. */
export function pollOnce(): void {
  for (const [planId, seen] of lastSeen) {
    const revision = getPlanRevision(planId)
    if (revision === undefined) {
      lastSeen.delete(planId) // plan was deleted
      continue
    }
    if (revision === seen) continue
    lastSeen.set(planId, revision)
    if (clientCount(planId) > 0) broadcast(planId, { type: 'mcp_update' })
  }
}

/** Forget all watched plans. Used in tests. */
export function resetPoller(): void {
  stopPoller()
  lastSeen.clear()
}
