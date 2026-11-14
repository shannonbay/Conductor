import { expect, test } from 'claude-code/testing'

import { BAND, engine, fakeQuarterdeck, goal, PANE, START } from './fixtures'

let settle: () => Promise<void> = async () => {}

const queued = () => goal({ id: 'g1', name: 'Inbox', open_run: { id: 'r1', status: 'queued' } })

test('a queued run starts in a background subagent of the runner type, and the band says so', async ($, on) => {
  const { spawned, clock } = engine(on)
  settle = () => clock.settle()
  const fake = fakeQuarterdeck(on, [queued()])
  await $.session.start(START)
  await settle()

  expect(fake.of('goals_tick')[0]?.input).toMatchObject({ holder: 'session-1', tracked_run_ids: [], max_concurrent: 2 })
  // (the test kit doesn't pass subagentType through to the fake; a session does)
  expect(spawned).toMatchObject([{ prompt: 'Run Inbox', cwd: '/work/project' }])
  expect(fake.of('attach_agent').map((c) => c.input)).toEqual([{ run_id: 'r1', agent_id: 'agent-1' }])

  const band = await $.ui.mount({ ...BAND, surface: 'terminal' })
  expect((await band.find({ type: 'Text', text: /Goal run: Inbox/ }))?.text).toContain('Inbox')
  await band.unmount()
})

test("a goal's model goes to its run's agent; without one the agent takes the session's", async ($, on) => {
  const { spawned, clock } = engine(on)
  fakeQuarterdeck(on, [
    goal({ id: 'g1', name: 'Inbox', model: 'haiku', open_run: { id: 'r1', status: 'queued' } }),
    goal({ id: 'g2', name: 'Feeds', open_run: { id: 'r2', status: 'queued' } }),
  ])
  await $.session.start(START)
  await clock.settle()
  expect(spawned.find((s) => s.prompt === 'Run Inbox')?.model).toBe('haiku')
  expect(spawned.find((s) => s.prompt === 'Run Feeds')).not.toHaveProperty('model')
})

test('"Run now" starts the run at once instead of at the next tick', async ($, on) => {
  const { spawned, clock } = engine(on)
  settle = () => clock.settle()
  fakeQuarterdeck(on, [goal({ id: 'g1', name: 'Inbox' })])
  await $.session.start(START)
  await settle()
  expect(spawned).toEqual([])
  const res = await $.command.run({ command: 'goal-run', args: 'inbox', origin: { kind: 'person' } } as never)
  expect(res.text).toContain('Queued a run of Inbox')
  expect(spawned.map((s) => s.prompt)).toEqual(['Run Inbox'])
})

test('a run whose agent ends without end_run is marked failed at the next tick', async ($, on) => {
  const { clock, finish } = engine(on)
  settle = () => clock.settle()
  const fake = fakeQuarterdeck(on, [queued()])
  await $.session.start(START)
  await settle()
  finish('agent-1')
  await clock.advance(30_000)
  await clock.settle()
  expect(fake.of('fail_run').map((c) => c.input)).toEqual([{ run_id: 'r1', status: 'failed', reason: 'The agent ended without calling end_run' }])
  // and it is no longer tracked: the next tick passes no run ids
  expect(fake.of('goals_tick').at(-1)?.input.tracked_run_ids).toEqual([])
})

test('a run past its time limit is stopped and marked timed out', async ($, on) => {
  const { clock, stopped } = engine(on)
  settle = () => clock.settle()
  const fake = fakeQuarterdeck(on, [queued()])
  await $.session.start(START)
  await settle()
  expect(fake.of('goals_tick').length).toBeGreaterThan(0)
  await clock.advance(15 * 60_000 + 30_000)
  await clock.settle()
  expect(stopped).toEqual(['agent-1'])
  expect(fake.ended).toEqual({ r1: 'timed_out' })
})

test('a due tool watch is called from the tick with nobody asked, and something new starts a run at once', async ($, on) => {
  const { spawned, clock } = engine(on)
  settle = () => clock.settle()
  const SEARCH = 'mcp__claude_ai_Gmail__search_threads'
  const searched: Record<string, unknown>[] = []
  on('tool.call', { tool: SEARCH as never }, (_, e) => {
    const { tool: _t, tool_use_id: _u, agentId: _a, ...input } = e as unknown as Record<string, unknown>
    searched.push(input)
    return { result: '{"threads":[{"id":"1a"}]}' } as never
  })
  const fake = fakeQuarterdeck(on, [goal({ id: 'g1', name: 'Mail' })], {
    toolWatches: [{ watch_id: 'w-g1', goal_id: 'g1', name: 'new mail', tool: SEARCH, input: { query: 'is:unread', view: 'THREAD_VIEW_IDS_ONLY' } }],
  })
  await $.session.start(START)
  await settle()

  expect(fake.of('goals_tick')[0]?.input).toMatchObject({ tool_watches: true })
  expect(searched).toEqual([{ query: 'is:unread', view: 'THREAD_VIEW_IDS_ONLY' }])
  expect(fake.of('watch_report').map((c) => c.input)).toEqual([{ watch_id: 'w-g1', text: '{"threads":[{"id":"1a"}]}' }])
  // The run it queued is claimed by a second pass straight away (which asks for no more watches)
  expect(fake.of('goals_tick')[1]?.input).not.toHaveProperty('tool_watches')
  expect(spawned).toMatchObject([{ prompt: 'Run Mail' }])
})

test('a tool watch whose call is refused or fails is reported as a failed check', async ($, on) => {
  const { spawned, clock } = engine(on)
  settle = () => clock.settle()
  on('tool.call', { tool: 'mcp__mail__search' as never }, () => ({ deny: 'denied by a permission rule' }) as never)
  on('tool.call', { tool: 'mcp__files__list' as never }, () => ({ result: 'Not signed in', isError: true }) as never)
  const fake = fakeQuarterdeck(on, [goal({ id: 'g1', name: 'Mail' })], {
    toolWatches: [
      { watch_id: 'w-1', goal_id: 'g1', name: 'mail', tool: 'mcp__mail__search', input: {} },
      { watch_id: 'w-2', goal_id: 'g1', name: 'files', tool: 'mcp__files__list', input: {} },
    ],
  })
  await $.session.start(START)
  await settle()
  expect(fake.of('watch_report').map((c) => c.input)).toEqual([
    { watch_id: 'w-1', error: 'Claude Code refused the call: denied by a permission rule' },
    { watch_id: 'w-2', error: 'Not signed in' },
  ])
  expect(fake.of('goals_tick')).toHaveLength(1)
  expect(spawned).toEqual([])
})

test('without the guard plugin no run is claimed or started, and the pane says why', async ($, on) => {
  const { spawned, clock } = engine(on, { guarded: false })
  settle = () => clock.settle()
  const fake = fakeQuarterdeck(on, [queued()])
  await $.session.start(START)
  await settle()
  expect(fake.of('goals_tick')).toEqual([])
  expect(spawned).toEqual([])
  await clock.advance(12_000)
  await clock.settle()
  expect(fake.of('goals_tick')).toEqual([])
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  expect((await ui.find({ type: 'Text', text: /quarterdeck-guard/ }))?.text).toContain('Goal runs are paused')
  await ui.unmount()
})

test('a guard plugin that loads a moment late starts the run without any warning', async ($, on) => {
  const { spawned, clock, setGuarded } = engine(on, { guarded: false })
  settle = () => clock.settle()
  fakeQuarterdeck(on, [queued()])
  await $.session.start(START)
  await settle()
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  expect(await ui.find({ type: 'Text', text: /Goal runs are paused/ })).toBeUndefined()
  expect(spawned).toEqual([])

  setGuarded(true)
  await clock.advance(2_000)
  await clock.settle()
  expect(await ui.find({ type: 'Text', text: /Goal runs are paused/ })).toBeUndefined()
  expect(spawned.map((x) => x.prompt)).toEqual(['Run Inbox'])
  await ui.unmount()
})

test('the paused warning goes once the guard plugin loads, and the queued run starts', async ($, on) => {
  const { spawned, clock, setGuarded } = engine(on, { guarded: false })
  settle = () => clock.settle()
  fakeQuarterdeck(on, [queued()])
  await $.session.start(START)
  await settle()
  await clock.advance(12_000)
  await clock.settle()
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  expect(await ui.find({ type: 'Text', text: /Goal runs are paused/ })).toBeDefined()

  setGuarded(true)
  await clock.advance(30_000)
  await clock.settle()
  expect(await ui.find({ type: 'Text', text: /Goal runs are paused/ })).toBeUndefined()
  expect(spawned.map((x) => x.prompt)).toEqual(['Run Inbox'])
  await ui.unmount()
})

const PLAN_MODE_REFUSAL = "wasn't run: this call needs a person's approval, and a mod's own call can't ask for it."

test('a run whose agent ends while plan mode refuses fail_run is finished at the next pass, not left open', async ($, on) => {
  const { clock, finish } = engine(on)
  settle = () => clock.settle()
  const errors: Record<string, string> = {}
  const fake = fakeQuarterdeck(on, [queued()], { errors })
  await $.session.start(START)
  await settle()
  errors.fail_run = `fail_run ${PLAN_MODE_REFUSAL}`
  finish('agent-1')
  await clock.advance(30_000)
  await clock.settle()
  expect(fake.ended).toEqual({})
  // still tracked, so the next pass tries again
  expect(fake.of('goals_tick').at(-1)?.input.tracked_run_ids).toEqual(['r1'])
  delete errors.fail_run
  await clock.advance(30_000)
  await clock.settle()
  expect(fake.ended).toEqual({ r1: 'failed' })
  expect(fake.of('goals_tick').at(-1)?.input.tracked_run_ids).toEqual([])
})

test('while plan mode refuses the tick the pane says so instead of "Offline", and it clears when plan mode ends', async ($, on) => {
  const { clock } = engine(on)
  settle = () => clock.settle()
  const errors: Record<string, string> = {}
  fakeQuarterdeck(on, [goal({ id: 'g1', name: 'Inbox' })], { errors })
  await $.session.start(START)
  await settle()
  errors.goals_tick = `goals_tick ${PLAN_MODE_REFUSAL}`
  errors.goals_overview = `goals_overview ${PLAN_MODE_REFUSAL}`
  await clock.advance(30_000)
  await clock.settle()
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  expect((await ui.find({ type: 'Text', text: /^Plan mode is on/ }))?.text).toContain('standing session')
  expect(await ui.find({ type: 'Text', text: /^Offline/ })).toBeFalsy()
  await ui.unmount()
  delete errors.goals_tick
  delete errors.goals_overview
  await clock.advance(60_000)
  await clock.settle()
  const after = await $.ui.mount({ ...PANE, surface: 'terminal' })
  expect(await after.find({ type: 'Text', text: /^Plan mode is on/ })).toBeFalsy()
  await after.unmount()
})
