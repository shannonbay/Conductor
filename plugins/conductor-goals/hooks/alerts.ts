/**
 * Toasts and OS notifications for new proposals and failed runs, filtered by
 * the `alerts` setting and folded so a burst raises one notification.
 */
import type { EngineInterface } from 'claude-code'

import type { GoalCard, Snapshot } from '../types'
import { settings } from './api'
import { diffAlerts, statusText, type Seen } from './model'

type $ = EngineInterface

const NOTIFY_GAP_MS = 60_000

// Null until the first read, so what was already waiting at load stays quiet.
let seen: Seen | null = null
// Goal id → when it last raised an OS notification.
const lastNotified = new Map<string, number>()

export function resetAlerts(): void {
  seen = null
  lastNotified.clear()
}

export async function announce($: $, goals: GoalCard[], now: number): Promise<void> {
  const found = diffAlerts(seen, goals)
  seen = found.seen
  const level = settings.alerts
  const proposals = level === 'all' || level === 'proposals' ? found.proposals : []
  const failures = level === 'all' || level === 'failures' ? found.failures : []
  const lines = [
    ...(proposals.length === 1
      ? [`${proposals[0]!.goal.name}: "${proposals[0]!.item.title}" needs you`]
      : proposals.length > 1
        ? [`${proposals.length} new proposals need you`]
        : []),
    ...failures.map((f) => `${f.goal.name}: run failed${f.run.summary ? ` — ${f.run.summary}` : ''}`),
  ]
  if (lines.length === 0) return

  for (const line of lines) $.ui.toast(`Conductor · ${line}`)

  if (!settings.osNotifications) return
  // At most one notification per goal a minute; one notification for the lot.
  const goalIds = [...new Set([...proposals.map((p) => p.goal.id), ...failures.map((f) => f.goal.id)])]
  const due = goalIds.filter((id) => now - (lastNotified.get(id) ?? -Infinity) >= NOTIFY_GAP_MS)
  if (due.length === 0) return
  for (const id of due) lastNotified.set(id, now)
  try {
    await $.ui.notify(lines.join('\n'), { title: 'Conductor' })
  } catch {
    // No notification channel: the toast already showed it.
  }
}

export function showStatus($: $, s: Snapshot): void {
  $.ui.status(statusText(s))
}
