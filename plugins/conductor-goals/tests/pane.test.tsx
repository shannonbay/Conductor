import { expect, test } from 'claude-code/testing'

import { engine, fakeConductor, goal, PANE, proposal, START, SURFACES } from './fixtures'

test('the pane shows a proposal with hotkeys, and Approve posts to the web app', async ($, on) => {
  const { statuses } = engine(on)
  const { requests } = fakeConductor(on, [
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
  expect(requests.some((r) => r.method === 'POST' && r.path === '/api/plans/g1/tasks/11/approve')).toBe(true)
  expect(await ui.find({ key: 'approve-g1/11' })).toBeUndefined()
  expect(statuses.at(-1)).toBe('Conductor: all clear')
  await ui.unmount()
})

test('Reject opens a feedback box and shows the web app error', async ($, on) => {
  engine(on)
  const { requests } = fakeConductor(on, [goal({ id: 'g1', name: 'Inbox', needs_you: [proposal('11', 'Reply to Alice')] })], {
    errors: { 'POST /api/plans/g1/tasks/11/reject': [400, 'Feedback is required when rejecting.'] },
  })
  await $.session.start(START)

  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  await ui.press({ key: 'reject-g1/11' })
  await ui.input({ key: 'feedback-g1/11', text: 'too formal' })
  expect(requests.find((r) => r.path.endsWith('/reject'))?.body).toBe(JSON.stringify({ feedback: 'too formal' }))
  expect((await ui.find({ type: 'Text', text: /Couldn't reject/ }))?.text).toContain('Feedback is required')
  await ui.unmount()
})

test('expanding a goal shows open items, runs and memory; memory delete asks first', async ($, on) => {
  engine(on)
  const { requests } = fakeConductor(on, [
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
  expect(requests.some((r) => r.method === 'DELETE')).toBe(false)
  await ui.press({ key: 'forget-yes-m1' })
  expect(requests.some((r) => r.method === 'DELETE' && r.path === '/api/goals/g1/memory/m1')).toBe(true)
  expect(await ui.find({ type: 'Text', text: /Alice likes short replies/ })).toBeUndefined()
  await ui.unmount()
})

test('pause and resume, and cancel a run only after confirming', async ($, on) => {
  engine(on)
  const goals = [goal({ id: 'g1', name: 'Inbox', open_run: { id: 'r1', status: 'running' } })]
  const { requests } = fakeConductor(on, goals)
  await $.session.start(START)

  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  expect(await ui.find({ key: 'run-g1' })).toBeUndefined()
  await ui.press({ key: 'cancel-run-g1' })
  expect(requests.some((r) => r.method === 'DELETE')).toBe(false)
  await ui.press({ key: 'cancel-run-no-g1' })
  await ui.press({ key: 'cancel-run-g1' })
  await ui.press({ key: 'cancel-run-yes-g1' })
  expect(requests.some((r) => r.method === 'DELETE' && r.path === '/api/goals/g1/run')).toBe(true)
  expect((await ui.find({ key: 'run-g1' }))?.props.hotkey).toBe('n')

  await ui.press({ key: 'pause-g1' })
  expect(requests.find((r) => r.method === 'PATCH')?.body).toBe(JSON.stringify({ status: 'paused' }))
  expect(await ui.find({ key: 'run-g1' })).toBeUndefined()
  await ui.press({ key: 'resume-g1' })
  expect(goals[0]!.status).toBe('active')
  await ui.unmount()
})

test('an unchanged overview is asked for with its ETag and answers 304', async ($, on) => {
  const { clock } = engine(on)
  const { requests } = fakeConductor(on, [goal({ id: 'g1', name: 'Inbox' })])
  await $.session.start(START)
  await clock.advance(15_000)
  await clock.settle()
  const polls = requests.filter((r) => r.path === '/api/goals/overview')
  expect(polls).toHaveLength(2)
  expect(polls[1]!.headers?.['If-None-Match']).toBe('"v0"')
})

test('without the web app the pane says how to reach it', async ($, on) => {
  const { statuses } = engine(on)
  fakeConductor(on, [], { fail: true })
  await $.session.start(START)
  expect(statuses.at(-1)).toBe('Conductor: offline')

  for (const surface of SURFACES) {
    const ui = await $.ui.mount({ ...PANE, surface })
    expect((await ui.find({ type: 'Text', text: /isn't reachable/ }))?.text).toContain('http://localhost:3000')
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
