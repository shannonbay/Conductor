import { expect, test } from 'claude-code/testing'

import { engine, fakeConductor, goal, PANE, proposal, START, SURFACES } from './fixtures'

test('the pane shows a proposal with hotkeys, and Approve records it in Conductor', async ($, on) => {
  const { statuses } = engine(on)
  const fake = fakeConductor(on, [
    goal({ id: 'g1', name: 'Inbox', needs_you: [proposal('11', 'Reply to Alice')], health: [{ passed: false, value: 7 }, { passed: false, value: 11 }] }),
  ])
  await $.session.start(START)
  expect(statuses.at(-1)).toBe('Conductor: 1 needs you')

  for (const surface of SURFACES) {
    const ui = await $.ui.mount({ ...PANE, surface })
    expect((await ui.find({ type: 'Text', text: /Reply to Alice/ }))?.text).toContain('Reply to Alice')
    expect((await ui.find({ type: 'Text', text: /failing/ }))?.text).toContain('7')
    expect((await ui.find({ key: 'approve-g1/11' }))?.props.hotkey).toBe('a')
    expect((await ui.find({ key: 'reject-g1/11' }))?.props.hotkey).toBe('r')
    expect((await ui.find({ key: 'toggle-g1' }))?.props.hotkey).toBe('1')
    await ui.unmount()
  }

  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  await ui.press({ key: 'approve-g1/11' })
  expect(fake.of('decide_item').map((c) => c.input)).toEqual([{ goal_id: 'g1', item_id: '11', decision: 'approve' }])
  expect(await ui.find({ key: 'approve-g1/11' })).toBeUndefined()
  expect(statuses.at(-1)).toBe('Conductor: all clear')
  await ui.unmount()
})

test("each goal shows a line of what its agent is doing, clipped to the pane", async ($, on) => {
  engine(on)
  fakeConductor(on, [
    goal({
      id: 'g1',
      name: 'Inbox',
      open_run: { id: 'r1', status: 'running' },
      activity: { state: 'running', text: 'Drafting a reply to Alice', at: '2026-11-07T07:57:00Z' },
    }),
    goal({ id: 'g2', name: 'Invoices', activity: { state: 'idle', text: `Last run: ${'filed invoices '.repeat(10)}`, at: null } }),
  ])
  await $.session.start(START)

  for (const surface of SURFACES) {
    const ui = await $.ui.mount({ ...PANE, surface })
    const running = await ui.find({ type: 'Text', text: /^● Drafting/ })
    expect(running?.text).toBe('● Drafting a reply to Alice · 3m ago')
    const idle = await ui.find({ type: 'Text', text: /^Last run: filed/ })
    expect(idle?.text.startsWith('Last run: filed invoices')).toBe(true)
    expect(idle?.text.endsWith('…')).toBe(true)
    expect([...idle!.text].length).toBeLessThanOrEqual(PANE.props.bodyColumns)
    await ui.unmount()
  }
})

test("Reject opens a feedback box and shows Conductor's error", async ($, on) => {
  engine(on)
  const fake = fakeConductor(on, [goal({ id: 'g1', name: 'Inbox', needs_you: [proposal('11', 'Reply to Alice')] })], {
    errors: { decide_item: 'Feedback is required when rejecting.' },
  })
  await $.session.start(START)

  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  await ui.press({ key: 'reject-g1/11' })
  await ui.input({ key: 'feedback-g1/11', text: 'too formal' })
  expect(fake.of('decide_item')[0]?.input).toEqual({ goal_id: 'g1', item_id: '11', decision: 'reject', feedback: 'too formal' })
  expect((await ui.find({ type: 'Text', text: /Couldn't reject/ }))?.text).toContain('Feedback is required')
  await ui.unmount()
})

test('expanding a goal shows open items, runs and memory; memory delete asks first', async ($, on) => {
  engine(on)
  const fake = fakeConductor(on, [
    goal({
      id: 'g1',
      name: 'Inbox',
      open_items: [{ id: '5', goal: 'Invoice from Acme' }],
      runs: [{ id: 'r1', status: 'completed', trigger: 'schedule', summary: 'Triaged 4 emails', started_at: '2026-11-07T07:00:00Z', ended_at: '2026-11-07T07:02:00Z' }],
      memory: [{ id: 'm1', kind: 'preference', text: 'Alice likes short replies', pinned: false }],
    }),
  ])
  await $.session.start(START)

  for (const surface of SURFACES) {
    const ui = await $.ui.mount({ ...PANE, surface })
    expect(await ui.find({ type: 'Text', text: /Invoice from Acme/ })).toBeUndefined()
    await ui.press({ key: 'toggle-g1' })
    expect(await ui.find({ type: 'Text', text: /Invoice from Acme/ })).toBeDefined()
    expect((await ui.find({ type: 'Text', text: /Triaged 4 emails/ }))?.text).toContain('schedule')
    expect(await ui.find({ type: 'Text', text: /Alice likes short replies/ })).toBeDefined()
    expect((await ui.find({ type: 'Link', text: /Open in browser/ }))?.props.href).toBe('http://localhost:3000/goals/g1')
    await ui.press({ key: 'toggle-g1' }) // collapse again for the next surface
    await ui.unmount()
  }

  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  await ui.press({ key: 'toggle-g1' })
  await ui.press({ key: 'forget-m1' })
  expect(fake.of('delete_memory')).toEqual([])
  await ui.press({ key: 'forget-yes-m1' })
  expect(fake.of('delete_memory').map((c) => c.input)).toEqual([{ goal_id: 'g1', memory_id: 'm1' }])
  expect(await ui.find({ type: 'Text', text: /Alice likes short replies/ })).toBeUndefined()
  await ui.unmount()
})

test('pause and resume, and cancel a run only after confirming', async ($, on) => {
  engine(on)
  const goals = [goal({ id: 'g1', name: 'Inbox', open_run: { id: 'r1', status: 'running' } })]
  const fake = fakeConductor(on, goals)
  await $.session.start(START)

  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  expect(await ui.find({ key: 'run-g1' })).toBeUndefined()
  await ui.press({ key: 'cancel-run-g1' })
  expect(fake.of('cancel_run')).toEqual([])
  await ui.press({ key: 'cancel-run-no-g1' })
  await ui.press({ key: 'cancel-run-g1' })
  await ui.press({ key: 'cancel-run-yes-g1' })
  expect(fake.of('cancel_run').map((c) => c.input)).toEqual([{ goal_id: 'g1' }])
  expect((await ui.find({ key: 'run-g1' }))?.props.hotkey).toBe('n')

  await ui.press({ key: 'pause-g1' })
  expect(fake.of('set_goal_status')[0]?.input).toEqual({ goal_id: 'g1', status: 'paused' })
  expect(await ui.find({ key: 'run-g1' })).toBeUndefined()
  await ui.press({ key: 'resume-g1' })
  expect(goals[0]!.status).toBe('active')
  await ui.unmount()
})

test('an unchanged overview is asked for with its etag and answers changed: false', async ($, on) => {
  const { clock } = engine(on)
  const fake = fakeConductor(on, [goal({ id: 'g1', name: 'Inbox' })])
  await $.session.start(START)
  await clock.advance(15_000)
  await clock.settle()
  const polls = fake.of('goals_overview')
  expect(polls).toHaveLength(2)
  expect(polls[1]!.input.etag).toBe('"v0"')
})

test('without the conductor MCP server the pane says how to connect it', async ($, on) => {
  const { statuses } = engine(on)
  fakeConductor(on, [], { fail: true })
  await $.session.start(START)
  expect(statuses.at(-1)).toBe('Conductor: offline')

  for (const surface of SURFACES) {
    const ui = await $.ui.mount({ ...PANE, surface })
    expect(await ui.find({ type: 'Text', text: /isn't connected/ })).toBeDefined()
    expect((await ui.find({ type: 'Text', text: /\/mcp/ }))?.text).toContain('.mcp.json')
    await ui.unmount()
  }
})

test('with no goals the pane says how to create one', async ($, on) => {
  engine(on)
  fakeConductor(on, [])
  await $.session.start(START)
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  expect(await ui.find({ type: 'Text', text: /\/goal-new/ })).toBeDefined()
  await ui.unmount()
})

test('each goal says how long until its next automatic run, or that it has no schedule', async ($, on) => {
  engine(on)
  fakeConductor(on, [
    goal({ id: 'g1', name: 'Inbox', next_run_at: '2026-11-07T08:25:00Z' }),
    goal({ id: 'g2', name: 'Invoices', next_run_at: null, schedule: null }),
  ])
  await $.session.start(START)
  for (const surface of SURFACES) {
    const ui = await $.ui.mount({ ...PANE, surface })
    expect(await ui.find({ type: 'Text', text: /no runs yet · next in 25m/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /no runs yet · no schedule \(\/goal-schedule\)/ })).toBeDefined()
    await ui.unmount()
  }
})
