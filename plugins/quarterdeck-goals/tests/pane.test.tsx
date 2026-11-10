import { expect, test } from 'claude-code/testing'

import { engine, fakeQuarterdeck, goal, PANE, proposal, START, SURFACES, question } from './fixtures'

test('the pane shows a proposal with hotkeys, and Approve records it in Quarterdeck', async ($, on) => {
  const { statuses } = engine(on)
  const fake = fakeQuarterdeck(on, [
    goal({ id: 'g1', name: 'Inbox', needs_you: [proposal('11', 'Reply to Alice')], health: [{ passed: false, value: 7 }, { passed: false, value: 11 }] }),
  ])
  await $.session.start(START)
  expect(statuses.at(-1)).toBe('Quarterdeck: 1 needs you')

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
  expect(statuses.at(-1)).toBe('Quarterdeck: all clear')
  await ui.unmount()
})

test("each goal shows a line of what its agent is doing, clipped to the pane", async ($, on) => {
  engine(on)
  fakeQuarterdeck(on, [
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

test("Reject opens a feedback box and shows Quarterdeck's error", async ($, on) => {
  engine(on)
  const fake = fakeQuarterdeck(on, [goal({ id: 'g1', name: 'Inbox', needs_you: [proposal('11', 'Reply to Alice')] })], {
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
  const fake = fakeQuarterdeck(on, [
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
  const fake = fakeQuarterdeck(on, goals)
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
  const fake = fakeQuarterdeck(on, [goal({ id: 'g1', name: 'Inbox' })])
  await $.session.start(START)
  await clock.advance(15_000)
  await clock.settle()
  const polls = fake.of('goals_overview')
  expect(polls).toHaveLength(2)
  expect(polls[1]!.input.etag).toBe('"v0"')
})

test('without the quarterdeck MCP server the pane says how to connect it', async ($, on) => {
  const { statuses } = engine(on)
  fakeQuarterdeck(on, [], { fail: true })
  await $.session.start(START)
  expect(statuses.at(-1)).toBe('Quarterdeck: offline')

  for (const surface of SURFACES) {
    const ui = await $.ui.mount({ ...PANE, surface })
    expect(await ui.find({ type: 'Text', text: /isn't connected/ })).toBeDefined()
    expect((await ui.find({ type: 'Text', text: /\/mcp/ }))?.text).toContain('/reload-plugins')
    await ui.unmount()
  }
})

test('after /clear the plugin starts again: the pane still shows the goals and polling goes on', async ($, on) => {
  on('session.end', () => ({ sessionId: 'test-session' }) as never)
  const { clock } = engine(on)
  const fake = fakeQuarterdeck(on, [goal({ id: 'g1', name: 'Inbox' })])
  await $.session.start(START)
  const before = fake.of('goals_overview').length

  await $.session.end({ reason: 'clear' } as never) // no session.start follows a /clear
  await clock.settle()
  expect(fake.of('goals_overview').length).toBeGreaterThan(before)

  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  expect(await ui.find({ type: 'Text', text: /isn't connected/ })).toBeUndefined()
  expect(await ui.find({ key: 'toggle-g1' })).toBeDefined()
  await ui.unmount()

  const read = fake.of('goals_overview').length
  await clock.advance(15_000)
  await clock.settle()
  expect(fake.of('goals_overview').length).toBeGreaterThan(read)
})

test('a pane drawn before the first read says it is reading, not that Quarterdeck is disconnected', async ($, on) => {
  engine(on)
  fakeQuarterdeck(on, [goal({ id: 'g1', name: 'Inbox' })])
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  expect(await ui.find({ type: 'Text', text: /Reading your goals/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /isn't connected/ })).toBeUndefined()
  await ui.unmount()
})

test('a blank pane welcomes a new user and shows /goal-new and /todo', async ($, on) => {
  engine(on)
  fakeQuarterdeck(on, [])
  await $.session.start(START)
  for (const surface of SURFACES) {
    const ui = await $.ui.mount({ ...PANE, surface })
    expect(await ui.find({ type: 'Text', text: /Welcome to Quarterdeck/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /\/goal-new +pick a ready-made goal/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /\/todo/ })).toBeDefined()
    await ui.unmount()
  }
})

test('with to-dos but no goals the pane skips the welcome and says how to create a goal', async ($, on) => {
  engine(on)
  fakeQuarterdeck(on, [], { todos: [{ id: 'p1', name: 'To do', items: [{ id: '1.1', text: 'Something', status: 'pending', depth: 0, notes: null }] }] })
  await $.session.start(START)
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  expect(await ui.find({ type: 'Text', text: /Welcome to Quarterdeck/ })).toBeUndefined()
  expect(await ui.find({ type: 'Text', text: /No goals yet/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /\/goal-new alone offers ready-made ones/ })).toBeDefined()
  await ui.unmount()
})

test('each goal says how long until its next automatic run, or that it has no schedule', async ($, on) => {
  engine(on)
  fakeQuarterdeck(on, [
    goal({ id: 'g1', name: 'Inbox', next_run_at: '2026-11-07T08:25:00Z' }),
    goal({ id: 'g2', name: 'Invoices', next_run_at: null, schedule: null }),
  ])
  await $.session.start(START)
  for (const surface of SURFACES) {
    const ui = await $.ui.mount({ ...PANE, surface })
    expect(await ui.find({ type: 'Text', text: /no runs yet · next in 25m/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /no runs yet · no schedule/ })).toBeDefined()
    expect(await ui.find({ key: 'schedule-g2' })).toBeDefined()
    expect(await ui.find({ key: 'schedule-g1' })).toBeUndefined()
    await ui.unmount()
  }
})

test('Set schedule asks with the suggestion first and sets the choice', async ($, on) => {
  const { asked } = engine(on, { answer: 'Weekly' })
  const fake = fakeQuarterdeck(on, [goal({ id: 'g1', name: 'Status', objective: 'a weekly report', next_run_at: null, schedule: null })])
  await $.session.start(START)
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  await ui.press({ key: 'schedule-g1' })
  expect(asked[0]).toContain('How often should "Status" run? Suggested: daily')
  expect(fake.of('set_schedule').map((c) => c.input)).toEqual([{ goal_id: 'g1', schedule: { kind: 'interval', minutes: 10080 } }])
  expect(await ui.find({ key: 'schedule-g1' })).toBeUndefined()
  await ui.unmount()
})

test('done one-offs sit in a collapsed Done section with Run again', async ($, on) => {
  engine(on)
  const fake = fakeQuarterdeck(on, [
    goal({ id: 'g1', name: 'Inbox' }),
    goal({
      id: 'g2', name: 'Tidy downloads', status: 'retired', one_off: true, next_run_at: null, schedule: null,
      runs: [{ id: 'r9', status: 'completed', trigger: 'manual', summary: 'Deleted 12 installers', started_at: '2026-11-07T07:00:00Z', ended_at: '2026-11-07T07:02:00Z' }],
    }),
  ])
  await $.session.start(START)
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  expect(await ui.find({ key: 'toggle-g2' })).toBeUndefined()
  expect((await ui.find({ key: 'done-toggle' }))?.props.label).toBe('▸ Done (1)')
  expect(await ui.find({ type: 'Text', text: /Deleted 12 installers/ })).toBeUndefined()
  await ui.press({ key: 'done-toggle' })
  expect(await ui.find({ type: 'Text', text: /Deleted 12 installers/ })).toBeDefined()
  await ui.press({ key: 'again-g2' })
  expect(fake.of('run_goal').map((c) => c.input)).toEqual([{ goal_id: 'g2' }])
  expect(await ui.find({ key: 'toggle-g2' })).toBeDefined()
  await ui.unmount()
})

test('a goal\'s controls are separated by dots, and a scheduled goal has Reschedule', async ($, on) => {
  engine(on)
  fakeQuarterdeck(on, [
    goal({ id: 'g1', name: 'Inbox', next_run_at: '2026-11-07T08:25:00Z' }),
    goal({ id: 'g2', name: 'Invoices', next_run_at: null, schedule: null }),
  ])
  await $.session.start(START)
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  expect(await ui.find({ key: 'reschedule-g1' })).toBeDefined()
  expect(await ui.find({ key: 'schedule-g1' })).toBeUndefined()
  expect(await ui.find({ key: 'reschedule-g2' })).toBeUndefined()
  // Each goal: Reschedule (or Set schedule) · Run now · Pause · Delete, with no dot at either end
  expect(await ui.findAll({ type: 'Text', text: /^ · $/ })).toHaveLength(6)
  await ui.unmount()
})

test('Reschedule shows the current schedule; a dismissed question changes nothing', async ($, on) => {
  const { asked } = engine(on) // the fake dismisses (answers Cancel)
  const fake = fakeQuarterdeck(on, [goal({ id: 'g1', name: 'Inbox', next_run_at: '2026-11-07T08:25:00Z' })])
  await $.session.start(START)
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  await ui.press({ key: 'reschedule-g1' })
  expect(asked[0]).toMatch(/^Now: every \S+\. How often should "Inbox" run\?/)
  expect(fake.of('set_schedule')).toEqual([])
  await ui.unmount()
})

test('Reschedule sets the chosen schedule', async ($, on) => {
  engine(on, { answer: 'Weekly' })
  const fake = fakeQuarterdeck(on, [goal({ id: 'g1', name: 'Inbox', next_run_at: '2026-11-07T08:25:00Z' })])
  await $.session.start(START)
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  await ui.press({ key: 'reschedule-g1' })
  expect(fake.of('set_schedule').map((c) => c.input)).toEqual([{ goal_id: 'g1', schedule: { kind: 'interval', minutes: 10080 } }])
  await ui.unmount()
})

test('a category approved every time lately can be switched to auto, after a second press', async ($, on) => {
  engine(on)
  const fake = fakeQuarterdeck(on, [goal({ id: 'g1', name: 'Tidy', suggestions: [{ category: 'file.delete', approved_in_a_row: 10 }] })])
  await $.session.start(START)
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  expect(await ui.find({ type: 'Text', text: /Approved every time lately \(10 in a row\): file\.delete/ })).toBeDefined()

  await ui.press({ key: 'auto-g1-file.delete' })
  expect(await ui.find({ type: 'Text', text: /Runs will do file\.delete actions without asking you first/ })).toBeDefined()
  await ui.press({ key: 'auto-no-g1-file.delete' })
  expect(fake.of('update_goal')).toEqual([])

  await ui.press({ key: 'auto-g1-file.delete' })
  await ui.press({ key: 'auto-yes-g1-file.delete' })
  expect(fake.of('update_goal').map((c) => c.input)).toEqual([{ goal_id: 'g1', autonomy: { 'file.delete': 'auto' } }])
  await ui.unmount()
})

test('a run\'s question waits under Needs you with Answer and Done', async ($, on) => {
  engine(on)
  const fake = fakeQuarterdeck(on, [goal({ id: 'g1', name: 'Jobs', needs_you: [question('1', 'Which job sites should I search?'), question('2', 'Connect Gmail')] })])
  await $.session.start(START)
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  expect(await ui.find({ type: 'Text', text: /\? Which job sites should I search\?/ })).toBeDefined()
  expect(await ui.find({ key: 'approve-g1/1' })).toBeUndefined() // not a proposal
  await ui.press({ key: 'answer-btn-g1/1' })
  await ui.input({ key: 'answer-g1/1', text: 'Seek and LinkedIn' })
  await ui.press({ key: 'done-g1/2' })
  expect(fake.of('decide_item').map((c) => c.input)).toEqual([
    { goal_id: 'g1', item_id: '1', decision: 'answer', feedback: 'Seek and LinkedIn' },
    { goal_id: 'g1', item_id: '2', decision: 'approve' },
  ])
  await ui.unmount()
})

test('Delete asks first, then deletes the goal; not while a run is going', async ($, on) => {
  engine(on)
  const fake = fakeQuarterdeck(on, [goal({ id: 'g1', name: 'Jobs' }), goal({ id: 'g2', name: 'Inbox', open_run: { id: 'r1', status: 'running' } })])
  await $.session.start(START)
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  expect(await ui.find({ key: 'delete-g2' })).toBeUndefined()
  await ui.press({ key: 'delete-g1' })
  expect(await ui.find({ type: 'Text', text: /Delete "Jobs" for good/ })).toBeDefined()
  await ui.press({ key: 'delete-no-g1' })
  expect(fake.of('delete_goal')).toEqual([])
  await ui.press({ key: 'delete-g1' })
  await ui.press({ key: 'delete-yes-g1' })
  expect(fake.of('delete_goal').map((c) => c.input)).toEqual([{ goal_id: 'g1' }])
  await ui.unmount()
})

test('Reschedule takes "30d", and explains an answer it can\'t read', async ($, on) => {
  const { toasts } = engine(on, { answers: ['30d', 'every fortnight-ish'] })
  const fake = fakeQuarterdeck(on, [goal({ id: 'g1', name: 'Inbox', next_run_at: '2026-11-07T08:25:00Z' })])
  await $.session.start(START)
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  await ui.press({ key: 'reschedule-g1' })
  expect(fake.of('set_schedule').map((c) => c.input)).toEqual([{ goal_id: 'g1', schedule: { kind: 'interval', minutes: 43200 } }])
  await ui.press({ key: 'reschedule-g1' })
  expect(toasts.at(-1)).toContain('Couldn\'t read "every fortnight-ish"')
  expect(fake.of('set_schedule')).toHaveLength(1)
  await ui.unmount()
})

test('Reschedule hands an answer it can\'t read to the small model, and says how it read it', async ($, on) => {
  const { toasts } = engine(on, { answers: ['every other week'], suggestion: 'every 2w' })
  const fake = fakeQuarterdeck(on, [goal({ id: 'g1', name: 'Inbox', next_run_at: '2026-11-07T08:25:00Z' })])
  await $.session.start(START)
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  await ui.press({ key: 'reschedule-g1' })
  expect(fake.of('set_schedule').map((c) => c.input)).toEqual([{ goal_id: 'g1', schedule: { kind: 'interval', minutes: 20160 } }])
  expect(toasts.at(-1)).toBe('Inbox now runs every 14d (read "every other week" as every 2w).')
  await ui.unmount()
})

test("with the server from this plugin (mcp__plugin_quarterdeck-goals_quarterdeck__*) the pane works the same", async ($, on) => {
  const { statuses } = engine(on)
  fakeQuarterdeck(on, [goal({ id: 'g1', name: 'Inbox' })], { prefix: 'mcp__plugin_quarterdeck-goals_quarterdeck__' })
  await $.session.start(START)
  expect(statuses.at(-1)).toBe('Quarterdeck: all clear')
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  expect(await ui.find({ type: 'Text', text: /Waiting for its first run/ })).toBeDefined()
  await ui.unmount()
})

test('when a newer Quarterdeck has upgraded the database, the pane asks for /reload-plugins', async ($, on) => {
  engine(on)
  fakeQuarterdeck(on, [goal({ id: 'g1', name: 'Inbox' })], { outdated: true })
  await $.session.start(START)
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  expect((await ui.find({ type: 'Text', text: /updated in another session/ }))?.text).toContain('/reload-plugins')
  await ui.unmount()
})

test('offline, the pane dates the goals it still shows, not the last failed read', async ($, on) => {
  const { clock } = engine(on)
  const opts = { fail: false }
  fakeQuarterdeck(on, [goal({ id: 'g1', name: 'Inbox' })], opts)
  await $.session.start(START)

  opts.fail = true
  await clock.advance(10 * 60_000)
  await clock.settle()

  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  expect((await ui.find({ type: 'Text', text: /^Offline/ }))?.text).toContain('10m ago')
  expect(await ui.find({ key: 'toggle-g1' })).toBeDefined()
  await ui.unmount()
})
