import { describe, it, expect, beforeEach } from 'vitest'
import { tmpdir } from 'os'
import type Database from 'better-sqlite3'
import {
  openDatabase, insertPlan, insertTask, getTask, getPlan, getVerifications, updateTask,
  runVerifyCommand, checkCompletion, runChecks, approveTask, rejectTask, overrideCompletion, getGateStatus, GateError,
  type NewTask,
} from './index.js'

const PASS = 'node -e "console.log(\'all good\')"'
const FAIL = 'node -e "console.log(\'boom\'); process.exit(3)"'
const HANG = 'node -e "setTimeout(() => {}, 30000)"'

let db: Database.Database
const now = new Date().toISOString()

function addTask(fields: Partial<NewTask> = {}) {
  insertTask(db, { id: '1', plan_id: 'p1', goal: 'g', status: 'active', result: null, abandon_reason: null, state: {}, depends_on: null, created_at: now, updated_at: now, ...fields })
  return getTask(db, 'p1', '1')!
}
const plan = () => getPlan(db, 'p1')!

beforeEach(() => {
  db = openDatabase(':memory:')
  insertPlan(db, { id: 'p1', name: 'P', description: null, status: 'active', working_dir: tmpdir(), created_at: now, updated_at: now })
})

describe('runVerifyCommand', () => {
  it('passes on exit 0 and captures output', async () => {
    const r = await runVerifyCommand(PASS, tmpdir())
    expect(r).toMatchObject({ passed: true, exit_code: 0, timed_out: false })
    expect(r.output).toContain('all good')
  })

  it('fails on non-zero exit', async () => {
    const r = await runVerifyCommand(FAIL, tmpdir())
    expect(r).toMatchObject({ passed: false, exit_code: 3 })
    expect(r.output).toContain('boom')
  })

  it('times out and kills the command', async () => {
    const r = await runVerifyCommand(HANG, tmpdir(), 1)
    expect(r.passed).toBe(false)
    expect(r.timed_out).toBe(true)
    expect(r.output).toContain('timed out after 1s')
    expect(r.duration_ms).toBeLessThan(10_000)
  }, 15_000)

  it('fails when the working directory does not exist', async () => {
    const r = await runVerifyCommand(PASS, '/definitely/not/here')
    expect(r).toMatchObject({ passed: false })
    expect(r.output).toMatch(/Working directory not found/)
  })

  it('keeps only the tail of long output', async () => {
    const r = await runVerifyCommand('node -e "console.log(\'x\'.repeat(20000) + \'END\')"', tmpdir())
    expect(r.output.length).toBeLessThanOrEqual(4096)
    expect(r.output.trim().endsWith('END')).toBe(true)
  })
})

describe('checkCompletion — agent', () => {
  it('passes immediately when the task has no gates', async () => {
    expect(await checkCompletion(db, plan(), addTask(), { actor: 'agent' })).toEqual({ outcome: 'pass' })
  })

  it('blocks when evidence is missing for a criterion, without running the command', async () => {
    const t = addTask({ acceptance_criteria: ['returns 401', 'has tests'], verify_command: PASS })
    const r = await checkCompletion(db, plan(), t, { actor: 'agent', evidence: ['yes'] })
    expect(r).toMatchObject({ outcome: 'blocked', blockers: [{ gate: 'criteria' }] })
    expect(r.outcome === 'blocked' && r.blockers[0].message).toContain('"has tests"')
    expect(getVerifications(db, 'p1', '1')).toEqual([])
  })

  it('blocks on too many evidence entries', async () => {
    const t = addTask({ acceptance_criteria: ['a'] })
    expect(await checkCompletion(db, plan(), t, { actor: 'agent', evidence: ['x', 'y'] })).toMatchObject({ outcome: 'blocked' })
  })

  it('blocks on a failing command and records it', async () => {
    const t = addTask({ verify_command: FAIL })
    const r = await checkCompletion(db, plan(), t, { actor: 'agent' })
    expect(r).toMatchObject({ outcome: 'blocked', blockers: [{ gate: 'command', exit_code: 3 }] })
    expect(getVerifications(db, 'p1', '1')[0]).toMatchObject({ gate: 'command', passed: false, actor: 'agent', exit_code: 3 })
  })

  it('passes with evidence and a passing command, recording both', async () => {
    const t = addTask({ acceptance_criteria: ['a'], verify_command: PASS })
    expect(await checkCompletion(db, plan(), t, { actor: 'agent', evidence: ['done'] })).toEqual({ outcome: 'pass' })
    expect(getVerifications(db, 'p1', '1').map((v) => [v.gate, v.passed])).toEqual([['criteria', true], ['command', true]])
  })

  it('requests review when approval is required, and stays waiting', async () => {
    const t = addTask({ requires_approval: true, verify_command: PASS })
    expect(await checkCompletion(db, plan(), t, { actor: 'agent' })).toEqual({ outcome: 'awaiting_review' })
    const waiting = getTask(db, 'p1', '1')!
    expect(waiting.review_requested_at).not.toBeNull()
    expect(waiting.status).toBe('active')
    // Trying again doesn't rerun anything
    expect(await checkCompletion(db, plan(), waiting, { actor: 'agent' })).toEqual({ outcome: 'awaiting_review' })
    expect(getVerifications(db, 'p1', '1').filter((v) => v.gate === 'command')).toHaveLength(1)
  })
})

describe('checkCompletion — human', () => {
  it('waives criteria evidence and counts as approval', async () => {
    const t = addTask({ acceptance_criteria: ['a'], requires_approval: true })
    expect(await checkCompletion(db, plan(), t, { actor: 'human' })).toEqual({ outcome: 'pass' })
    expect(getTask(db, 'p1', '1')).toMatchObject({ approved_by: 'human', review_requested_at: null })
  })

  it('still enforces the verify command', async () => {
    const t = addTask({ verify_command: FAIL })
    expect(await checkCompletion(db, plan(), t, { actor: 'human' })).toMatchObject({ outcome: 'blocked' })
  })
})

describe('review actions', () => {
  async function waitingTask() {
    const t = addTask({ requires_approval: true })
    await checkCompletion(db, plan(), t, { actor: 'agent' })
  }

  it('approve completes the task', async () => {
    await waitingTask()
    approveTask(db, 'p1', '1')
    expect(getTask(db, 'p1', '1')).toMatchObject({ status: 'completed', review_requested_at: null, approved_by: 'human' })
    expect(getVerifications(db, 'p1', '1')[0]).toMatchObject({ gate: 'approval', passed: true })
  })

  it('reject sends it back with feedback in notes', async () => {
    await waitingTask()
    rejectTask(db, 'p1', '1', 'missing error handling')
    const t = getTask(db, 'p1', '1')!
    expect(t).toMatchObject({ status: 'active', review_requested_at: null })
    expect(t.notes).toContain('missing error handling')
    expect(getVerifications(db, 'p1', '1')[0]).toMatchObject({ gate: 'approval', passed: false, output: 'missing error handling' })
  })

  it('approve/reject require the task to be waiting for review', () => {
    addTask({ requires_approval: true })
    expect(() => approveTask(db, 'p1', '1')).toThrow(GateError)
    expect(() => rejectTask(db, 'p1', '1', 'x')).toThrow(/not waiting for review/)
  })

  it('reject requires feedback', async () => {
    await waitingTask()
    expect(() => rejectTask(db, 'p1', '1', '  ')).toThrow(/Feedback is required/)
  })

  it('override completes with a recorded reason', () => {
    addTask({ verify_command: FAIL })
    overrideCompletion(db, 'p1', '1', 'flaky test, verified manually')
    expect(getTask(db, 'p1', '1')!.status).toBe('completed')
    expect(getVerifications(db, 'p1', '1')[0]).toMatchObject({ gate: 'override', actor: 'human', output: 'flaky test, verified manually' })
    expect(() => overrideCompletion(db, 'p1', '1', 'again')).toThrow(/already completed/)
  })

  it('override requires a reason', () => {
    addTask()
    expect(() => overrideCompletion(db, 'p1', '1', '')).toThrow(/reason is required/)
  })
})

describe('runChecks and getGateStatus', () => {
  it('runs the command without completing and reports status', async () => {
    const t = addTask({ verify_command: FAIL, acceptance_criteria: ['a'] })
    const { result, gates } = await runChecks(db, plan(), t, 'agent')
    expect(result?.passed).toBe(false)
    expect(getTask(db, 'p1', '1')!.status).toBe('active')
    expect(gates).toMatchObject({ acceptance_criteria: ['a'], verify_command: FAIL, last_command: { passed: false, exit_code: 3 } })
  })

  it('is null for a task without gates', () => {
    expect(getGateStatus(db, addTask())).toBeNull()
  })

  it('reports awaiting review', () => {
    addTask({ requires_approval: true })
    updateTask(db, 'p1', '1', { review_requested_at: now })
    expect(getGateStatus(db, getTask(db, 'p1', '1')!)).toMatchObject({ awaiting_review: true, requires_approval: true })
  })
})
