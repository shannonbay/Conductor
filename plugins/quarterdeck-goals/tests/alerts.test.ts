import { expect, test } from 'claude-code/testing'

import { engine, fakeQuarterdeck, goal, proposal, START } from './fixtures'

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

test('by default the plugin sends no push itself', async ($, on) => {
  const { pushes, notifications, clock } = engine(on)
  const goals = [goal({ id: 'g1', name: 'Inbox' })]
  const fake = fakeQuarterdeck(on, goals)
  await $.session.start(START)
  goals[0]!.needs_you.push(proposal('1', 'A'))
  fake.bump()
  await poll(clock)
  expect(notifications).toHaveLength(1)
  expect(pushes).toEqual([])
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
