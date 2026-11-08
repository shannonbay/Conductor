import { expect, test } from 'claude-code/testing'

import { BAND, engine, fakeConductor, goal, proposal, START, SURFACES } from './fixtures'

/** A command typed at the prompt. */
const typed = (command: string, args: string) =>
  ({ command, args, origin: { kind: 'composer' }, presentation: { isFullscreen: false, columns: 100 } }) as const

const inbox = () => goal({ id: 'g1', name: 'Inbox', needs_you: [proposal('11', 'Reply to Alice')] })

test('goals_status summarises every goal for Claude, with item ids', async ($, on) => {
  engine(on)
  fakeConductor(on, [inbox(), goal({ id: 'g2', name: 'Invoices' })])
  await $.session.start(START)
  const res = await $.tool.call({ tool: 'mcp__conductor-goals__goals_status' })
  const text = String(res.result)
  expect(text).toContain('## Inbox (id g1, active)')
  expect(text).toContain('- item 11: Reply to Alice [email.send]')
  expect(text).toContain('## Invoices')
  expect(text).toContain('Now: Waiting for its first run')
})

test('approve_item asks first and does nothing when declined', async ($, on) => {
  const { asked } = engine(on, { answer: 'Cancel' })
  const fake = fakeConductor(on, [inbox()])
  await $.session.start(START)
  const res = await $.tool.call({ tool: 'mcp__conductor-goals__approve_item', goal: 'inbox', item_id: '11' })
  expect(asked).toEqual(['Approve "Reply to Alice" (Send: Reply to Alice) for the goal "Inbox"?'])
  expect(String(res.result)).toContain('declined')
  expect(fake.of('decide_item')).toEqual([])
})

test('approve_item approves once the person confirms', async ($, on) => {
  engine(on, { answer: 'Approve' })
  const fake = fakeConductor(on, [inbox()])
  await $.session.start(START)
  const res = await $.tool.call({ tool: 'mcp__conductor-goals__approve_item', goal: 'Inbox', item_id: '11' })
  expect(String(res.result)).toContain('Approved "Reply to Alice"')
  expect(fake.of('decide_item').map((c) => c.input)).toEqual([{ goal_id: 'g1', item_id: '11', decision: 'approve' }])
})

test('an unknown item or ambiguous goal name is explained', async ($, on) => {
  engine(on, { answer: 'Approve' })
  fakeConductor(on, [inbox(), goal({ id: 'g2', name: 'Inbox archive' })])
  await $.session.start(START)
  const ambiguous = await $.tool.call({ tool: 'mcp__conductor-goals__approve_item', goal: 'inb', item_id: '11' })
  expect(String(ambiguous.result)).toContain('matches Inbox, Inbox archive')
  const missing = await $.tool.call({ tool: 'mcp__conductor-goals__approve_item', goal: 'Inbox', item_id: '99' })
  expect(String(missing.result)).toContain('Waiting: 11 (Reply to Alice)')
})

test('/goal-new creates a goal in the session directory; /goal-pause pauses it', async ($, on) => {
  engine(on)
  const goals: ReturnType<typeof goal>[] = []
  const fake = fakeConductor(on, goals)
  await $.session.start(START)

  const usage = await $.command.run(typed('goal-new', 'Inbox'))
  expect(usage.text).toContain('Usage')

  const made = await $.command.run(typed('goal-new', 'Inbox: keep my inbox under 20 unread'))
  expect(made.text).toContain('Created the goal "Inbox"')
  expect(fake.of('create_goal')[0]?.input).toEqual({
    name: 'Inbox', objective: 'keep my inbox under 20 unread', working_dir: '/work/project',
  })

  const paused = await $.command.run(typed('goal-pause', 'inbox'))
  expect(paused.text).toBe('Inbox is paused.')
  expect(goals[0]!.status).toBe('paused')
})

test('the band shows a goal run this session is doing, until end_run', async ($, on) => {
  engine(on)
  fakeConductor(on, [inbox()])
  on('tool.call', { tool: 'mcp__conductor__get_goal_brief' }, () => ({ result: 'brief' }))
  on('tool.call', { tool: 'mcp__conductor__end_run' }, () => ({ result: 'ended' }))
  on('ui.render', { component: 'AbovePrompt' }, ($, e) => {
    const { Box } = $.ui.resolve(e)
    return <Box /> // the engine's own band: empty
  })
  await $.session.start(START)

  for (const surface of SURFACES) {
    const ui = await $.ui.mount({ ...BAND, surface })
    expect(await ui.find({ type: 'Text', text: /Running goal/ })).toBeUndefined()
    await ui.unmount()
  }

  await $.tool.call({ tool: 'mcp__conductor__get_goal_brief', goal_id: 'g1', run_id: 'run-7' })
  for (const surface of SURFACES) {
    const ui = await $.ui.mount({ ...BAND, surface })
    expect((await ui.find({ type: 'Text', text: /Running goal/ }))?.text).toContain('Running goal Inbox')
    await ui.unmount()
  }

  await $.tool.call({ tool: 'mcp__conductor__end_run', run_id: 'run-7', summary: 'done' })
  const ui = await $.ui.mount({ ...BAND, surface: 'terminal' })
  expect(await ui.find({ type: 'Text', text: /Running goal/ })).toBeUndefined()
  await ui.unmount()
})

test('/goal-schedule sets a schedule without asking, and explains a bad one', async ($, on) => {
  const { asked } = engine(on)
  const fake = fakeConductor(on, [inbox()])
  await $.session.start(START)
  const usage = await $.command.run(typed('goal-schedule', 'inbox'))
  expect(usage.text).toContain('Usage: /goal-schedule')
  const bad = await $.command.run(typed('goal-schedule', 'inbox every 2m'))
  expect(bad.text).toContain('5 minutes')
  const set = await $.command.run(typed('goal-schedule', 'inbox every 6h'))
  expect(set.text).toBe('Inbox runs every 6h; the next run starts within a minute.')
  expect(fake.of('set_schedule').map((c) => c.input)).toEqual([{ goal_id: 'g1', schedule: { kind: 'interval', minutes: 360 } }])
  const off = await $.command.run(typed('goal-schedule', 'inbox off'))
  expect(off.text).toContain('only on demand')
  expect(asked).toEqual([])
})

test('the set_schedule tool asks first', async ($, on) => {
  const { asked } = engine(on, { answer: 'Cancel' })
  const fake = fakeConductor(on, [inbox()])
  await $.session.start(START)
  const res = await $.tool.call({ tool: 'mcp__conductor-goals__set_schedule', goal: 'Inbox', schedule: 'cron 0 9 * * 1-5' } as never)
  expect(asked).toEqual(['Run the goal "Inbox" cron 0 9 * * 1-5?'])
  expect(String(res.result)).toContain('declined')
  expect(fake.of('set_schedule')).toEqual([])
})
