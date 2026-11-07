import { expect, test } from 'claude-code/testing'

import { engine, fakeConductor, goal, proposal, START } from './fixtures'

const poll = async (clock: { advance: (ms: number) => Promise<void>; settle: () => Promise<void> }) => {
  await clock.advance(15_000)
  await clock.settle()
}

test('a new proposal raises a toast and a notification; ones waiting at load do not', async ($, on) => {
  const { toasts, notifications, clock } = engine(on)
  const goals = [goal({ id: 'g1', name: 'Inbox', needs_you: [proposal('11', 'Old one')] })]
  const fake = fakeConductor(on, goals)
  await $.session.start(START)
  expect(toasts).toHaveLength(0)

  goals[0]!.needs_you.push(proposal('12', 'Archive the newsletter'))
  fake.bump()
  await poll(clock)
  expect(toasts).toEqual(['Conductor · Inbox: "Archive the newsletter" needs you'])
  expect(notifications).toEqual(['Inbox: "Archive the newsletter" needs you'])
})

test('several new proposals fold into one alert, and notifications are rate limited per goal', async ($, on) => {
  const { toasts, notifications, clock } = engine(on)
  const goals = [goal({ id: 'g1', name: 'Inbox' })]
  const fake = fakeConductor(on, goals)
  await $.session.start(START)

  goals[0]!.needs_you.push(proposal('1', 'A'), proposal('2', 'B'))
  fake.bump()
  await poll(clock)
  expect(toasts).toEqual(['Conductor · 2 new proposals need you'])
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
  const fake = fakeConductor(on, goals)
  await $.session.start(START)

  goals[0]!.runs.unshift({ id: 'r9', status: 'failed', trigger: 'schedule', summary: 'Gmail was unreachable', started_at: '2026-11-07T08:00:00Z', ended_at: '2026-11-07T08:00:10Z' })
  fake.bump()
  await poll(clock)
  expect(toasts).toEqual(['Conductor · Inbox: run failed — Gmail was unreachable'])
})

test('alerts: failures leaves proposals quiet', { options: { alerts: 'failures' } }, async ($, on) => {
  const { toasts, notifications, clock } = engine(on)
  const goals = [goal({ id: 'g1', name: 'Inbox' })]
  const fake = fakeConductor(on, goals)
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
  const fake = fakeConductor(on, goals)
  await $.session.start(START)

  goals[0]!.needs_you.push(proposal('1', 'A'))
  fake.bump()
  await poll(clock)
  expect(toasts).toHaveLength(1)
  expect(notifications).toHaveLength(0)
})
