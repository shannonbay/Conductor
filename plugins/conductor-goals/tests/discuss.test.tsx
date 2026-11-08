import { expect, test } from 'claude-code/testing'

import { engine, fakeConductor, goal, PANE, START } from './fixtures'

const failed = () => goal({
  id: 'g1',
  name: 'Unsubscribe',
  runs: [
    { id: 'r2', status: 'failed', trigger: 'interval', summary: 'The agent ended without calling end_run', started_at: '2026-11-07T07:50:00Z', ended_at: '2026-11-07T07:50:04Z', agent_id: 'a62da' },
    { id: 'r1', status: 'completed', trigger: 'interval', summary: 'First run. Blocked: Gmail is not connected.', started_at: '2026-11-07T06:50:00Z', ended_at: '2026-11-07T06:51:00Z', agent_id: 'ab1e9' },
  ],
  autonomy: { 'email.archive': 'auto' },
})

test('a goal whose last run failed has Discuss, which brings the failure into the conversation', async ($, on) => {
  const { prompts } = engine(on)
  fakeConductor(on, [failed(), goal({ id: 'g2', name: 'Inbox' })])
  await $.session.start(START)
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  expect(await ui.find({ key: 'discuss-g2' })).toBeUndefined() // only on failed goals
  await ui.press({ key: 'discuss-g1' })
  expect(prompts[0]).toContain('this run of my goal "Unsubscribe" (goal g1, run r2): failed (interval)')
  expect(prompts[0]).toContain('Its summary: The agent ended without calling end_run')
  expect(prompts[0]).toContain('Why did it fail')
  expect(prompts[0]).toContain('agent-a62da.jsonl')
  expect(prompts[0]).toContain('update_goal or set_schedule')
  await ui.unmount()
})

test('expanded, a goal can be discussed as a whole or run by run', async ($, on) => {
  const { prompts } = engine(on)
  fakeConductor(on, [failed()])
  await $.session.start(START)
  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  await ui.press({ key: 'toggle-g1' })
  await ui.press({ key: 'discuss-run-r1' })
  expect(prompts[0]).toContain('run r1): completed (interval)')
  expect(prompts[0]).toContain('Its summary: First run. Blocked: Gmail is not connected.')
  expect(prompts[0]).toContain('Is this what should have happened')
  await ui.press({ key: 'discuss-goal-g1' })
  expect(prompts[1]).toBe('Let\'s talk about my goal "Unsubscribe" (id g1). Read its settings, items, runs and memory with goal_detail. If we agree on changes, make them with update_goal or set_schedule: they ask me to confirm. What\'s working, what isn\'t, and what would you change?')
  await ui.unmount()
})

test('update_goal shows each change and applies only what the person confirms', async ($, on) => {
  const declined = engine(on, { answer: 'Cancel' })
  const fake = fakeConductor(on, [failed()])
  await $.session.start(START)
  const no = await $.tool.call({ tool: 'mcp__conductor-goals__update_goal', goal: 'unsub', autonomy: { 'email.archive': null, 'email.delete': 'off' }, status: 'paused' } as never)
  expect(declined.asked[0]).toBe('Change the goal "Unsubscribe"?\n• email.archive: auto → propose (default)\n• email.delete: propose → off\n• Pause the goal')
  expect(String(no.result)).toContain('declined')
  expect(fake.of('update_goal')).toEqual([])
  const nothing = await $.tool.call({ tool: 'mcp__conductor-goals__update_goal', goal: 'unsub' } as never)
  expect(String(nothing.result)).toContain('Nothing to change')
})

test('update_goal applies confirmed changes', async ($, on) => {
  engine(on, { answer: 'Apply changes' })
  const fake = fakeConductor(on, [failed()])
  await $.session.start(START)
  const yes = await $.tool.call({ tool: 'mcp__conductor-goals__update_goal', goal: 'unsub', autonomy: { 'email.delete': 'off' } } as never)
  expect(String(yes.result)).toBe('Changed Unsubscribe: email.delete: off.')
  expect(fake.of('update_goal')[0]?.input).toEqual({ goal_id: 'g1', autonomy: { 'email.delete': 'off' } })
})

test('while the usage limit holds runs, the pane says so', async ($, on) => {
  engine(on)
  fakeConductor(on, [goal({ id: 'g1', name: 'Inbox' })], { hold: { until: '2026-11-07T20:10:00Z', reason: "You've hit your 5-hour limit" } })
  await $.session.start(START)
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  expect((await ui.find({ type: 'Text', text: /on hold until/ }))?.text).toContain('the usage limit is reached')
  await ui.unmount()
})
