/**
 * Keeps the snapshot current: one read at a time, adaptive polling, and the
 * shared wrapper every button and tool uses to run an action then re-read.
 */
import type { EngineInterface } from 'claude-code'

import type { Snapshot } from '../types'
import { announce, showStatus, savePoll } from './alerts'
import { fetchOverview, fetchTodos, settings } from './api'
import { toCard } from './model'
import { kick } from './runner'
import { getSnapshot, setBusy, setNotice, setSnapshot, setTodos, getExpanded } from './state'

type $ = EngineInterface

const FAST_MS = 5_000
const MAX_BACKOFF_MS = 60_000

let inFlight: Promise<Snapshot> | null = null
let failures = 0
let timer: { cancel: () => void } | null = null

/** Reads the overview once; a read already under way is shared, not repeated. */
export function refresh($: $): Promise<Snapshot> {
  // The to-do lists are re-read every time, even when the goals overview is unchanged
  inFlight ??= load($).then(async (s) => {
    await refreshTodos($)
    return s
  }).finally(() => {
    inFlight = null
  })
  return inFlight
}

async function load($: $): Promise<Snapshot> {
  const previous = await getSnapshot($)
  const now = await $.clock.now()
  let next: Snapshot
  try {
    // Expanded goals come with their detail; if that ever makes the answer too large to read, cards alone still work
    const res = await fetchOverview($, previous.reachable ? previous.etag : null, await getExpanded($))
      .catch((err: unknown) => {
        if (err instanceof Error && /too large/.test(err.message)) return fetchOverview($, null, [])
        throw err
      })
    failures = 0
    if (!res.changed) {
      // Unchanged: keep the stored value so nothing redraws, unless it was offline.
      if (previous.reachable) return previous
      next = { ...previous, reachable: true, error: null, fetchedAt: now }
    } else {
      const goals = res.goals.map(toCard)
      next = { reachable: true, error: null, goals, fetchedAt: now, etag: res.etag, hold: res.hold }
      await announce($, goals, now)
    }
  } catch (err) {
    failures += 1
    next = { ...previous, reachable: false, error: err instanceof Error ? err.message : String(err), fetchedAt: now, etag: null }
  }
  await setSnapshot($, next)
  showStatus($, next)
  return next
}

/** How long until the next poll: quicker while a run is open, backing off while offline. */
export function nextDelay(s: Snapshot): number {
  const base = settings.pollSeconds * 1000
  if (!s.reachable) return Math.min(base * 2 ** Math.max(failures - 1, 0), Math.max(MAX_BACKOFF_MS, base))
  if (s.goals.some((g) => g.openRun)) return Math.min(FAST_MS, base)
  return base
}

/** Polls until `stopPolling`; each poll schedules the next. */
export function startPolling($: $, first: Snapshot): void {
  timer?.cancel()
  timer = $.clock.after(nextDelay(first), () => {
    void $.clock.now().then((t) => savePoll($, t))
    void refresh($).then((s) => startPolling($, s))
  })
}

export function stopPolling(): void {
  timer?.cancel()
  timer = null
}

/**
 * Runs one action for a button or tool: marks it busy under `key`, records
 * its error (or clears the last one), then re-reads. Resolves whether it worked.
 */
export async function act($: $, key: string, label: string, run: () => Promise<void>): Promise<boolean> {
  await setBusy($, key)
  let ok = false
  try {
    await run()
    await setNotice($, null)
    ok = true
    await kick($) // an approval or "Run now" queued a run: start it now
  } catch (err) {
    await setNotice($, `Couldn't ${label}: ${err instanceof Error ? err.message : String(err)}`)
  }
  await setBusy($, null)
  await refresh($)
  return ok
}

/** Re-reads this project's to-do lists (a failed read keeps the last one). The project is the session's root: a shell `cd` into a subfolder doesn't move it. */
export async function refreshTodos($: $): Promise<void> {
  try {
    const dir = await $.session.root()
    await setTodos($, { dir, lists: await fetchTodos($, dir) })
  } catch {
    // not connected: the pane says so for the goals
  }
}
