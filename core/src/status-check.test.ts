import { describe, it, expect, beforeEach, vi } from 'vitest'
import type { Database } from './sqlite.js'
import {
  openDatabase, createGoal, getGoal, queueRun, startRun, endRun, updateRun, buildOverview,
  validateStatusCheck, evaluateStatusCheck, checkStatuses, resetStatusCheckTimes, statusCheckCommand, defaultRunFile,
  STATUS_CHECK_MAX_FAILURES, STATUS_CHECK_EVERY_MS, type RunFile,
} from './index.js'

let db: Database
const now = new Date().toISOString()
const check = { kind: 'github_pr', repo: 'owner/repo', number: 12, holds_while: ['OPEN'], otherwise: { MERGED: 'PR #12 merged', CLOSED: 'PR #12 closed' } }
const revision = () => (db.prepare('SELECT revision FROM plans WHERE id = ?').get('g1') as { revision: number }).revision
const answer = (state: string): RunFile => vi.fn(async () => JSON.stringify({ state }))

function endWith(status?: string, statusCheck?: unknown) {
  const run = startRun(db, queueRun(db, 'g1').id, null)
  return endRun(db, run.id, 'done', status, statusCheck)
}

beforeEach(() => {
  db = openDatabase(':memory:')
  resetStatusCheckTimes()
  createGoal(db, { id: 'g1', name: 'Fixer', description: null, status: 'active', working_dir: null, created_at: now, updated_at: now }, { objective: 'Fix issues', instructions: '' })
})

describe('validateStatusCheck', () => {
  it('accepts a well-formed check and cleans its otherwise texts', () => {
    expect(validateStatusCheck({ ...check, otherwise: { MERGED: '  merged\u001b[31m now\n' } })).toEqual({ ...check, otherwise: { MERGED: 'merged now' } })
  })

  it.each([
    [{ ...check, kind: 'shell' }, /kind/],
    [{ ...check, repo: 'owner/repo; rm -rf /' }, /repo/],
    [{ ...check, repo: '--help' }, /repo/],
    [{ ...check, repo: '../x' }, /repo/],
    [{ ...check, number: 0 }, /number/],
    [{ ...check, number: 1.5 }, /number/],
    [{ ...check, number: '12' }, /number/],
    [{ ...check, holds_while: [] }, /holds_while/],
    [{ ...check, holds_while: ['DRAFT'] }, /holds_while/],
    [{ ...check, kind: 'github_issue', holds_while: ['OPEN'], otherwise: { MERGED: 'x' } }, /otherwise/],
    [{ ...check, otherwise: { OPEN: 'x' } }, /both hold/],
    [{ ...check, otherwise: { MERGED: '   ' } }, /empty/],
  ])('refuses %j', (input, message) => {
    expect(() => validateStatusCheck(input)).toThrow(message)
  })
})

describe('endRun with a status check', () => {
  it('stores the check with the status, and replaces or clears it with the status', () => {
    endWith('PR #12 awaiting review', check)
    expect(getGoal(db, 'g1')).toMatchObject({ status_note: 'PR #12 awaiting review', status_check: check, status_check_failures: 0 })
    expect(getGoal(db, 'g1')!.status_check_at).not.toBeNull()
    endWith()
    expect(getGoal(db, 'g1')!.status_check).toEqual(check) // left out: kept
    endWith('clean')
    expect(getGoal(db, 'g1')).toMatchObject({ status_note: 'clean', status_check: null, status_check_at: null })
    endWith('PR #12 awaiting review', check)
    endWith('')
    expect(getGoal(db, 'g1')).toMatchObject({ status_note: null, status_check: null })
  })

  it('refuses a check without a status, or an invalid one, and leaves the run open', () => {
    const run = startRun(db, queueRun(db, 'g1').id, null)
    expect(() => endRun(db, run.id, 'done', undefined, check)).toThrow(/needs a status/)
    expect(() => endRun(db, run.id, 'done', '', check)).toThrow(/needs a status/)
    expect(() => endRun(db, run.id, 'done', 'x', { ...check, kind: 'cmd' })).toThrow(/kind/)
    expect(endRun(db, run.id, 'done', 'x', check).status).toBe('completed')
  })
})

describe('evaluateStatusCheck', () => {
  it('runs gh with an argument array and no shell', async () => {
    endWith('PR #12 awaiting review', check)
    const run = answer('OPEN')
    await evaluateStatusCheck(db, 'g1', run)
    expect(run).toHaveBeenCalledWith('gh', ['pr', 'view', '12', '--repo', 'owner/repo', '--json', 'state'])
    expect(statusCheckCommand({ ...check, kind: 'github_issue' } as never).args[0]).toBe('issue')
  })

  it('writes nothing while the status holds', async () => {
    endWith('PR #12 awaiting review', check)
    const before = revision()
    expect(await evaluateStatusCheck(db, 'g1', answer('OPEN'))).toEqual({ outcome: 'holds', value: 'OPEN' })
    expect(revision()).toBe(before)
    expect(getGoal(db, 'g1')!.status_note).toBe('PR #12 awaiting review')
  })

  it('changes the status to the otherwise text, keeps the untrusted mark and clears the check', async () => {
    const run = startRun(db, queueRun(db, 'g1').id, null)
    updateRun(db, run.id, { untrusted_at: now, untrusted_source: 'watch events' })
    endRun(db, run.id, 'done', 'PR #12 awaiting review', check)
    expect(await evaluateStatusCheck(db, 'g1', answer('MERGED'))).toMatchObject({ outcome: 'changed', text: 'PR #12 merged' })
    expect(getGoal(db, 'g1')).toMatchObject({ status_note: 'PR #12 merged', status_note_untrusted: 'watch events', status_check: null })
    const note = buildOverview(db).goals.find((g) => g.id === 'g1')!.status_note
    expect(note).toMatchObject({ text: 'PR #12 merged', stale: false })
  })

  it('marks the status stale for a value it has no text for', async () => {
    endWith('PR #12 awaiting review', { ...check, otherwise: { MERGED: 'merged' } })
    expect(await evaluateStatusCheck(db, 'g1', answer('CLOSED'))).toEqual({ outcome: 'stale', value: 'CLOSED' })
    expect(getGoal(db, 'g1')).toMatchObject({ status_note: 'PR #12 awaiting review', status_check_failures: STATUS_CHECK_MAX_FAILURES })
    expect(buildOverview(db).goals.find((g) => g.id === 'g1')!.status_note).toMatchObject({ stale: true })
  })

  it('counts failures and shows the status stale after three in a row; a holding answer resets the count', async () => {
    endWith('PR #12 awaiting review', check)
    const broken: RunFile = async () => { throw new Error('gh: not found') }
    expect(await evaluateStatusCheck(db, 'g1', broken)).toMatchObject({ outcome: 'failed' })
    await evaluateStatusCheck(db, 'g1', async () => 'not json')
    expect(getGoal(db, 'g1')!.status_check_failures).toBe(2)
    await evaluateStatusCheck(db, 'g1', answer('OPEN'))
    expect(getGoal(db, 'g1')!.status_check_failures).toBe(0)
    for (let i = 0; i < STATUS_CHECK_MAX_FAILURES; i++) await evaluateStatusCheck(db, 'g1', broken)
    expect(buildOverview(db).goals.find((g) => g.id === 'g1')!.status_note).toMatchObject({ stale: true })
  })
})

describe('checkStatuses', () => {
  it('checks each goal at most once every 5 minutes and skips goals without a check', async () => {
    const run = answer('OPEN')
    expect(await checkStatuses(db, ['g1'], new Date(), 20_000, run)).toBe(0)
    endWith('PR #12 awaiting review', check)
    const t = new Date()
    expect(await checkStatuses(db, ['g1'], t, 20_000, run)).toBe(1)
    expect(await checkStatuses(db, ['g1'], new Date(t.getTime() + 60_000), 20_000, run)).toBe(0)
    expect(await checkStatuses(db, ['g1'], new Date(t.getTime() + STATUS_CHECK_EVERY_MS), 20_000, run)).toBe(1)
    expect(run).toHaveBeenCalledTimes(2)
  })

  it('stops once its time budget is spent', async () => {
    endWith('PR #12 awaiting review', check)
    expect(await checkStatuses(db, ['g1'], new Date(), 0, answer('OPEN'))).toBe(0)
  })
})

describe('defaultRunFile', () => {
  it('runs a file without a shell, so shell syntax in an argument stays literal', async () => {
    const out = await defaultRunFile(process.execPath, ['-e', 'process.stdout.write(process.argv[1])', '$(echo hi) ; echo x'])
    expect(out).toBe('$(echo hi) ; echo x')
  })
})
