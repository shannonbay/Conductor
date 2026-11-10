/**
 * Toasts, notifications and phone pushes for new proposals and failed runs,
 * filtered by the `alerts` setting and folded so a burst raises one.
 *
 * Phone: Claude Code's PushNotification tool reaches the Claude app while
 * Remote Control is connected (it skips the push while the person is at the
 * terminal or has mobile push off). A push the plugin sends itself is
 * reported as sent but never arrives (Claude Code 2.1.319), so by default the
 * alert is relayed: when the person hasn't typed for IDLE_MS, the plugin
 * submits a short prompt and Claude sends the push. From the phone, the person
 * answers in the session ("approve it"); Claude approves with approve_item,
 * which asks them to confirm.
 */
import type { EngineInterface } from 'claude-code'

import type { GoalCard, Snapshot } from '../types'
import { settings } from './api'
import { diffAlerts, statusText, type Seen } from './model'

type $ = EngineInterface

const NOTIFY_GAP_MS = 60_000
const PUSH_MAX = 200 // mobile systems cut longer pushes
const IDLE_MS = 5 * 60_000 // relay only when the person hasn't typed for this long
const ACTIVE_KEY = 'lastActive'

// Null until the first read, so what was already waiting at load stays quiet.
let seen: Seen | null = null
// Goal id → when it last raised an OS notification.
const lastNotified = new Map<string, number>()

/**
 * The last alert and what became of it, kept in the plugin's store (shared by
 * every hook file) for goals_status: why a phone push didn't come is
 * otherwise invisible.
 */
export type AlertRecord = { at: number; text: string; notify: string; push: string }
export const LAST_ALERT_KEY = 'lastAlert'

export async function readLastAlert($: $): Promise<AlertRecord | null> {
  try {
    const v = await $.store.get(LAST_ALERT_KEY)
    return v && typeof v === 'object' ? (v as AlertRecord) : null
  } catch {
    return null
  }
}

/** The person typed or sent a message (terminal or phone): no relay for a while. */
export async function markActive($: $, at: number): Promise<void> {
  try {
    await $.store.set(ACTIVE_KEY, at)
  } catch {
    // a missed mark only means one extra relay
  }
}

async function isIdle($: $, now: number): Promise<boolean> {
  try {
    const v = await $.store.get(ACTIVE_KEY)
    return typeof v !== 'number' || now - v >= IDLE_MS
  } catch {
    return true
  }
}

/** When the plugin's own timer last polled (not a refresh a tool or button asked for). */
export async function readLastPoll($: $): Promise<number | null> {
  try {
    const v = await $.store.get('lastPoll')
    return typeof v === 'number' ? v : null
  } catch {
    return null
  }
}

export async function savePoll($: $, at: number): Promise<void> {
  try {
    await $.store.set('lastPoll', at)
  } catch {
    // only a diagnostic
  }
}

async function saveAlert($: $, record: AlertRecord): Promise<void> {
  try {
    await $.store.set(LAST_ALERT_KEY, record)
  } catch {
    // only a diagnostic
  }
}

const SEEN_KEY = 'alertSeen'

async function loadSeen($: $): Promise<Seen | null> {
  try {
    const v = (await $.store.get(SEEN_KEY)) as Seen | undefined
    return v && Array.isArray(v.items) && Array.isArray(v.failures) ? v : null
  } catch {
    return null
  }
}

async function saveSeen($: $, value: Seen): Promise<void> {
  try {
    await $.store.set(SEEN_KEY, value)
  } catch {
    // a lost save only means an alert may repeat once
  }
}

/** The last few alert checks, for goals_status (a diagnostic). */
async function trace($: $, line: string): Promise<void> {
  try {
    const prev = ((await $.store.get('alertTrace')) as string[] | undefined) ?? []
    await $.store.set('alertTrace', [...prev, line].slice(-6))
  } catch {
    // only a diagnostic
  }
}

export async function readTrace($: $): Promise<string[]> {
  try {
    return ((await $.store.get('alertTrace')) as string[] | undefined) ?? []
  } catch {
    return []
  }
}

export function resetAlerts(): void {
  seen = null
  lastNotified.clear()
}

export async function announce($: $, goals: GoalCard[], now: number): Promise<void> {
  // What was already alerted on survives restarts and reloads (the store), so a
  // proposal that arrives while the plugin restarts still raises its alert
  const before = seen ? 'memory' : 'store'
  if (!seen) seen = await loadSeen($)
  const found = diffAlerts(seen, goals)
  await trace($, `${new Date(now).toISOString()} seen from ${before}${seen ? ` (${seen.items.length} items)` : ' (none: first look)'}, now ${found.seen.items.length} waiting, new ${found.proposals.length}`)
  seen = found.seen
  await saveSeen($, seen)
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

  for (const line of lines) $.ui.toast(`Quarterdeck · ${line}`)
  const record: AlertRecord = { at: now, text: lines.join('; '), notify: 'not sent (os_notifications off)', push: 'not sent (phone_push and phone_relay off)' }

  if (!settings.osNotifications && !settings.phonePush && !settings.phoneRelay) {
    await saveAlert($, record)
    return
  }
  // At most one notification per goal a minute; one notification for the lot.
  const goalIds = [...new Set([...proposals.map((p) => p.goal.id), ...failures.map((f) => f.goal.id)])]
  const due = goalIds.filter((id) => now - (lastNotified.get(id) ?? -Infinity) >= NOTIFY_GAP_MS)
  if (due.length === 0) {
    record.notify = record.push = 'not sent (one a minute per goal)'
    await saveAlert($, record)
    return
  }
  for (const id of due) lastNotified.set(id, now)
  if (settings.osNotifications) {
    try {
      const r = await $.ui.notify(lines.join('\n'), { title: 'Quarterdeck' })
      record.notify = r.isSent ? `sent (${r.channel})` : `not sent (${r.reason})`
    } catch (err) {
      // No notification channel: the toast already showed it.
      record.notify = `failed: ${err instanceof Error ? err.message : String(err)}`
    }
  }
  const message = phoneText(proposals, failures)
  if (settings.phonePush) record.push = await pushToPhone($, message)
  else if (settings.phoneRelay) record.push = await relayToPhone($, message, now)
  await saveAlert($, record)
}

/** What the phone shows: the alert and how to answer it from there. */
export function phoneText(proposals: { goal: GoalCard; item: { title: string; asksPerson?: boolean } }[], failures: { goal: GoalCard }[]): string {
  const parts: string[] = []
  if (proposals.length === 1) {
    const { goal, item } = proposals[0]!
    parts.push(item.asksPerson
      ? `${goal.name} needs you: "${item.title}". Reply with your answer in Claude.`
      : `${goal.name} asks: "${item.title}". Reply "approve" or "reject, because ..." in Claude.`)
  } else if (proposals.length > 1) {
    parts.push(`${proposals.length} proposals need you. Reply "what needs me?" in Claude.`)
  }
  if (failures.length === 1) parts.push(`${failures[0]!.goal.name}: run failed.`)
  else if (failures.length > 1) parts.push(`${failures.length} goal runs failed.`)
  const text = `Quarterdeck: ${parts.join(' ')}`
  if (text.length <= PUSH_MAX) return text
  // Shorten the item's title, not the instruction
  const over = text.length - PUSH_MAX + 1
  return proposals.length === 1
    ? text.replace(`"${proposals[0]!.item.title}"`, `"${proposals[0]!.item.title.slice(0, Math.max(10, proposals[0]!.item.title.length - over))}…"`).slice(0, PUSH_MAX)
    : text.slice(0, PUSH_MAX)
}

/** The prompt that asks Claude to send the push. */
export function relayPrompt(message: string): string {
  return `[Quarterdeck alert, sent automatically while you're away] Send me this phone notification with the PushNotification tool (status "proactive"), word for word, then end your turn without doing anything else:\n${message}`
}

/** Passes the alert to Claude, which sends the push; only while the person seems away. */
async function relayToPhone($: $, message: string, now: number): Promise<string> {
  if (!(await isIdle($, now))) return "not relayed (you typed in the last 5 minutes)"
  try {
    await $.prompt.submit({ text: relayPrompt(message) })
    return 'relayed to Claude to push'
  } catch (err) {
    return `relay failed: ${err instanceof Error ? err.message : String(err)}`
  }
}

/**
 * Claude Code's own phone push; it decides whether to send (Remote Control,
 * mobile push, presence). Answers what happened, in words.
 */
async function pushToPhone($: $, message: string): Promise<string> {
  try {
    const r = await $.tool.call({ tool: 'PushNotification', message, status: 'proactive' } as never) as unknown as { result?: unknown; deny?: string }
    if (r.deny !== undefined) return `refused: ${r.deny}`
    const res = (r.result ?? {}) as { pushSent?: boolean; disabledReason?: string }
    if (res.pushSent === true) return 'sent to the phone'
    if (res.disabledReason) return `not sent (${res.disabledReason})`
    return `answered: ${JSON.stringify(r.result ?? r).slice(0, 200)}`
  } catch (err) {
    // No push in this session: the toast and notification already showed it.
    return `failed: ${err instanceof Error ? err.message : String(err)}`
  }
}

export function showStatus($: $, s: Snapshot): void {
  $.ui.status(statusText(s))
}
