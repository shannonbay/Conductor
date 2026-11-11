import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import type { Database } from './sqlite.js'
import {
  openDatabase, createGoal, updateGoal, getGoal, getOpenRun, listRuns, buildBrief, claimRun, endRun, failRun, schedulerPass,
  setWatch, removeWatch, listWatches, getWatch, watchDue, watchFailing, toLines, recordWatchLines, checkCommandWatch, listWatchEvents,
  takeWatchEvents, checkWatches, queueForWatchEvents, applyGoalChanges, reportRunEnd, buildOverview, deleteGoal,
  WATCH_MAX_LINES, WATCH_SEEN_MAX, WATCH_LINE_CHARS, WATCH_BRIEF_LINES, WATCH_REPORT_GRACE_MS,
  matchLines, describeWatch, reportToolWatch,
} from './index.js'

let db: Database
let dir: string
const now = new Date().toISOString()
/** Prints items.txt: the test changes the file to change what the watch sees. */
const LIST = `node -e "process.stdout.write(require('fs').readFileSync('items.txt','utf8'))"`
const items = (...lines: string[]) => writeFileSync(join(dir, 'items.txt'), lines.join('\n'))
const later = (minutes: number) => new Date(Date.now() + minutes * 60_000)

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'qd-watch-'))
  db = openDatabase(':memory:')
  createGoal(db, { id: 'g1', name: 'Issues', description: null, status: 'active', working_dir: dir, created_at: now, updated_at: now }, { objective: 'Triage new issues', instructions: '' })
})

afterEach(() => rmSync(dir, { recursive: true, force: true }))

describe('setWatch', () => {
  it('adds a watch, changes it by name, and starts over when the command changes', () => {
    const w = setWatch(db, 'g1', ' new issues ', { command: 'echo 1' })
    expect(w).toMatchObject({ name: 'new issues', kind: 'command', command: 'echo 1', every_minutes: 5, seen: [], baseline_at: null })
    recordWatchLines(db, w.id, { lines: ['1'] })
    expect(setWatch(db, 'g1', 'new issues', { command: 'echo 1', every_minutes: 10 })).toMatchObject({ every_minutes: 10, seen: ['1'] })
    expect(setWatch(db, 'g1', 'new issues', { command: 'echo 2' })).toMatchObject({ id: w.id, seen: [], baseline_at: null })
    expect(listWatches(db, 'g1')).toHaveLength(1)
  })

  it('refuses a watch without a name or a command, or a check more often than every minute', () => {
    expect(() => setWatch(db, 'g1', ' ', { command: 'echo 1' })).toThrow(/name/)
    expect(() => setWatch(db, 'g1', 'x', { command: ' ' })).toThrow(/command/)
    expect(() => setWatch(db, 'g1', 'x', { command: 'echo 1', every_minutes: 0 })).toThrow(/minute/)
    expect(() => setWatch(db, 'nope', 'x', { command: 'echo 1' })).toThrow(/not found/)
  })

  it('removeWatch drops the watch and what it had waiting', () => {
    const w = setWatch(db, 'g1', 'x', { command: 'echo 1' })
    recordWatchLines(db, w.id, { lines: [] })
    recordWatchLines(db, w.id, { lines: ['a'] })
    expect(removeWatch(db, 'g1', 'x')).toBe(true)
    expect(removeWatch(db, 'g1', 'x')).toBe(false)
    expect(listWatchEvents(db, 'g1')).toEqual([])
  })
})

describe('recordWatchLines', () => {
  it('records the first check as the baseline and fires nothing', () => {
    const w = setWatch(db, 'g1', 'x', { command: 'echo 1' })
    expect(recordWatchLines(db, w.id, { lines: ['1', '2'] })).toEqual({ baseline: true, lines: 2, fresh: [] })
    expect(listWatchEvents(db, 'g1')).toEqual([])
    expect(getWatch(db, w.id)).toMatchObject({ seen: ['1', '2'], last_fired_at: null })
    expect(getWatch(db, w.id)!.baseline_at).not.toBeNull()
  })

  it('turns lines it has not seen into events, once', () => {
    const w = setWatch(db, 'g1', 'x', { command: 'echo 1' })
    recordWatchLines(db, w.id, { lines: ['1', '2'] })
    expect(recordWatchLines(db, w.id, { lines: ['3', '2', '1'] })).toEqual({ baseline: false, lines: 3, fresh: ['3'] })
    expect(recordWatchLines(db, w.id, { lines: ['3', '2', '1'] }).fresh).toEqual([])
    // A line that went away and came back is not new
    recordWatchLines(db, w.id, { lines: ['3'] })
    expect(recordWatchLines(db, w.id, { lines: ['3', '1'] }).fresh).toEqual([])
    expect(listWatchEvents(db, 'g1').map((e) => e.line)).toEqual(['3'])
    expect(getWatch(db, w.id)!.last_fired_at).not.toBeNull()
  })

  it('an empty check is a check: what comes next is new', () => {
    const w = setWatch(db, 'g1', 'x', { command: 'echo 1' })
    expect(recordWatchLines(db, w.id, { lines: [] })).toMatchObject({ baseline: true })
    expect(recordWatchLines(db, w.id, { lines: ['a'] }).fresh).toEqual(['a'])
  })

  it('a failed check leaves what was seen alone, and three in a row make the watch failing', () => {
    const w = setWatch(db, 'g1', 'x', { command: 'echo 1' })
    recordWatchLines(db, w.id, { lines: ['1'] })
    expect(recordWatchLines(db, w.id, { error: 'no network' })).toMatchObject({ fresh: [], error: 'no network' })
    expect(getWatch(db, w.id)).toMatchObject({ seen: ['1'], last_error: 'no network', fail_count: 1 })
    expect(watchFailing(getWatch(db, w.id)!)).toBe(false)
    recordWatchLines(db, w.id, { error: 'no network' })
    recordWatchLines(db, w.id, { error: 'no network' })
    expect(watchFailing(getWatch(db, w.id)!)).toBe(true)
    // It works again: nothing was lost, and nothing old looks new
    expect(recordWatchLines(db, w.id, { lines: ['1', '2'] }).fresh).toEqual(['2'])
    expect(getWatch(db, w.id)).toMatchObject({ last_error: null, fail_count: 0 })
  })

  it('remembers a capped number of lines, the latest check first', () => {
    const w = setWatch(db, 'g1', 'x', { command: 'echo 1' })
    const batch = (n: number) => Array.from({ length: WATCH_MAX_LINES }, (_, i) => `${n}-${i}`)
    for (let n = 0; n < WATCH_SEEN_MAX / WATCH_MAX_LINES + 2; n++) recordWatchLines(db, w.id, { lines: batch(n) })
    const seen = getWatch(db, w.id)!.seen
    expect(seen).toHaveLength(WATCH_SEEN_MAX)
    expect(seen[0]).toBe(`${WATCH_SEEN_MAX / WATCH_MAX_LINES + 1}-0`)
    expect(seen).not.toContain('0-0')
  })
})

describe('toLines', () => {
  it('trims, drops blanks and repeats, clips long lines and stops at the cap', () => {
    expect(toLines(' 12 \r\n\n7\n12\n')).toEqual(['12', '7'])
    expect(toLines('x'.repeat(WATCH_LINE_CHARS + 50))[0]).toHaveLength(WATCH_LINE_CHARS)
    expect(toLines(Array.from({ length: WATCH_MAX_LINES + 10 }, (_, i) => i).join('\n'))).toHaveLength(WATCH_MAX_LINES)
  })
})

describe('checkCommandWatch', () => {
  it("runs the command in the goal's directory and reads stdout only", async () => {
    items('1', '2')
    const w = setWatch(db, 'g1', 'x', { command: LIST })
    expect(await checkCommandWatch(db, w.id)).toEqual({ baseline: true, lines: 2, fresh: [] })
    items('1', '2', '3')
    expect((await checkCommandWatch(db, w.id)).fresh).toEqual(['3'])
    // What a command writes to stderr is not an item
    const noisy = setWatch(db, 'g1', 'noisy', { command: `node -e "console.error('warning'); console.log('a')"` })
    await checkCommandWatch(db, noisy.id)
    expect(getWatch(db, noisy.id)!.seen).toEqual(['a'])
  })

  it('a command that fails is a failed check, with why', async () => {
    const w = setWatch(db, 'g1', 'x', { command: `node -e "console.log('half'); console.error('rate limited'); process.exit(3)"` })
    const r = await checkCommandWatch(db, w.id)
    expect(r.error).toMatch(/Exit code 3: rate limited/)
    expect(getWatch(db, w.id)).toMatchObject({ seen: [], baseline_at: null, fail_count: 1 })
  })

  it('is due again once its interval has passed', async () => {
    items('1')
    const w = setWatch(db, 'g1', 'x', { command: LIST, every_minutes: 10 })
    expect(watchDue(w)).toBe(true)
    await checkCommandWatch(db, w.id)
    expect(watchDue(getWatch(db, w.id)!, later(9))).toBe(false)
    expect(watchDue(getWatch(db, w.id)!, later(10))).toBe(true)
  })
})

describe('the scheduler pass', () => {
  it('starts a run when a watch sees something new, and tells it what', async () => {
    items('1')
    setWatch(db, 'g1', 'new issues', { command: LIST, every_minutes: 1 })
    expect((await schedulerPass(db, { holder: 'A' })).claimed).toEqual([]) // the baseline
    items('1', '2')
    expect((await schedulerPass(db, { holder: 'A', now: later(0.5) })).claimed).toEqual([]) // not due yet
    const { claimed } = await schedulerPass(db, { holder: 'A', now: later(1) })
    expect(claimed).toHaveLength(1)
    expect(claimed[0]).toMatchObject({ goal_id: 'g1', trigger: 'watch' })
    expect(claimed[0]!.prompt).toContain('watch_events')
    const brief = buildBrief(db, 'g1', claimed[0]!.run_id)
    expect(brief.watch_events).toEqual([{ watch: 'new issues', new: ['2'], omitted: 0 }])
    // The run is told again if it asks again, and the next run is not
    expect(buildBrief(db, 'g1', claimed[0]!.run_id).watch_events).toHaveLength(1)
    endRun(db, claimed[0]!.run_id, 'Triaged issue 2')
    expect((await schedulerPass(db, { holder: 'A', now: later(2) })).claimed).toEqual([])
    expect(buildBrief(db, 'g1').watch_events).toEqual([])
  })

  it('what arrives during a run starts one more run after it, not one per event', async () => {
    items('1')
    const w = setWatch(db, 'g1', 'x', { command: LIST, every_minutes: 1 })
    await checkCommandWatch(db, w.id)
    const first = claimRun(db, 'g1', { holder: 'A' })!
    buildBrief(db, 'g1', first.run_id)
    recordWatchLines(db, w.id, { lines: ['1', '2'] })
    recordWatchLines(db, w.id, { lines: ['1', '2', '3'] })
    expect(queueForWatchEvents(db, 'g1')).toBeNull() // a run is going
    endRun(db, first.run_id, 'done')
    const queued = queueForWatchEvents(db, 'g1')
    expect(queued).toMatchObject({ trigger: 'watch', status: 'queued' })
    expect(queueForWatchEvents(db, 'g1')).toBeNull()
    const second = claimRun(db, 'g1', { holder: 'A', queuedRunId: queued!.id })!
    expect(buildBrief(db, 'g1', second.run_id).watch_events).toEqual([{ watch: 'x', new: ['2', '3'], omitted: 0 }])
  })

  it('events ride on a run that is already queued', () => {
    const w = setWatch(db, 'g1', 'x', { command: 'echo 1' })
    recordWatchLines(db, w.id, { lines: [] })
    const manual = claimRun(db, 'g1', { holder: 'A' })!
    failRun(db, manual.run_id, 'failed', 'x')
    const open = db.prepare("INSERT INTO goal_runs (id, plan_id, trigger, status, started_at) VALUES ('q1', 'g1', 'manual', 'queued', ?)").run(now)
    expect(open.changes).toBe(1)
    recordWatchLines(db, w.id, { lines: ['a'] })
    expect(queueForWatchEvents(db, 'g1')).toMatchObject({ id: 'q1', trigger: 'manual' })
    expect(listRuns(db, 'g1').filter((r) => r.status === 'queued')).toHaveLength(1)
  })

  it('a run that fails gives its events to the next run without queueing another', () => {
    const w = setWatch(db, 'g1', 'x', { command: 'echo 1' })
    recordWatchLines(db, w.id, { lines: [] })
    recordWatchLines(db, w.id, { lines: ['a'] })
    const run = claimRun(db, 'g1', { holder: 'A', queuedRunId: queueForWatchEvents(db, 'g1')!.id })!
    buildBrief(db, 'g1', run.run_id)
    failRun(db, run.run_id, 'failed', 'crashed')
    expect(queueForWatchEvents(db, 'g1')).toBeNull()
    expect(takeWatchEvents(db, 'g1')).toEqual([{ watch: 'x', new: ['a'], omitted: 0 }])
  })

  it('a run stopped by the usage limit queues again for its events', () => {
    const w = setWatch(db, 'g1', 'x', { command: 'echo 1' })
    recordWatchLines(db, w.id, { lines: [] })
    recordWatchLines(db, w.id, { lines: ['a'] })
    const run = claimRun(db, 'g1', { holder: 'A', queuedRunId: queueForWatchEvents(db, 'g1')!.id })!
    buildBrief(db, 'g1', run.run_id)
    expect(reportRunEnd(db, run.run_id, { answer: "You've hit your usage limit" }).outcome).toBe('held')
    expect(queueForWatchEvents(db, 'g1')).toMatchObject({ trigger: 'watch' })
  })

  it('past the daily run limit a noisy watch gets one skipped run, not one per pass', async () => {
    updateGoal(db, 'g1', { limits: { max_runs_per_day: 1 } })
    endRun(db, claimRun(db, 'g1', { holder: 'A' })!.run_id, 'the one run today')
    const w = setWatch(db, 'g1', 'x', { command: 'echo 1', every_minutes: 1000 })
    recordWatchLines(db, w.id, { lines: [] })
    recordWatchLines(db, w.id, { lines: ['a'] })
    for (let i = 0; i < 3; i++) expect((await schedulerPass(db, { holder: 'A' })).claimed).toEqual([])
    expect(listRuns(db, 'g1').filter((r) => r.status === 'skipped')).toHaveLength(1)
    expect(getOpenRun(db, 'g1')).toBeUndefined()
    // The news waits for whatever run comes next
    expect(takeWatchEvents(db, 'g1')).toEqual([{ watch: 'x', new: ['a'], omitted: 0 }])
  })

  it('checks nothing for a paused goal, and stops starting checks once out of time', async () => {
    items('1')
    setWatch(db, 'g1', 'a', { command: LIST })
    setWatch(db, 'g1', 'b', { command: LIST })
    expect(await checkWatches(db, ['g1'], new Date(), 0)).toBe(0)
    updateGoal(db, 'g1', { status: 'paused' })
    await schedulerPass(db, { holder: 'A' })
    expect(listWatches(db, 'g1').every((w) => w.last_checked_at === null)).toBe(true)
    updateGoal(db, 'g1', { status: 'active' })
    await schedulerPass(db, { holder: 'A' })
    expect(listWatches(db, 'g1').every((w) => w.baseline_at !== null)).toBe(true)
  })
})

describe('the brief', () => {
  it('lists at most a screenful per watch and counts the rest', () => {
    const w = setWatch(db, 'g1', 'x', { command: 'echo 1' })
    recordWatchLines(db, w.id, { lines: [] })
    recordWatchLines(db, w.id, { lines: Array.from({ length: WATCH_BRIEF_LINES + 5 }, (_, i) => `n${i}`) })
    const [news] = buildBrief(db, 'g1').watch_events
    expect(news!.new).toHaveLength(WATCH_BRIEF_LINES)
    expect(news!.omitted).toBe(5)
    // Read without a run, they still wait
    expect(listWatchEvents(db, 'g1').every((e) => e.run_id === null)).toBe(true)
  })
})

describe('changing watches', () => {
  it('applyGoalChanges adds, changes and removes them, and says what it did', () => {
    expect(applyGoalChanges(db, 'g1', { watches: { 'new issues': { command: 'gh issue list' } } }))
      .toEqual(['watch "new issues" added: every 5 min, runs gh issue list'])
    expect(applyGoalChanges(db, 'g1', { watches: { 'new issues': { command: 'gh issue list' } } })).toEqual([])
    expect(applyGoalChanges(db, 'g1', { watches: { 'new issues': { command: 'gh issue list', every_minutes: 15 } } }))
      .toEqual(['watch "new issues" changed: every 15 min, runs gh issue list'])
    expect(applyGoalChanges(db, 'g1', { watches: { 'new issues': null, gone: null } })).toEqual(['watch "new issues" removed'])
    expect(listWatches(db, 'g1')).toEqual([])
  })

  it('a watch that cannot be set changes nothing else', () => {
    expect(() => applyGoalChanges(db, 'g1', { instructions: 'Be brief', watches: { x: { command: '' } } })).toThrow(/command/)
    expect(getGoal(db, 'g1')!.instructions).toBe('')
  })
})

describe('tool watches', () => {
  const SEARCH = 'mcp__claude_ai_Gmail__search_threads'
  const answer = (...ids: string[]) => JSON.stringify({ resultCountEstimate: '201', threads: ids.map((id) => ({ id })) })

  it('reads lines out of a tool\'s answer: every "id" unless the watch says how', () => {
    expect(matchLines(answer('1a', '2b'), null)).toEqual(['1a', '2b'])
    expect(matchLines('{"threads":[{"id" : "1a"}]}', null)).toEqual(['1a'])
    expect(matchLines('PR #12 opened\nPR #15 opened', String.raw`#(\d+)`)).toEqual(['12', '15'])
    expect(matchLines('a1 b2', String.raw`[a-z]\d`)).toEqual(['a1', 'b2']) // no group: the whole match
    expect(matchLines('anything', '')).toEqual([]) // a pattern that matches nothing never loops
    expect(matchLines('{}', null)).toEqual([])
  })

  it('is set with a tool, its input and a match, and described in one line', () => {
    const w = setWatch(db, 'g1', 'mail', { tool: SEARCH, input: { query: 'is:unread', view: 'THREAD_VIEW_IDS_ONLY' } })
    expect(w).toMatchObject({ kind: 'tool', command: null, tool: SEARCH, tool_input: { query: 'is:unread', view: 'THREAD_VIEW_IDS_ONLY' }, match: null })
    expect(describeWatch(w)).toBe(`${SEARCH} {"query":"is:unread","view":"THREAD_VIEW_IDS_ONLY"}`)
    // The same check keeps what it saw; another input starts over; so does turning it into a command
    recordWatchLines(db, w.id, { lines: ['1a'] })
    expect(setWatch(db, 'g1', 'mail', { tool: SEARCH, input: { query: 'is:unread', view: 'THREAD_VIEW_IDS_ONLY' }, every_minutes: 10 }).seen).toEqual(['1a'])
    expect(setWatch(db, 'g1', 'mail', { tool: SEARCH, input: { query: 'is:starred' } }).seen).toEqual([])
    expect(setWatch(db, 'g1', 'mail', { command: 'echo 1' })).toMatchObject({ kind: 'command', tool: null, tool_input: {} })
  })

  it('refuses what a watch must not call', () => {
    expect(() => setWatch(db, 'g1', 'x', { tool: 'Bash', input: { command: 'rm -rf .' } })).toThrow(/connector or MCP tool/)
    expect(() => setWatch(db, 'g1', 'x', { tool: 'mcp__quarterdeck__decide_item' })).toThrow(/own tools/)
    expect(() => setWatch(db, 'g1', 'x', { tool: 'mcp__plugin_quarterdeck-goals_quarterdeck__run_goal' })).toThrow(/own tools/)
    expect(() => setWatch(db, 'g1', 'x', { tool: 'mcp__quarterdeck-goals__approve_item' })).toThrow(/own tools/)
    expect(() => setWatch(db, 'g1', 'x', { tool: SEARCH, match: '(' })).toThrow(/regular expression/)
    expect(() => setWatch(db, 'g1', 'x', { tool: SEARCH, command: 'echo 1' } as never)).toThrow(/give one/)
    // What the goal's own rules make a run ask for, a watch can't do unasked
    updateGoal(db, 'g1', { tool_map: { 'mcp__*Gmail*__send_message': 'email.send', 'mcp__*Gmail*__search_threads': 'email.read' }, autonomy: { 'email.read': 'auto' } })
    expect(() => setWatch(db, 'g1', 'x', { tool: 'mcp__claude_ai_Gmail__send_message' })).toThrow(/"email.send", which is propose. A watch may only read/)
    expect(setWatch(db, 'g1', 'x', { tool: SEARCH }).kind).toBe('tool')
  })

  it('the pass hands due ones to a caller that can call tools, once, and the report starts a run', async () => {
    const w = setWatch(db, 'g1', 'mail', { tool: SEARCH, input: { query: 'is:unread' }, every_minutes: 1 })
    // The web app can't call tools: nothing is handed out
    expect(await schedulerPass(db, { holder: 'A' })).not.toHaveProperty('tool_watches')
    const first = await schedulerPass(db, { holder: 'A', toolWatches: true })
    expect(first.tool_watches).toEqual([{ watch_id: w.id, goal_id: 'g1', name: 'mail', tool: SEARCH, input: { query: 'is:unread' } }])
    // Not again while the answer is awaited, but again if it never comes
    expect(await schedulerPass(db, { holder: 'A', toolWatches: true })).not.toHaveProperty('tool_watches')
    expect((await schedulerPass(db, { holder: 'A', toolWatches: true, now: later(WATCH_REPORT_GRACE_MS / 60_000) })).tool_watches).toHaveLength(1)

    expect(reportToolWatch(db, w.id, { text: answer('1a', '2b') })).toEqual({ baseline: true, lines: 2, fresh: [] })
    expect(await schedulerPass(db, { holder: 'A', toolWatches: true })).not.toHaveProperty('tool_watches') // checked a moment ago
    const due = await schedulerPass(db, { holder: 'A', toolWatches: true, now: later(1) })
    expect(due.tool_watches).toHaveLength(1)
    expect(reportToolWatch(db, w.id, { text: answer('3c', '1a', '2b') }, later(1)).fresh).toEqual(['3c'])
    const { claimed } = await schedulerPass(db, { holder: 'A', toolWatches: true, now: later(1) })
    expect(claimed[0]).toMatchObject({ trigger: 'watch' })
    expect(buildBrief(db, 'g1', claimed[0]!.run_id).watch_events).toEqual([{ watch: 'mail', new: ['3c'], omitted: 0 }])
  })

  it('a call that failed is a failed check; a command watch is never reported this way', () => {
    const w = setWatch(db, 'g1', 'mail', { tool: SEARCH })
    reportToolWatch(db, w.id, { text: answer('1a') })
    expect(reportToolWatch(db, w.id, { error: 'Claude Code refused the call: denied by a rule' })).toMatchObject({ fresh: [], error: 'Claude Code refused the call: denied by a rule' })
    expect(getWatch(db, w.id)).toMatchObject({ seen: ['1a'], fail_count: 1, asked_at: null })
    const c = setWatch(db, 'g1', 'cmd', { command: 'echo 1' })
    expect(() => reportToolWatch(db, c.id, { text: 'x' })).toThrow(/not found/)
    expect(applyGoalChanges(db, 'g1', { watches: { mail: { tool: SEARCH, input: { query: 'x' }, every_minutes: 2 } } }))
      .toEqual([`watch "mail" changed: every 2 min, calls ${SEARCH} {"query":"x"}`])
  })
})

describe('the overview and deleting', () => {
  it('lists a goal\'s watches in full detail, and only counts them on a card', () => {
    const w = setWatch(db, 'g1', 'x', { command: 'echo 1', every_minutes: 15 })
    for (let i = 0; i < 3; i++) recordWatchLines(db, w.id, { error: 'gh: not logged in' })
    const [full] = buildOverview(db, 'all').goals
    expect(full).toMatchObject({ watch_count: 1, watch_failing: true })
    expect(full!.watches).toEqual([{ name: 'x', kind: 'command', every_minutes: 15, runs: 'echo 1', last_fired_at: null, failing: true, error: 'gh: not logged in' }])
    const [card] = buildOverview(db, []).goals
    expect(card).toMatchObject({ watch_count: 1, watch_failing: true, watches: [] })
  })

  it('deleting a goal deletes its watches and their events', () => {
    const w = setWatch(db, 'g1', 'x', { command: 'echo 1' })
    recordWatchLines(db, w.id, { lines: [] })
    recordWatchLines(db, w.id, { lines: ['a'] })
    deleteGoal(db, 'g1')
    expect(getWatch(db, w.id)).toBeUndefined()
    expect(db.prepare('SELECT COUNT(*) n FROM goal_watch_events').get()).toEqual({ n: 0 })
  })
})
