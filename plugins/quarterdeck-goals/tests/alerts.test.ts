import { expect, test } from 'claude-code/testing'

import { engine, fakeQuarterdeck, goal, PANE, proposal, START } from './fixtures'

const poll = async (clock: { advance: (ms: number) => Promise<void>; settle: () => Promise<void> }) => {
  await clock.advance(15_000)
  await clock.settle()
}

test('a new proposal raises a toast and a notification; ones waiting at load do not', async ($, on) => {
  const { toasts, notifications, clock } = engine(on)
  const goals = [goal({ id: 'g1', name: 'Inbox', needs_you: [proposal('11', 'Old one')] })]
  const fake = fakeQuarterdeck(on, goals)
  await $.session.start(START)
  expect(toasts).toHaveLength(0)

  goals[0]!.needs_you.push(proposal('12', 'Archive the newsletter'))
  fake.bump()
  await poll(clock)
  expect(toasts).toEqual(['Quarterdeck · Inbox: "Archive the newsletter" needs you'])
  expect(notifications).toEqual(['Inbox: "Archive the newsletter" needs you'])
})

test('with phone_push on, a new proposal is pushed to the phone by the plugin', { options: { phone_push: true } }, async ($, on) => {
  const { pushes, clock } = engine(on)
  const goals = [goal({ id: 'g1', name: 'Inbox' })]
  const fake = fakeQuarterdeck(on, goals)
  await $.session.start(START)
  goals[0]!.needs_you.push(proposal('12', 'Archive the newsletter'))
  fake.bump()
  await poll(clock)
  expect(pushes).toEqual(['Quarterdeck: Inbox asks: "Archive the newsletter". Reply "approve" or "reject, because ..." in Claude.'])
})

test('by default the plugin tries its own push only to learn whether the person is there, then relays', async ($, on) => {
  const { pushes, prompts, notifications, clock } = engine(on)
  const goals = [goal({ id: 'g1', name: 'Inbox' })]
  const fake = fakeQuarterdeck(on, goals)
  await $.session.start(START)
  goals[0]!.needs_you.push(proposal('1', 'A'))
  fake.bump()
  await poll(clock)
  expect(notifications).toHaveLength(1)
  expect(pushes).toHaveLength(1)
  expect(prompts.filter((p) => p.includes('PushNotification'))).toHaveLength(1)
})

test('at the terminal without typing, an alert is not relayed and goals_status says why', async ($, on) => {
  const { prompts, toasts, clock } = engine(on, { present: true })
  const goals = [goal({ id: 'g1', name: 'Inbox' })]
  const fake = fakeQuarterdeck(on, goals)
  await $.session.start(START)
  goals[0]!.needs_you.push(proposal('12', 'Archive the newsletter'))
  fake.bump()
  await poll(clock)
  expect(toasts).toHaveLength(1)
  expect(prompts.filter((p) => p.includes('PushNotification'))).toHaveLength(0)
  const r = await $.tool.call({ tool: 'mcp__quarterdeck-goals__goals_status' } as never)
  expect(String(r.result)).toContain("Phone: not relayed (you're at the terminal).")
})

test('with phone_relay off, the plugin sends no push at all', { options: { phone_relay: false } }, async ($, on) => {
  const { pushes, prompts, clock } = engine(on)
  const goals = [goal({ id: 'g1', name: 'Inbox' })]
  const fake = fakeQuarterdeck(on, goals)
  await $.session.start(START)
  goals[0]!.needs_you.push(proposal('1', 'A'))
  fake.bump()
  await poll(clock)
  expect(pushes).toEqual([])
  expect(prompts.filter((p) => p.includes('PushNotification'))).toHaveLength(0)
})

test('several new proposals fold into one alert, and notifications are rate limited per goal', async ($, on) => {
  const { toasts, notifications, clock } = engine(on)
  const goals = [goal({ id: 'g1', name: 'Inbox' })]
  const fake = fakeQuarterdeck(on, goals)
  await $.session.start(START)

  goals[0]!.needs_you.push(proposal('1', 'A'), proposal('2', 'B'))
  fake.bump()
  await poll(clock)
  expect(toasts).toEqual(['Quarterdeck · 2 new proposals need you'])
  expect(notifications).toHaveLength(1)

  goals[0]!.needs_you.push(proposal('3', 'C'))
  fake.bump()
  await poll(clock) // 15 s later: toast, but no second notification within the minute
  expect(toasts).toHaveLength(2)
  expect(notifications).toHaveLength(1)
})

test('a failed run raises an alert', async ($, on) => {
  const { toasts, clock } = engine(on)
  const goals = [goal({ id: 'g1', name: 'Inbox' })]
  const fake = fakeQuarterdeck(on, goals)
  await $.session.start(START)

  goals[0]!.runs.unshift({ id: 'r9', status: 'failed', trigger: 'schedule', summary: 'Gmail was unreachable', started_at: '2026-11-07T08:00:00Z', ended_at: '2026-11-07T08:00:10Z' })
  fake.bump()
  await poll(clock)
  expect(toasts).toEqual(['Quarterdeck · Inbox: run failed — Gmail was unreachable'])
})

test('alerts: failures leaves proposals quiet', { options: { alerts: 'failures' } }, async ($, on) => {
  const { toasts, notifications, clock } = engine(on)
  const goals = [goal({ id: 'g1', name: 'Inbox' })]
  const fake = fakeQuarterdeck(on, goals)
  await $.session.start(START)

  goals[0]!.needs_you.push(proposal('1', 'A'))
  fake.bump()
  await poll(clock)
  expect(toasts).toHaveLength(0)
  expect(notifications).toHaveLength(0)
})

test('os_notifications off keeps the toast only', { options: { os_notifications: false } }, async ($, on) => {
  const { toasts, notifications, clock } = engine(on)
  const goals = [goal({ id: 'g1', name: 'Inbox' })]
  const fake = fakeQuarterdeck(on, goals)
  await $.session.start(START)

  goals[0]!.needs_you.push(proposal('1', 'A'))
  fake.bump()
  await poll(clock)
  expect(toasts).toHaveLength(1)
  expect(notifications).toHaveLength(0)
})

test('goals_status reports the last alert and what became of its push', async ($, on) => {
  const { clock } = engine(on)
  const goals = [goal({ id: 'g1', name: 'Inbox' })]
  const fake = fakeQuarterdeck(on, goals)
  await $.session.start(START)
  goals[0]!.needs_you.push(proposal('12', 'Archive the newsletter'))
  fake.bump()
  await poll(clock)
  const r = await $.tool.call({ tool: 'mcp__quarterdeck-goals__goals_status' } as never)
  expect(String(r.result)).toContain('Last alert')
  expect(String(r.result)).toContain('Phone: relayed to Claude to push.')
})

test('while the person is away, an alert is relayed to Claude to push; not while they are typing', async ($, on) => {
  const { prompts, clock } = engine(on)
  const goals = [goal({ id: 'g1', name: 'Inbox' })]
  const fake = fakeQuarterdeck(on, goals)
  await $.session.start(START)
  goals[0]!.needs_you.push(proposal('12', 'Archive the newsletter'))
  fake.bump()
  await poll(clock)
  expect(prompts).toHaveLength(1)
  expect(prompts[0]).toContain('PushNotification')
  expect(prompts[0]).toContain('Quarterdeck: Inbox asks: "Archive the newsletter"')

  await $.prompt.submit({ text: 'what changed?', origin: { kind: 'composer' } } as never) // the person is back, typing at the terminal
  await clock.advance(61_000)
  goals[0]!.needs_you.push(proposal('13', 'Archive another'))
  fake.bump()
  await poll(clock)
  expect(prompts.filter((p) => p.includes('PushNotification'))).toHaveLength(1)
})

test('pressing something in the Goals pane counts as being there, so an alert is not relayed', async ($, on) => {
  const { prompts, clock } = engine(on)
  const goals = [goal({ id: 'g1', name: 'Inbox' })]
  const fake = fakeQuarterdeck(on, goals)
  await $.session.start(START)
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  await ui.press({ key: 'toggle-g1' }) // the person expands a goal, typing nothing
  await clock.advance(61_000)
  goals[0]!.needs_you.push(proposal('12', 'Archive the newsletter'))
  fake.bump()
  await poll(clock)
  expect(prompts.filter((p) => p.includes('PushNotification'))).toHaveLength(0)
  const r = await $.tool.call({ tool: 'mcp__quarterdeck-goals__goals_status' } as never)
  expect(String(r.result)).toContain('Phone: not relayed (you were active in the last 5 minutes).')

  await clock.advance(5 * 60_000) // away from the pane long enough
  goals[0]!.needs_you.push(proposal('13', 'Archive another'))
  fake.bump()
  await poll(clock)
  expect(prompts.filter((p) => p.includes('PushNotification'))).toHaveLength(1)
  await ui.unmount()
})

test('a proposal that arrives while the plugin restarts still raises its alert', async ($, on) => {
  on('session.end', () => ({ sessionId: 'test-session' }) as never)
  const { toasts, clock } = engine(on)
  const goals = [goal({ id: 'g1', name: 'Inbox', needs_you: [proposal('11', 'Old one')] })]
  const fake = fakeQuarterdeck(on, goals)
  await $.session.start(START)
  await poll(clock)
  await $.session.end({ reason: 'other' } as never)
  goals[0]!.needs_you.push(proposal('12', 'Arrived during the restart'))
  fake.bump()
  await $.session.start(START)
  expect(toasts).toEqual(['Quarterdeck · Inbox: "Arrived during the restart" needs you'])
})

test('without Remote Control an alert is not relayed; the pane says so and Connect runs /remote-control', async ($, on) => {
  const { prompts, clock } = engine(on, { phone: 'no_transport' })
  const ran: string[] = []
  on('command.list', () => ({ value: [{ name: 'remote-control', description: 'Connect this session', source: 'builtin' }] }) as never)
  on('command.run', { command: 'remote-control' }, (_, e) => {
    ran.push(e.command)
    return { text: 'connected' } as never
  })
  const goals = [goal({ id: 'g1', name: 'Inbox' })]
  const fake = fakeQuarterdeck(on, goals)
  await $.session.start(START)
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  expect(await ui.find({ key: 'phone-connect' })).toBeUndefined()

  goals[0]!.needs_you.push(proposal('12', 'Archive the newsletter'))
  fake.bump()
  await poll(clock)
  expect(prompts.filter((p) => p.includes('PushNotification'))).toHaveLength(0)
  const r = await $.tool.call({ tool: 'mcp__quarterdeck-goals__goals_status' } as never)
  expect(String(r.result)).toContain("Phone: not relayed (Remote Control isn't connected: run /remote-control).")
  expect((await ui.find({ type: 'Text', text: /reach your phone/ }))?.text).toContain("Remote Control isn't connected")

  await ui.press({ key: 'phone-connect' })
  expect(ran).toEqual(['remote-control'])
  expect(await ui.find({ key: 'phone-connect' })).toBeUndefined()
  await ui.unmount()
})

test('with mobile push off an alert is not relayed and the pane points at /config', async ($, on) => {
  const { prompts, clock } = engine(on, { phone: 'config_off' })
  const goals = [goal({ id: 'g1', name: 'Inbox' })]
  const fake = fakeQuarterdeck(on, goals)
  await $.session.start(START)
  goals[0]!.needs_you.push(proposal('12', 'Archive the newsletter'))
  fake.bump()
  await poll(clock)
  expect(prompts.filter((p) => p.includes('PushNotification'))).toHaveLength(0)
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  expect((await ui.find({ type: 'Text', text: /reach your phone/ }))?.text).toContain('mobile push is off')
  await ui.unmount()
})

test('a new goal says how to get phone alerts, until a message from the phone shows Remote Control is connected', async ($, on) => {
  engine(on)
  fakeQuarterdeck(on, [])
  await $.session.start(START)
  const typed = (args: string) => ({ command: 'goal-new', args, origin: { kind: 'composer' } }) as never
  const first = await $.command.run(typed('Inbox: keep my inbox under 20 unread'))
  expect(first.text).toContain('connect Remote Control in this session (/remote-control)')

  await $.prompt.submit({ text: 'what needs me?', origin: { kind: 'bridge' } } as never)
  const second = await $.command.run(typed('Bills: pay my bills on time'))
  expect(second.text).toContain('Created the goal "Bills"')
  expect(second.text).not.toContain('Remote Control')
})
