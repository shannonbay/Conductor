import { expect, test } from 'claude-code/testing'

import { BAND, engine, fakeConductor, goal, PANE, START } from './fixtures'

let settle: () => Promise<void> = async () => {}

const queued = () => goal({ id: 'g1', name: 'Inbox', open_run: { id: 'r1', status: 'queued' } })

test('a queued run starts in a background subagent of the runner type, and the band says so', async ($, on) => {
  const { spawned, clock } = engine(on)
  settle = () => clock.settle()
  const fake = fakeConductor(on, [queued()])
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

test('"Run now" starts the run at once instead of at the next tick', async ($, on) => {
  const { spawned, clock } = engine(on)
  settle = () => clock.settle()
  fakeConductor(on, [goal({ id: 'g1', name: 'Inbox' })])
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
  const fake = fakeConductor(on, [queued()])
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
  const fake = fakeConductor(on, [queued()])
  await $.session.start(START)
  await settle()
  expect(fake.of('goals_tick').length).toBeGreaterThan(0)
  await clock.advance(15 * 60_000 + 30_000)
  await clock.settle()
  expect(stopped).toEqual(['agent-1'])
  expect(fake.ended).toEqual({ r1: 'timed_out' })
})

test('without the guard plugin no run is claimed or started, and the pane says why', async ($, on) => {
  const { spawned, clock } = engine(on, { guarded: false })
  settle = () => clock.settle()
  const fake = fakeConductor(on, [queued()])
  await $.session.start(START)
  await settle()
  expect(fake.of('goals_tick')).toEqual([])
  expect(spawned).toEqual([])
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  expect((await ui.find({ type: 'Text', text: /conductor-goals-guard/ }))?.text).toContain('Goal runs are paused')
  await ui.unmount()
})

test('the paused warning goes once the guard plugin loads, and the queued run starts', async ($, on) => {
  const { spawned, clock, setGuarded } = engine(on, { guarded: false })
  settle = () => clock.settle()
  fakeConductor(on, [queued()])
  await $.session.start(START)
  await settle()
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  expect(await ui.find({ type: 'Text', text: /Goal runs are paused/ })).toBeDefined()

  setGuarded(true)
  await clock.advance(30_000)
  await clock.settle()
  expect(await ui.find({ type: 'Text', text: /Goal runs are paused/ })).toBeUndefined()
  expect(spawned.map((x) => x.prompt)).toEqual(['Run Inbox'])
  await ui.unmount()
})
