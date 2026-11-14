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
    await ui.press({ key: 'toggle-g2' }) // quiet, so its activity line shows once expanded
    const idle = await ui.find({ type: 'Text', text: /^Last run: filed/ })
    expect(idle?.text.startsWith('Last run: filed invoices')).toBe(true)
    expect(idle?.text.endsWith('…')).toBe(true)
    expect([...idle!.text].length).toBeLessThanOrEqual(PANE.props.bodyColumns)
    await ui.press({ key: 'toggle-g2' }) // collapse again for the next surface
    await ui.unmount()
  }
})

test("expanding a quiet goal adds no blank line above its title", async ($, on) => {
  engine(on)
  fakeQuarterdeck(on, [goal({ id: 'g1', name: 'Inbox' }), goal({ id: 'g2', name: 'Invoices' })])
  await $.session.start(START)

  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  expect((await ui.find({ key: 'g1' }))?.props.marginBottom).toBe(0)
  await ui.press({ key: 'toggle-g2' })
  expect((await ui.find({ key: 'toggle-g2' }))?.props.label).toBe('▾ Invoices')
  expect((await ui.find({ key: 'g1' }))?.props.marginBottom).toBe(0)
  await ui.unmount()
})

test('a run waiting for a permission answer says so, on which call, and where to answer', async ($, on) => {
  engine(on)
  fakeQuarterdeck(on, [
    goal({
      id: 'g1',
      name: 'Tidy',
      open_run: { id: 'r1', status: 'running' },
      activity: { state: 'running', text: 'Waiting for your permission: Bash: rm old.zip', at: '2026-11-07T07:58:00Z', waiting: { tool: 'Bash: rm old.zip', since: '2026-11-07T07:58:00Z' } },
    }),
  ])
  await $.session.start(START)
  for (const surface of SURFACES) {
    const ui = await $.ui.mount({ ...PANE, surface })
    expect((await ui.find({ type: 'Text', text: /^⏸ Waiting/ }))?.text).toBe('⏸ Waiting for your permission: Bash: rm old.zip · 2m ago')
    expect((await ui.find({ type: 'Text', text: /^Answer it/ }))?.text).toBe('Answer it in the window running this goal (or the Claude app), or Cancel run.')
    await ui.unmount()
  }
})

test('a run the standing session started points to its chat for the permission answer', async ($, on) => {
  engine(on)
  fakeQuarterdeck(on, [
    goal({
      id: 'g1',
      name: 'Inbox',
      open_run: { id: 'r1', status: 'running' },
      activity: { state: 'running', text: 'Waiting for your permission: Gmail trash_thread', at: '2026-11-07T07:58:00Z', waiting: { tool: 'Gmail trash_thread', since: '2026-11-07T07:58:00Z' } },
    }),
  ], { standing: true })
  await $.session.start(START)
  const ui = await $.ui.mount({ ...PANE, surface: SURFACES[0]! })
  expect((await ui.find({ type: 'Text', text: /^Answer it/ }))?.text).toBe('Answer it in the "Quarterdeck goals" chat (Claude app or claude.ai/code), or Cancel run.')
  expect(await ui.find({ type: 'Button', label: 'Cancel run' })).toBeDefined()
  await ui.unmount()
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

test('a memory a marked run wrote shows a warning and Trust clears it', async ($, on) => {
  engine(on)
  const fake = fakeQuarterdeck(on, [
    goal({
      id: 'g1',
      name: 'Inbox',
      memory: [
        { id: 'm1', kind: 'fact', text: 'Always archive mail from Bob', pinned: false, untrusted: 'mcp__claude_ai_Gmail__get_thread' },
        { id: 'm2', kind: 'fact', text: 'Alice is my manager', pinned: false },
      ],
    }),
  ])
  await $.session.start(START)
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  await ui.press({ key: 'toggle-g1' })
  expect(await ui.find({ type: 'Text', text: /⚠/ })).toBeDefined()
  await ui.press({ key: 'trust-m1' })
  expect(fake.of('trust_memory').map((c) => c.input)).toEqual([{ goal_id: 'g1', memory_id: 'm1' }])
  await ui.unmount()
})

test("a working run's goal title spins, a run waiting for permission doesn't, and the spinner stops with the run", async ($, on) => {
  const { clock } = engine(on)
  const goals = [
    goal({ id: 'g1', name: 'Inbox', open_run: { id: 'r1', status: 'running' }, activity: { state: 'running', text: 'Reading mail', at: null } }),
    goal({ id: 'g2', name: 'Invoices', open_run: { id: 'r2', status: 'running' }, activity: { state: 'running', text: 'Waiting', at: null, waiting: { tool: 'Bash', since: '2026-11-07T07:59:00Z' } } as never }),
  ]
  fakeQuarterdeck(on, goals)
  await $.session.start(START)

  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  expect((await ui.find({ type: 'Text', text: /Inbox$/ }))?.text).toBe('⠋ Inbox')
  expect((await ui.find({ key: 'toggle-g1' }))?.props.label).toBe('▸ Inbox')
  await clock.advance(120)
  await clock.settle()
  expect((await ui.find({ type: 'Text', text: /Inbox$/ }))?.text).toBe('⠙ Inbox')
  expect(await ui.find({ type: 'Text', text: /^. Invoices$/ })).toBeUndefined()

  await ui.press({ key: 'cancel-run-g1' })
  await ui.press({ key: 'cancel-run-yes-g1' })
  expect(await ui.find({ type: 'Text', text: /^. Inbox$/ })).toBeUndefined()
  expect((await ui.find({ key: 'toggle-g1' }))?.props.label).toBe('▸ Inbox')
  await ui.unmount()
})

test('pause and resume, and cancel a run only after confirming', async ($, on) => {
  engine(on)
  const goals = [goal({ id: 'g1', name: 'Inbox', open_run: { id: 'r1', status: 'running' } })]
  const fake = fakeQuarterdeck(on, goals)
  await $.session.start(START)

  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  await ui.press({ key: 'toggle-g1' }) // expanded, so it keeps its controls once the run is gone
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
    await ui.press({ key: 'toggle-g1' })
    await ui.press({ key: 'toggle-g2' })
    expect(await ui.find({ key: 'schedule-g2' })).toBeDefined()
    expect(await ui.find({ key: 'schedule-g1' })).toBeUndefined()
    await ui.press({ key: 'toggle-g1' }) // collapse again for the next surface
    await ui.press({ key: 'toggle-g2' })
    await ui.unmount()
  }
})

test('a goal with a watch and no schedule says it runs on its watch, not that it has no schedule', async ($, on) => {
  engine(on)
  const watch = { name: 'failed CI on main', every_minutes: 5, runs: 'gh run list', last_fired_at: null, failing: false, error: null }
  fakeQuarterdeck(on, [
    goal({ id: 'g1', name: 'Inbox', next_run_at: '2026-11-07T08:25:00Z' }),
    goal({ id: 'g2', name: 'CI', next_run_at: null, schedule: null, watches: [watch] }),
    goal({ id: 'g3', name: 'Invoices', next_run_at: null, schedule: null }),
  ])
  await $.session.start(START)
  for (const surface of SURFACES) {
    const ui = await $.ui.mount({ ...PANE, surface })
    expect(await ui.find({ type: 'Text', text: /no runs yet · next in 25m/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /no runs yet · on watch/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /no runs yet · no schedule/ })).toBeDefined()
    for (const id of ['g1', 'g2', 'g3']) await ui.press({ key: `toggle-${id}` })
    expect(await ui.find({ type: 'Text', text: /^Runs every 1h$/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /^Runs when a watch sees something new: failed CI on main$/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /^Runs on demand \(set one with \/goal-schedule\)$/ })).toBeDefined()
    expect((await ui.findAll({ type: 'Text', text: /goal-schedule/ })).length).toBe(1)
    for (const id of ['g1', 'g2', 'g3']) await ui.press({ key: `toggle-${id}` }) // collapse again for the next surface
    await ui.unmount()
  }
})

test('Set schedule asks with the suggestion first and sets the choice', async ($, on) => {
  const { asked } = engine(on, { answer: 'Weekly' })
  const fake = fakeQuarterdeck(on, [goal({ id: 'g1', name: 'Status', objective: 'a weekly report', next_run_at: null, schedule: null })])
  await $.session.start(START)
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  await ui.press({ key: 'toggle-g1' }) // a quiet goal is one line: its controls show once expanded
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
  await ui.press({ key: 'toggle-g1' })
  await ui.press({ key: 'toggle-g2' })
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
  await ui.press({ key: 'toggle-g1' }) // a quiet goal is one line: its controls show once expanded
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
  await ui.press({ key: 'toggle-g1' }) // a quiet goal is one line: its controls show once expanded
  await ui.press({ key: 'reschedule-g1' })
  expect(fake.of('set_schedule').map((c) => c.input)).toEqual([{ goal_id: 'g1', schedule: { kind: 'interval', minutes: 10080 } }])
  await ui.unmount()
})

test("an expanded goal shows its model; Change… sets the one picked", async ($, on) => {
  const { asked, toasts } = engine(on, { answer: 'Haiku' })
  const fake = fakeQuarterdeck(on, [goal({ id: 'g1', name: 'Inbox' })])
  await $.session.start(START)
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  await ui.press({ key: 'toggle-g1' })
  expect(await ui.find({ type: 'Text', text: "Model: the session's model · " })).toBeDefined()
  await ui.press({ key: 'model-change-g1' })
  expect(asked[0]).toMatch(/^Which model should "Inbox" run on\? Now: the session's model\./)
  expect(fake.of('update_goal').map((c) => c.input)).toEqual([{ goal_id: 'g1', model: 'haiku' }])
  expect(toasts.join(' ')).toContain('Inbox now runs on Haiku.')
  expect(await ui.find({ type: 'Text', text: 'Model: Haiku · ' })).toBeDefined()
  await ui.unmount()
})

test('a dismissed model question changes nothing', async ($, on) => {
  engine(on) // the fake dismisses (answers Cancel)
  const fake = fakeQuarterdeck(on, [goal({ id: 'g1', name: 'Inbox', model: 'sonnet' })])
  await $.session.start(START)
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  await ui.press({ key: 'toggle-g1' })
  await ui.press({ key: 'model-change-g1' })
  expect(fake.of('update_goal')).toEqual([])
  await ui.unmount()
})

test('the model line says when the last run used another model than the goal is set to', async ($, on) => {
  engine(on)
  const ran = (model: string) => [{ id: 'r1', status: 'completed', trigger: 'manual', summary: 'ok', started_at: '2026-11-07T07:00:00Z', ended_at: '2026-11-07T07:02:00Z', model }]
  fakeQuarterdeck(on, [
    goal({ id: 'g1', name: 'Inbox', model: 'sonnet', runs: ran('claude-opus-5-5') }),
    goal({ id: 'g2', name: 'Feeds', model: 'sonnet', runs: ran('claude-sonnet-5-5') }),
  ])
  await $.session.start(START)
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  await ui.press({ key: 'toggle-g1' })
  await ui.press({ key: 'toggle-g2' })
  expect(await ui.findAll({ type: 'Text', text: ' (last run used Opus 5.5)' })).toHaveLength(1)
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
  const fake = fakeQuarterdeck(on, [goal({ id: 'g1', name: 'Jobs', needs_you: [question('1', 'Which job sites should I search?', 'Seek has most roles; LinkedIn has recruiters. I\'d search both.'), question('2', 'Connect Gmail')] })])
  await $.session.start(START)
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  expect(await ui.find({ type: 'Text', text: /\? Which job sites should I search\?/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /Seek has most roles; LinkedIn has recruiters/ })).toBeDefined() // the run's context, not just the title
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
  await ui.press({ key: 'toggle-g1' }) // a quiet goal is one line: its controls show once expanded
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
  await ui.press({ key: 'toggle-g1' }) // a quiet goal is one line: its controls show once expanded
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
  await ui.press({ key: 'toggle-g1' }) // a quiet goal is one line: its controls show once expanded
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
  expect(await ui.find({ type: 'Text', text: /no runs yet/ })).toBeDefined()
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

test('when a newer Quarterdeck is published, the pane says so and asks Claude to install it', async ($, on) => {
  const { prompts, box, toasts } = engine(on)
  fakeQuarterdeck(on, [goal({ id: 'g1', name: 'Inbox' })], { update: { installed: '0.15.0', latest: '0.16.0' } })
  await $.session.start(START)

  for (const surface of SURFACES) {
    const ui = await $.ui.mount({ ...PANE, surface })
    expect((await ui.find({ type: 'Text', text: /is available/ }))?.text).toBe('Quarterdeck 0.16.0 is available (you have 0.15.0). ')
    await ui.unmount()
  }

  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  await ui.press({ key: 'update-install' })
  expect(prompts).toHaveLength(1)
  expect(prompts[0]).toContain('Quarterdeck 0.16.0 is available (I have 0.15.0)')
  expect(prompts[0]).toContain('claude plugin marketplace update quarterdeck')
  expect(prompts[0]).toContain('claude plugin update quarterdeck-goals@quarterdeck')
  expect(prompts[0]).toContain('claude plugin update quarterdeck-guard@quarterdeck')
  expect(prompts[0]).toContain('/reload-plugins')

  // With a prompt half typed, it is added to the draft instead of sent
  box.draft = 'while you are at it'
  await ui.press({ key: 'update-install' })
  expect(prompts).toHaveLength(1)
  expect(box.draft).toContain('install Quarterdeck 0.16.0')
  expect(toasts.at(-1)).toContain('Added to your prompt')
  await ui.unmount()
})

test('with no update published, the pane offers none', async ($, on) => {
  engine(on)
  fakeQuarterdeck(on, [goal({ id: 'g1', name: 'Inbox' })])
  await $.session.start(START)
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  expect(await ui.find({ key: 'update-install' })).toBeUndefined()
  await ui.unmount()
})

test('while the standing session starts goal runs, the pane says so', async ($, on) => {
  engine(on)
  fakeQuarterdeck(on, [goal({ id: 'g1', name: 'Inbox' })], { standing: true })
  await $.session.start(START)
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  expect((await ui.find({ type: 'Text', text: /standing session/ }))?.text).toContain('with this window closed')
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

test('a goal with nothing for you is one line; one that needs you keeps its card', async ($, on) => {
  engine(on)
  const ran = (status: string, tokens?: number) => [{ id: `r-${status}`, status, trigger: 'schedule', summary: 'Checked', started_at: '2026-11-07T07:00:00Z', ended_at: '2026-11-07T07:02:00Z', tokens }]
  fakeQuarterdeck(on, [
    goal({ id: 'g1', name: 'Inbox', next_run_at: '2026-11-07T08:25:00Z', runs: ran('completed', 48_200), activity: { state: 'idle', text: 'Last run: Checked', at: null } }),
    goal({ id: 'g2', name: 'Invoices', next_run_at: '2026-11-07T08:25:00Z', runs: ran('failed') }),
    goal({ id: 'g3', name: 'Reports', status: 'paused', next_run_at: null }),
    goal({ id: 'g4', name: 'Disk', health: [{ passed: false, value: 7 }] }),
    // A run from before tokens were recorded says when it ran instead
    goal({ id: 'g5', name: 'Backups', next_run_at: '2026-11-07T08:25:00Z', runs: ran('completed') }),
  ])
  await $.session.start(START)

  for (const surface of SURFACES) {
    const ui = await $.ui.mount({ ...PANE, surface })
    // Quiet: the name, what its last run used and when it runs next, and nothing else
    expect((await ui.find({ key: 'toggle-g1' }))?.props.label).toBe('▸ Inbox')
    expect((await ui.find({ key: 'toggle-g1' }))?.props.hotkey).toBe('1')
    expect(await ui.find({ type: 'Text', text: /^ · 48k tokens · next in 25m$/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /^ · ran 58m ago · next in 25m$/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /^Last run: Checked/ })).toBeUndefined()
    expect(await ui.find({ key: 'pause-g1' })).toBeUndefined()
    expect(await ui.find({ type: 'Text', text: /^ · paused · no runs yet$/ })).toBeDefined()
    expect(await ui.find({ key: 'resume-g3' })).toBeUndefined()
    // A failed run or a failing health check keeps the card, in the same place in the list
    expect((await ui.find({ key: 'toggle-g2' }))?.props.hotkey).toBe('2')
    expect(await ui.find({ key: 'discuss-g2' })).toBeDefined()
    expect((await ui.find({ key: 'run-g2' }))?.props.hotkey).toBe('n')
    expect(await ui.find({ key: 'pause-g4' })).toBeDefined()

    // Expanded, a quiet goal is the full card
    await ui.press({ key: 'toggle-g1' })
    expect(await ui.find({ type: 'Text', text: /^Last run: Checked/ })).toBeDefined()
    expect((await ui.find({ key: 'run-g1' }))?.props.hotkey).toBe('n')
    expect(await ui.find({ key: 'pause-g1' })).toBeDefined()
    await ui.press({ key: 'toggle-g1' }) // collapse again for the next surface
    await ui.unmount()
  }
})

test("Add… beside an allow rule opens /permissions, or says what to type when there's none", async ($, on) => {
  const { toasts } = engine(on)
  const ran: string[] = []
  let has = true
  on('command.list', () => ({ value: has ? [{ name: 'permissions', description: 'Manage allow & deny tool permission rules', source: 'builtin' }] : [] }) as never)
  on('command.run', { command: 'permissions' }, () => {
    ran.push('permissions')
    return { text: '' } as never
  })
  fakeQuarterdeck(on, [goal({ id: 'g1', name: 'Inbox', autonomy: { shell: 'auto' }, tool_map: { Bash: 'shell' } })])
  await $.session.start(START)
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  await ui.press({ key: 'toggle-g1' })
  await ui.press({ key: 'allow-toggle-g1' })
  await ui.press({ key: 'allow-add-g1/Bash' })
  expect(ran).toEqual(['permissions'])
  expect(toasts.at(-1)).toContain('Bash')

  has = false
  await ui.press({ key: 'allow-add-g1/Bash' })
  expect(ran).toEqual(['permissions'])
  expect(toasts.at(-1)).toBe('Type /permissions and add this allow rule: Bash')
  await ui.unmount()
})

test("an expanded goal lists its Claude Code allow rules when opened, and Claude is asked to add them", async ($, on) => {
  const { prompts } = engine(on)
  fakeQuarterdeck(on, [
    goal({ id: 'g1', name: 'Inbox', autonomy: { shell: 'auto', 'email.delete': 'propose' }, tool_map: { Bash: 'shell', 'mcp__claude_ai_Gmail__trash_thread': 'email.delete' } }),
    goal({ id: 'g2', name: 'Quiet' }),
  ])
  await $.session.start(START)
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  await ui.press({ key: 'toggle-g1' })
  await ui.press({ key: 'toggle-g2' })
  // One line until opened, and none for a goal with no auto tool rules
  expect((await ui.find({ key: 'allow-toggle-g1' }))?.props.label).toBe('▸ Claude Code allow rules (1)')
  expect(await ui.find({ key: 'allow-toggle-g2' })).toBeUndefined()
  expect(await ui.find({ key: 'allow-ask-g1' })).toBeUndefined()

  await ui.press({ key: 'allow-toggle-g1' })
  expect((await ui.find({ key: 'allow-toggle-g1' }))?.props.label).toBe('▾ Claude Code allow rules (1)')
  expect((await ui.find({ type: 'Text', text: /^\s*Bash$/ }))?.text).toContain('Bash')
  // A propose category's tool waits for an approval anyway: no rule for it
  expect(await ui.find({ type: 'Text', text: /trash_thread/ })).toBeUndefined()
  await ui.press({ key: 'allow-ask-g1' })
  expect(prompts.at(-1)).toContain('- `Bash`')
  expect(prompts.at(-1)).toContain('wait for my yes')
  await ui.unmount()
})

test('a clipped question or proposal opens to its full text, fetched once with get_item', async ($, on) => {
  engine(on)
  const long = `Which approach should I build? ${'more detail '.repeat(30)}`
  const fake = fakeQuarterdeck(on, [
    goal({
      id: 'g1',
      name: 'Inbox',
      needs_you: [
        { ...question('7', 'Which approach…', 'Options: a…'), clipped: true },
        { ...proposal('11', 'Reply to Alice'), clipped: true },
        proposal('12', 'Short one'),
      ],
    }),
  ], { full: { '7': question('7', long, 'Options: a) all of it, b) part of it'), '11': { ...proposal('11', 'Reply to Alice about Thursday at 2pm'), notes: 'She asked twice' } } })
  await $.session.start(START)

  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  expect((await ui.find({ key: 'read-g1/7' }))?.props.label).toBe('▸ ? Which approach…')
  expect(await ui.find({ key: 'read-g1/12' })).toBeUndefined() // not clipped: no marker
  await ui.press({ key: 'read-g1/7' })
  expect(fake.of('get_item').map((c) => c.input)).toEqual([{ goal_id: 'g1', item_id: '7' }])
  expect((await ui.find({ key: 'read-g1/7' }))?.props.label).toBe(`▾ ? ${long}`)
  expect((await ui.find({ type: 'Text', text: /all of it/ }))?.text).toContain('b) part of it')

  await ui.press({ key: 'read-g1/7' }) // closes again, back to the clipped text
  expect((await ui.find({ key: 'read-g1/7' }))?.props.label).toBe('▸ ? Which approach…')
  await ui.press({ key: 'read-g1/7' }) // reopens without fetching again
  expect(fake.of('get_item')).toHaveLength(1)

  await ui.press({ key: 'read-notes-g1/7' }) // the notes line closes it too
  expect((await ui.find({ key: 'read-g1/7' }))?.props.label).toBe('▸ ? Which approach…')

  await ui.press({ key: 'read-summary-g1/11' }) // pressing the summary line opens a proposal
  expect((await ui.find({ key: 'read-g1/11' }))?.props.label).toBe('▾ ● Reply to Alice about Thursday at 2pm')
  expect((await ui.find({ type: 'Text', text: /She asked twice/ }))?.text).toContain('She asked twice')
  await ui.unmount()
})
