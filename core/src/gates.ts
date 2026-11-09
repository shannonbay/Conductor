/**
 * Verification gates: the checks a task must pass before it can be completed.
 *
 *   criteria — the completer gives evidence for every acceptance criterion
 *   command  — verify_command runs in the plan's working_dir and must exit 0
 *   approval — a human approves in the web UI (task waits with review_requested_at set)
 *
 * Agents must pass every gate. A human completing a task in the UI is the
 * judge of the criteria and counts as the approval, but the command still has
 * to pass unless they override with a recorded reason. Every check result is
 * stored in the verifications table as evidence.
 */
import { spawn, spawnSync } from 'child_process'
import { existsSync } from 'fs'
import type { Database } from 'better-sqlite3'
import { getLatestVerification, getPlan, getTask, insertVerification, updateTask } from './queries.js'
import { insertMemory } from './goals.js'
import type { PlanRow, Task, Verification } from './types.js'

export const DEFAULT_VERIFY_TIMEOUT_S = 300
export const OUTPUT_TAIL_CHARS = 4096

type Actor = 'human' | 'agent'

// ── Running a verify command ──────────────────────────────────────────────────

export interface CommandResult {
  passed: boolean
  exit_code: number | null
  /** Last OUTPUT_TAIL_CHARS of combined stdout + stderr. */
  output: string
  duration_ms: number
  timed_out: boolean
}

export function runVerifyCommand(command: string, cwd: string, timeoutS = DEFAULT_VERIFY_TIMEOUT_S): Promise<CommandResult> {
  const started = Date.now()
  const done = (r: Omit<CommandResult, 'duration_ms'>): CommandResult => ({ ...r, duration_ms: Date.now() - started })

  if (!existsSync(cwd)) {
    return Promise.resolve(done({ passed: false, exit_code: null, output: `Working directory not found: ${cwd}`, timed_out: false }))
  }

  return new Promise((resolve) => {
    let output = ''
    let timedOut = false
    const append = (chunk: Buffer) => {
      output = (output + chunk.toString()).slice(-OUTPUT_TAIL_CHARS)
    }

    const child = spawn(command, {
      cwd,
      shell: true,
      windowsHide: true,
      // Own process group on POSIX so a timeout can kill the whole tree
      detached: process.platform !== 'win32',
    })
    child.stdout?.on('data', append)
    child.stderr?.on('data', append)

    const timer = setTimeout(() => {
      timedOut = true
      killTree(child.pid)
    }, timeoutS * 1000)

    child.on('error', (e) => {
      clearTimeout(timer)
      resolve(done({ passed: false, exit_code: null, output: `Could not run command: ${e.message}`, timed_out: false }))
    })
    child.on('close', (code) => {
      clearTimeout(timer)
      if (timedOut) output = `${output}\n[timed out after ${timeoutS}s]`.slice(-OUTPUT_TAIL_CHARS)
      resolve(done({ passed: !timedOut && code === 0, exit_code: code, output, timed_out: timedOut }))
    })
  })
}

function killTree(pid: number | undefined): void {
  if (!pid) return
  try {
    if (process.platform === 'win32') spawnSync('taskkill', ['/pid', String(pid), '/T', '/F'], { windowsHide: true })
    else process.kill(-pid, 'SIGKILL')
  } catch { /* already exited */ }
}

// ── Gate status (for context views and the UI) ────────────────────────────────

export interface GateStatus {
  acceptance_criteria: string[]
  verify_command: string | null
  requires_approval: boolean
  awaiting_review: boolean
  approved: { by: string | null; at: string } | null
  last_command: { passed: boolean; exit_code: number | null; at: string; output: string | null } | null
}

export function hasGates(task: Task): boolean {
  return Boolean(task.acceptance_criteria?.length || task.verify_command || task.requires_approval)
}

/** Null when the task has no gates. */
export function getGateStatus(db: Database, task: Task): GateStatus | null {
  if (!hasGates(task)) return null
  const last = task.verify_command ? getLatestVerification(db, task.plan_id, task.id, 'command') : undefined
  return {
    acceptance_criteria: task.acceptance_criteria ?? [],
    verify_command: task.verify_command,
    requires_approval: task.requires_approval,
    awaiting_review: task.review_requested_at !== null,
    approved: task.approved_at ? { by: task.approved_by, at: task.approved_at } : null,
    last_command: last ? { passed: last.passed, exit_code: last.exit_code, at: last.created_at, output: last.passed ? null : last.output } : null,
  }
}

// ── Completion ────────────────────────────────────────────────────────────────

export interface Blocker {
  gate: 'criteria' | 'command'
  message: string
  exit_code?: number | null
  output?: string
}

export type CompletionOutcome =
  /** Every gate passed — the caller should now set status to completed. */
  | { outcome: 'pass' }
  /** At least one gate failed; nothing was completed. */
  | { outcome: 'blocked'; blockers: Blocker[] }
  /** All automatic gates passed; the task now waits for a human to approve it. */
  | { outcome: 'awaiting_review' }

export interface CompletionInput {
  actor: Actor
  /** One entry per acceptance criterion, in order (agents only). */
  evidence?: string[]
}

/**
 * Runs a task's gates for a completion attempt and records the results.
 * Does not change the task's status: the caller does that on `pass`.
 */
export async function checkCompletion(db: Database, plan: PlanRow, task: Task, input: CompletionInput): Promise<CompletionOutcome> {
  const { actor } = input
  if (!hasGates(task)) return { outcome: 'pass' }

  if (actor === 'agent' && task.review_requested_at) return { outcome: 'awaiting_review' }

  // Criteria (agents only — a human completing in the UI is the judge)
  const criteria = task.acceptance_criteria ?? []
  if (actor === 'agent' && criteria.length > 0) {
    const evidence = input.evidence ?? []
    const missing = criteria.filter((_, i) => !evidence[i]?.trim())
    if (missing.length > 0 || evidence.length > criteria.length) {
      return {
        outcome: 'blocked',
        blockers: [{
          gate: 'criteria',
          message: evidence.length > criteria.length
            ? `Got ${evidence.length} evidence entries for ${criteria.length} criteria. Give exactly one per criterion, in order.`
            : `Missing evidence for ${missing.length} of ${criteria.length} acceptance criteria: ${missing.map((c) => `"${c}"`).join('; ')}. ` +
              'Pass `evidence` with one entry per criterion, in order, saying how it is met.',
        }],
      }
    }
  }

  // Command
  if (task.verify_command) {
    const r = await runVerifyCommand(task.verify_command, plan.working_dir, task.verify_timeout_s ?? DEFAULT_VERIFY_TIMEOUT_S)
    insertVerification(db, {
      plan_id: plan.id, task_id: task.id, gate: 'command', passed: r.passed, actor,
      command: task.verify_command, exit_code: r.exit_code, output: r.output, duration_ms: r.duration_ms,
    })
    if (!r.passed) {
      return {
        outcome: 'blocked',
        blockers: [{
          gate: 'command',
          message: r.timed_out
            ? `Verify command timed out: ${task.verify_command}`
            : `Verify command failed (exit ${r.exit_code ?? 'none'}): ${task.verify_command}`,
          exit_code: r.exit_code,
          output: r.output,
        }],
      }
    }
  }

  if (actor === 'agent' && criteria.length > 0) {
    insertVerification(db, { plan_id: plan.id, task_id: task.id, gate: 'criteria', passed: true, actor, evidence: input.evidence! })
  }

  // Approval (already approved — e.g. a goal proposal approved before the agent acted — passes)
  if (task.requires_approval && !task.approved_at) {
    const now = new Date().toISOString()
    if (actor === 'agent') {
      updateTask(db, plan.id, task.id, { review_requested_at: now, updated_at: now })
      return { outcome: 'awaiting_review' }
    }
    // A human completing the task is the approval
    insertVerification(db, { plan_id: plan.id, task_id: task.id, gate: 'approval', passed: true, actor })
    updateTask(db, plan.id, task.id, { approved_by: 'human', approved_at: now, review_requested_at: null, updated_at: now })
  }

  return { outcome: 'pass' }
}

/** Runs the verify command without completing anything (agent self-check, or "Run checks" in the UI). */
export async function runChecks(db: Database, plan: PlanRow, task: Task, actor: Actor): Promise<{ result: CommandResult | null; gates: GateStatus | null }> {
  let result: CommandResult | null = null
  if (task.verify_command) {
    result = await runVerifyCommand(task.verify_command, plan.working_dir, task.verify_timeout_s ?? DEFAULT_VERIFY_TIMEOUT_S)
    insertVerification(db, {
      plan_id: plan.id, task_id: task.id, gate: 'command', passed: result.passed, actor,
      command: task.verify_command, exit_code: result.exit_code, output: result.output, duration_ms: result.duration_ms,
    })
  }
  return { result, gates: getGateStatus(db, getTask(db, plan.id, task.id)!) }
}

// ── Human review actions ──────────────────────────────────────────────────────

function requireAwaitingReview(task: Task): void {
  if (!task.review_requested_at) throw new GateError(`Task ${task.id} is not waiting for review.`)
}

export class GateError extends Error {}

/** A goal work item proposing an action the agent will carry out once approved. */
export function isProposal(task: Task): boolean {
  return typeof task.state?.action === 'object' && task.state.action !== null
}

/** An item asking the person for something only they can give or do (add_item with ask_person). */
export function asksPerson(task: Task): boolean {
  return task.state?.asks_person === true
}

/**
 * Approves a task waiting for review. Normally this completes it. A goal
 * proposal (state.action) stays active instead: approval means "go ahead",
 * and the next goal run carries out the action and then completes the item.
 */
export function approveTask(db: Database, planId: string, taskId: string): Verification {
  const task = mustGet(db, planId, taskId)
  requireAwaitingReview(task)
  const now = new Date().toISOString()
  const v = insertVerification(db, { plan_id: planId, task_id: taskId, gate: 'approval', passed: true, actor: 'human' })
  updateTask(db, planId, taskId, {
    ...(isProposal(task) ? {} : { status: 'completed' as const }),
    approved_by: 'human', approved_at: now, review_requested_at: null, updated_at: now,
  })
  return v
}

/** Rejects a task waiting for review: it goes back to active with the feedback added to its notes. */
export function rejectTask(db: Database, planId: string, taskId: string, feedback: string): Verification {
  if (!feedback.trim()) throw new GateError('Feedback is required when rejecting.')
  const task = mustGet(db, planId, taskId)
  requireAwaitingReview(task)
  const now = new Date().toISOString()
  const v = insertVerification(db, { plan_id: planId, task_id: taskId, gate: 'approval', passed: false, actor: 'human', output: feedback })
  const note = `Review rejected (${now}): ${feedback}`
  updateTask(db, planId, taskId, {
    review_requested_at: null,
    approved_by: null,
    approved_at: null,
    notes: task.notes ? `${task.notes}\n\n${note}` : note,
    updated_at: now,
  })
  // On a persistent goal, feedback becomes memory so later runs learn from it
  if (getPlan(db, planId)?.kind === 'goal') {
    insertMemory(db, { plan_id: planId, kind: 'preference', text: `Feedback on "${task.goal}": ${feedback.trim()}`, source: 'feedback', source_ref: taskId })
  }
  return v
}

/** Completes a task despite failing gates. Humans only; the reason is kept as evidence. */
export function overrideCompletion(db: Database, planId: string, taskId: string, reason: string): Verification {
  if (!reason.trim()) throw new GateError('A reason is required to override verification.')
  const task = mustGet(db, planId, taskId)
  if (task.status === 'completed') throw new GateError(`Task ${taskId} is already completed.`)
  const now = new Date().toISOString()
  const v = insertVerification(db, { plan_id: planId, task_id: taskId, gate: 'override', passed: true, actor: 'human', output: reason })
  updateTask(db, planId, taskId, { status: 'completed', review_requested_at: null, updated_at: now })
  return v
}

function mustGet(db: Database, planId: string, taskId: string): Task {
  const task = getTask(db, planId, taskId)
  if (!task) throw new GateError(`Task ${taskId} not found.`)
  return task
}

/** Describes blockers as one message, for tool errors and API responses. */
export function describeBlockers(blockers: Blocker[]): string {
  return blockers.map((b) => b.output ? `${b.message}\n--- output (last ${OUTPUT_TAIL_CHARS} chars) ---\n${b.output.trim()}` : b.message).join('\n\n')
}
