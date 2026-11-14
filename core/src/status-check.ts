/**
 * Status checks: a run that sets a goal status describing something outside
 * Quarterdeck (a pull request awaiting review, an open issue) can attach a
 * cheap check to it. The scheduler evaluates the check between runs, so the
 * status changes when the outside thing does, without starting a run.
 *
 * A check is data, never a command: its kind picks the command
 * (`gh pr view` / `gh issue view`), and the repo and number are validated
 * before they reach it as separate arguments (no shell).
 */
import { execFile } from 'node:child_process'
import type { Database } from './sqlite.js'
import { getGoal, updateGoal } from './goals.js'
import { GoalError, cleanStatusNote } from './goal-engine.js'

/** The values each kind of check can see: the `state` gh reports. */
export const STATUS_CHECK_VALUES = {
  github_pr: ['OPEN', 'CLOSED', 'MERGED'],
  github_issue: ['OPEN', 'CLOSED'],
} as const

export type StatusCheckKind = keyof typeof STATUS_CHECK_VALUES

export interface StatusCheck {
  kind: StatusCheckKind
  /** owner/name on GitHub */
  repo: string
  number: number
  /** The values for which the status still holds. */
  holds_while: string[]
  /** What the status becomes when the check sees one of these values. */
  otherwise: Record<string, string>
}

/** Checks per goal are at least this far apart. */
export const STATUS_CHECK_EVERY_MS = 5 * 60_000
/** Failed checks in a row after which the status is shown as stale. */
export const STATUS_CHECK_MAX_FAILURES = 3
/** A pass starts no more status checks once it has spent this long on them. */
export const STATUS_CHECK_BUDGET_MS = 20_000
const COMMAND_TIMEOUT_MS = 15_000

const REPO_RE = /^[\w.-]+\/[\w.-]+$/

/**
 * Validates a check a run gives through end_run and returns it in its stored
 * form (otherwise texts cleaned like a status). Throws GoalError on anything
 * outside the kind's shape.
 */
export function validateStatusCheck(input: unknown): StatusCheck {
  if (!input || typeof input !== 'object') throw new GoalError('status_check must be an object.')
  const c = input as Record<string, unknown>
  const kind = c.kind as StatusCheckKind
  if (typeof kind !== 'string' || !Object.prototype.hasOwnProperty.call(STATUS_CHECK_VALUES, kind)) {
    throw new GoalError(`status_check.kind must be one of: ${Object.keys(STATUS_CHECK_VALUES).join(', ')}.`)
  }
  const values: readonly string[] = STATUS_CHECK_VALUES[kind]
  if (typeof c.repo !== 'string' || !REPO_RE.test(c.repo) || c.repo.split('/').some((p) => p === '.' || p === '..')) {
    throw new GoalError('status_check.repo must be owner/name.')
  }
  if (typeof c.number !== 'number' || !Number.isSafeInteger(c.number) || c.number <= 0) {
    throw new GoalError('status_check.number must be a positive integer.')
  }
  if (!Array.isArray(c.holds_while) || c.holds_while.length === 0) {
    throw new GoalError('status_check.holds_while must list at least one value.')
  }
  for (const v of c.holds_while) {
    if (typeof v !== 'string' || !values.includes(v)) throw new GoalError(`status_check.holds_while values must be among: ${values.join(', ')}.`)
  }
  const otherwiseIn = c.otherwise ?? {}
  if (typeof otherwiseIn !== 'object' || Array.isArray(otherwiseIn)) throw new GoalError('status_check.otherwise must map values to statuses.')
  const otherwise: Record<string, string> = {}
  for (const [v, text] of Object.entries(otherwiseIn as Record<string, unknown>)) {
    if (!values.includes(v)) throw new GoalError(`status_check.otherwise keys must be among: ${values.join(', ')}.`)
    if ((c.holds_while as string[]).includes(v)) throw new GoalError(`status_check value ${v} can't both hold and change the status.`)
    if (typeof text !== 'string') throw new GoalError('status_check.otherwise values must be text.')
    const clean = cleanStatusNote(text)
    if (!clean) throw new GoalError('status_check.otherwise texts must not be empty.')
    otherwise[v] = clean
  }
  return { kind, repo: c.repo, number: c.number, holds_while: [...new Set(c.holds_while as string[])], otherwise }
}

/** Runs a command with an argument array (no shell) and returns its stdout. */
export type RunFile = (file: string, args: string[]) => Promise<string>

export const defaultRunFile: RunFile = (file, args) => new Promise((resolve, reject) => {
  execFile(file, args, { timeout: COMMAND_TIMEOUT_MS, windowsHide: true, shell: false }, (err, stdout) => {
    if (err) reject(err)
    else resolve(String(stdout))
  })
})

/** The command and arguments for a check. */
export function statusCheckCommand(check: StatusCheck): { file: string; args: string[] } {
  const sub = check.kind === 'github_pr' ? 'pr' : 'issue'
  return { file: 'gh', args: [sub, 'view', String(check.number), '--repo', check.repo, '--json', 'state'] }
}

/** What a check saw: `holds` (nothing changes), `changed` (status set to `text`), `stale` or `failed`. */
export type StatusCheckOutcome =
  | { outcome: 'holds'; value: string }
  | { outcome: 'changed'; value: string; text: string }
  | { outcome: 'stale'; value: string }
  | { outcome: 'failed'; error: string }

/**
 * Evaluates the goal's status check once and applies the result. When the
 * status holds nothing is written (so the goal's revision doesn't change).
 */
export async function evaluateStatusCheck(db: Database, planId: string, runFile: RunFile = defaultRunFile): Promise<StatusCheckOutcome | null> {
  const goal = getGoal(db, planId)
  const check = goal?.status_check
  if (!goal || !check || !goal.status_note) return null
  const { file, args } = statusCheckCommand(check)
  let value: string
  try {
    const out = JSON.parse(await runFile(file, args)) as { state?: unknown }
    if (typeof out.state !== 'string') throw new Error('no state in the answer')
    value = out.state
  } catch (err) {
    // A goal changed meanwhile keeps its new check untouched
    const now = getGoal(db, planId)
    if (now?.status_check && JSON.stringify(now.status_check) === JSON.stringify(check)) {
      updateGoal(db, planId, { status_check_failures: (now.status_check_failures ?? 0) + 1 })
    }
    return { outcome: 'failed', error: (err as Error).message }
  }
  const current = getGoal(db, planId)
  if (!current?.status_check || JSON.stringify(current.status_check) !== JSON.stringify(check)) return null
  if (check.holds_while.includes(value)) {
    if (current.status_check_failures) updateGoal(db, planId, { status_check_failures: 0 })
    return { outcome: 'holds', value }
  }
  const text = check.otherwise[value]
  if (text) {
    updateGoal(db, planId, {
      status_note: text,
      status_note_at: new Date().toISOString(),
      // The text came from the run that attached the check: it keeps that run's mark
      status_note_untrusted: current.status_note_untrusted,
      status_check: null,
      status_check_at: null,
      status_check_failures: 0,
    })
    return { outcome: 'changed', value, text }
  }
  if ((current.status_check_failures ?? 0) < STATUS_CHECK_MAX_FAILURES) {
    updateGoal(db, planId, { status_check_failures: STATUS_CHECK_MAX_FAILURES })
  }
  return { outcome: 'stale', value }
}

/** When each goal's check last ran, kept in memory so a holding check writes nothing. */
const lastChecked = new Map<string, number>()

/** For tests: forget when checks last ran. */
export function resetStatusCheckTimes(): void {
  lastChecked.clear()
}

/**
 * Evaluates the status checks of the given goals that are due (at most one per
 * goal every STATUS_CHECK_EVERY_MS), one after another, within `budgetMs`.
 */
export async function checkStatuses(
  db: Database, planIds: string[], now: Date = new Date(), budgetMs = STATUS_CHECK_BUDGET_MS, runFile: RunFile = defaultRunFile,
): Promise<number> {
  const started = Date.now()
  let checked = 0
  for (const planId of planIds) {
    const goal = getGoal(db, planId)
    if (!goal?.status_check || !goal.status_note) continue
    if (goal.status_check_failures >= STATUS_CHECK_MAX_FAILURES) continue // already stale: wait for the next run
    const last = lastChecked.get(planId)
    if (last !== undefined && now.getTime() - last < STATUS_CHECK_EVERY_MS) continue
    if (Date.now() - started >= budgetMs) return checked
    lastChecked.set(planId, now.getTime())
    await evaluateStatusCheck(db, planId, runFile).catch(() => { /* the goal went away meanwhile */ })
    checked++
  }
  return checked
}
