import { expect, test } from 'claude-code/testing'

import { ago, clip, diffAlerts, EMPTY, findGoal, nextRunText, parseSchedule, scheduleLabel, spark, statusText, toCard } from '../hooks/model'
import { goal, NOW, proposal } from './fixtures'

const card = (over: Parameters<typeof goal>[0]) => toCard({ ...goal(over), open_item_count: over.open_items?.length ?? 0 })

test('findGoal matches by id, exact name, prefix, then substring', async () => {
  const goals = [card({ id: 'g1', name: 'Inbox' }), card({ id: 'g2', name: 'Inbox archive' }), card({ id: 'g3', name: 'Weekly invoices' })]
  expect(findGoal(goals, 'g3')).toEqual({ goal: goals[2] })
  expect(findGoal(goals, 'INBOX')).toEqual({ goal: goals[0] })
  expect(findGoal(goals, 'inbox a')).toEqual({ goal: goals[1] })
  expect(findGoal(goals, 'voice')).toEqual({ goal: goals[2] })
  expect(findGoal(goals, 'in')).toEqual({ matches: [goals[0], goals[1]] })
  expect(findGoal(goals, 'nothing')).toEqual({ matches: [] })
})

test('diffAlerts is quiet on the first read, then reports only what is new', async () => {
  const before = [card({ id: 'g1', name: 'Inbox', needs_you: [proposal('1', 'A')] })]
  const first = diffAlerts(null, before)
  expect(first.proposals).toEqual([])
  const after = [card({ id: 'g1', name: 'Inbox', needs_you: [proposal('1', 'A'), proposal('2', 'B')] })]
  const next = diffAlerts(first.seen, after)
  expect(next.proposals.map((p) => p.item.id)).toEqual(['2'])
})

test('statusText counts what needs you and what is running', async () => {
  expect(statusText(EMPTY)).toBe('Conductor: offline')
  const s = { ...EMPTY, reachable: true, goals: [
    card({ id: 'g1', name: 'Inbox', needs_you: [proposal('1', 'A'), proposal('2', 'B')] }),
    card({ id: 'g2', name: 'Invoices', open_run: { id: 'r', status: 'running' } }),
  ] }
  expect(statusText(s)).toBe('Conductor: 2 need you · Invoices running')
  expect(statusText({ ...s, goals: [] })).toBeUndefined()
})

test('clip keeps short text and ends cut text with …', async () => {
  expect(clip('short', 10)).toBe('short')
  expect(clip('a long line of text', 10)).toBe('a long li…')
  expect([...clip('x'.repeat(50), 20)].length).toBe(20)
})

test('spark and ago format for a narrow pane', async () => {
  expect(spark([1])).toBe('')
  expect(spark([0, 5, 10])).toBe('▁▅█')
  expect(ago('2026-11-07T07:58:00Z', NOW)).toBe('2m ago')
  expect(ago('2026-11-07T10:00:00Z', NOW)).toBe('in 2h')
  expect(ago(null, NOW)).toBe('—')
})

test('parseSchedule reads intervals, windows, cron and off, and explains the rest', async () => {
  expect(parseSchedule('every 6h')).toEqual({ schedule: { kind: 'interval', minutes: 360 } })
  expect(parseSchedule('Every 30 minutes between 8:00-20:30')).toEqual({ schedule: { kind: 'interval', minutes: 30, active_hours: '08:00-20:30' } })
  expect(parseSchedule('every 1d')).toEqual({ schedule: { kind: 'interval', minutes: 1440 } })
  expect(parseSchedule('cron 0 9 * * 1-5')).toEqual({ schedule: { kind: 'cron', expr: '0 9 * * 1-5' } })
  expect(parseSchedule('off')).toEqual({ schedule: null })
  expect(parseSchedule('every 2m')).toEqual({ error: expect.stringContaining('5 minutes') })
  expect(parseSchedule('every 6 weeks')).toEqual({ error: expect.stringContaining('m, h or d') })
  expect(parseSchedule('every 1h between 25:00-26:00')).toEqual({ error: expect.stringContaining('24-hour') })
  expect(parseSchedule('cron 0 9 *')).toEqual({ error: expect.stringContaining('5 fields') })
  expect(parseSchedule('sometimes')).toEqual({ error: expect.stringContaining('every 6h') })
})

test('scheduleLabel and nextRunText say when a goal runs next', async () => {
  expect(scheduleLabel({ kind: 'interval', minutes: 360 })).toBe('every 6h')
  expect(scheduleLabel({ kind: 'interval', minutes: 90, active_hours: '08:00-20:00' })).toBe('every 90m, 08:00–20:00')
  expect(scheduleLabel({ kind: 'cron', expr: '0 9 * * *' })).toBe('cron 0 9 * * *')
  expect(scheduleLabel(null)).toBe('on demand')
  const g = { status: 'active', openRun: null, schedule: { kind: 'interval' as const, minutes: 60 } }
  expect(nextRunText({ ...g, nextRunAt: new Date(NOW + 25 * 60_000).toISOString() }, NOW)).toBe(' · next in 25m')
  expect(nextRunText({ ...g, nextRunAt: new Date(NOW - 60_000).toISOString() }, NOW)).toBe(' · next run due now')
  expect(nextRunText({ ...g, nextRunAt: null, schedule: null }, NOW)).toBe(' · no schedule (/goal-schedule)')
  expect(nextRunText({ ...g, status: 'paused', nextRunAt: null, schedule: null }, NOW)).toBe('')
  expect(nextRunText({ ...g, openRun: { id: 'r', status: 'running' }, nextRunAt: null }, NOW)).toBe('')
})
