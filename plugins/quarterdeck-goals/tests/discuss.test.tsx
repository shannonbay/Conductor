import { expect, test } from 'claude-code/testing'

import { engine, fakeQuarterdeck, goal, PANE, START } from './fixtures'

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
  fakeQuarterdeck(on, [failed(), goal({ id: 'g2', name: 'Inbox' })])
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
  fakeQuarterdeck(on, [failed()])
  await $.session.start(START)
  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  await ui.press({ key: 'toggle-g1' })
  // Pressing opens a question box and sends nothing; Enter on the empty box asks the usual question
  await ui.press({ key: 'discuss-run-r1' })
  expect(prompts).toEqual([])
  expect((await ui.find({ key: 'discuss-run-input-r1' }))?.props).toMatchObject({ autoFocus: true, label: 'Your question' })
  await ui.input({ key: 'discuss-run-input-r1', text: '' })
  expect(prompts[0]).toContain('run r1): completed (interval)')
  expect(prompts[0]).toContain('Its summary: First run. Blocked: Gmail is not connected.')
  expect(prompts[0]).toContain('Is this what should have happened')
  expect(await ui.find({ key: 'discuss-run-input-r1' })).toBeUndefined() // closes after sending
  await ui.press({ key: 'discuss-goal-g1' })
  await ui.input({ key: 'discuss-goal-input-g1', text: '' })
  expect(prompts[1]).toBe('Let\'s talk about my goal "Unsubscribe" (id g1). Read its settings, items, runs and memory with goal_detail. If we agree on changes, make them with update_goal or set_schedule: they ask me to confirm. What\'s working, what isn\'t, and what would you change?')
  await ui.unmount()
})

test('a question typed in the Discuss box goes with the run or goal in place of the usual one', async ($, on) => {
  const { prompts } = engine(on)
  fakeQuarterdeck(on, [failed()])
  await $.session.start(START)
  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  await ui.press({ key: 'toggle-g1' })
  await ui.press({ key: 'discuss-run-r2' })
  await ui.input({ key: 'discuss-run-input-r2', text: '  Did it reach Gmail at all? ' })
  expect(prompts[0]).toContain('run r2): failed (interval)')
  expect(prompts[0]).toContain('Its summary: The agent ended without calling end_run')
  expect(prompts[0]).toContain('agent-a62da.jsonl')
  expect(prompts[0]).toContain('update_goal or set_schedule')
  expect(prompts[0]).not.toContain('Why did it fail')
  expect(prompts[0]!.endsWith('My question: Did it reach Gmail at all?')).toBe(true)
  await ui.press({ key: 'discuss-goal-g1' })
  await ui.input({ key: 'discuss-goal-input-g1', text: 'Should archiving stay on auto?' })
  expect(prompts[1]).toBe('Let\'s talk about my goal "Unsubscribe" (id g1). Read its settings, items, runs and memory with goal_detail. If we agree on changes, make them with update_goal or set_schedule: they ask me to confirm.\n\nMy question: Should archiving stay on auto?')
  // Cancel closes the box and sends nothing
  await ui.press({ key: 'discuss-run-r1' })
  await ui.press({ key: 'discuss-run-cancel-r1' })
  expect(await ui.find({ key: 'discuss-run-input-r1' })).toBeUndefined()
  expect(prompts.length).toBe(2)
  await ui.unmount()
})

test('update_goal shows each change and applies only what the person confirms', async ($, on) => {
  const declined = engine(on, { answer: 'Cancel' })
  const fake = fakeQuarterdeck(on, [failed()])
  await $.session.start(START)
  const no = await $.tool.call({ tool: 'mcp__quarterdeck-goals__update_goal', goal: 'unsub', autonomy: { 'email.archive': null, 'email.delete': 'off' }, status: 'paused' } as never)
  expect(declined.asked[0]).toBe('Change the goal "Unsubscribe"?\n• email.archive: auto → propose (default)\n• email.delete: propose → off\n• Pause the goal')
  expect(String(no.result)).toContain('declined')
  expect(fake.of('update_goal')).toEqual([])
  const nothing = await $.tool.call({ tool: 'mcp__quarterdeck-goals__update_goal', goal: 'unsub' } as never)
  expect(String(nothing.result)).toContain('Nothing to change')
})

test('update_goal applies confirmed changes', async ($, on) => {
  engine(on, { answer: 'Apply changes' })
  const fake = fakeQuarterdeck(on, [failed()])
  await $.session.start(START)
  const yes = await $.tool.call({ tool: 'mcp__quarterdeck-goals__update_goal', goal: 'unsub', autonomy: { 'email.delete': 'off' } } as never)
  expect(String(yes.result)).toBe('Changed Unsubscribe: email.delete: off.')
  expect(fake.of('update_goal')[0]?.input).toEqual({ goal_id: 'g1', autonomy: { 'email.delete': 'off' } })
})

test('update_goal passes a confirmed category merge to the server', async ($, on) => {
  const asked = engine(on, { answer: 'Apply changes' })
  const fake = fakeQuarterdeck(on, [failed()])
  await $.session.start(START)
  await $.tool.call({ tool: 'mcp__quarterdeck-goals__update_goal', goal: 'unsub', merge_categories: { 'email.trash': 'email.delete' } } as never)
  expect(asked.asked[0]).toContain('• Merge category email.trash into email.delete')
  expect(fake.of('update_goal')[0]?.input).toEqual({ goal_id: 'g1', merge_categories: { 'email.trash': 'email.delete' } })
})

test('update_goal shows a new watch\'s whole command before it is set, and says how its first check went', async ($, on) => {
  const asked = engine(on, { answer: 'Apply changes' })
  const fake = fakeQuarterdeck(on, [failed()])
  await $.session.start(START)
  const command = `gh issue list --repo octo/site --state open --limit 100 --json number --jq ".[].number" ${'# '.padEnd(400, 'x')}`
  const r = await $.tool.call({ tool: 'mcp__quarterdeck-goals__update_goal', goal: 'unsub', watches: { 'new issues': { command } } } as never)
  // Every character of what will run unattended, however long
  expect(asked.asked[0]).toBe(`Change the goal "Unsubscribe"?\n• New watch "new issues": every 5 min this command runs on your computer, and a run starts when it prints a line it hasn't before: ${command}`)
  expect(fake.of('update_goal')[0]?.input).toEqual({ goal_id: 'g1', watches: { 'new issues': { command } } })
  expect(String(r.result)).toContain('Watch "new issues": works: 3 items there now; a run starts when a new one appears.')

  // goal_detail lists it, and changing or removing it says so
  expect(String((await $.tool.call({ tool: 'mcp__quarterdeck-goals__goal_detail', goal: 'unsub' } as never)).result)).toContain('- new issues: every 5 min, runs gh issue list')
  await $.tool.call({ tool: 'mcp__quarterdeck-goals__update_goal', goal: 'unsub', watches: { 'new issues': { command: 'gh pr list', every_minutes: 15 }, old: null } } as never)
  expect(asked.asked[1]).toBe('Change the goal "Unsubscribe"?\n• Watch changed "new issues": every 15 min this command runs on your computer, and a run starts when it prints a line it hasn\'t before: gh pr list\n• Watch removed: old')
  // A watch on a state says it fires when its output changes, and passes the mode through
  await $.tool.call({ tool: 'mcp__quarterdeck-goals__update_goal', goal: 'unsub', watches: { tree: { command: 'git describe --always --dirty', fires: 'change' } } } as never)
  expect(asked.asked[2]).toBe('Change the goal "Unsubscribe"?\n• New watch "tree": every 5 min this command runs on your computer, and a run starts when its output changes: git describe --always --dirty')
  expect(fake.of('update_goal')[2]?.input).toEqual({ goal_id: 'g1', watches: { tree: { command: 'git describe --always --dirty', fires: 'change' } } })
})

test('update_goal shows a tool watch\'s tool and whole input before it is set', async ($, on) => {
  const asked = engine(on, { answer: 'Apply changes' })
  const fake = fakeQuarterdeck(on, [failed()])
  await $.session.start(START)
  const watch = { tool: 'mcp__claude_ai_Gmail__search_threads', input: { query: 'is:unread in:inbox', view: 'THREAD_VIEW_IDS_ONLY' }, every_minutes: 10 }
  await $.tool.call({ tool: 'mcp__quarterdeck-goals__update_goal', goal: 'unsub', watches: { 'new mail': watch } } as never)
  expect(asked.asked[0]).toBe('Change the goal "Unsubscribe"?\n• New watch "new mail": every 10 min this tool is called without asking you, and a run starts when its answer has something it hasn\'t before: mcp__claude_ai_Gmail__search_threads {"query":"is:unread in:inbox","view":"THREAD_VIEW_IDS_ONLY"}')
  expect(fake.of('update_goal')[0]?.input).toEqual({ goal_id: 'g1', watches: { 'new mail': watch } })
})

test('a goal shows its watches when expanded, and one that cannot check keeps its card', async ($, on) => {
  engine(on)
  const watch = (failing: boolean) => [{ name: 'new issues', every_minutes: 5, runs: 'gh issue list', last_fired_at: failing ? null : '2026-11-07T07:00:00Z', failing, error: failing ? 'Exit code 4: gh: not logged in' : null }]
  fakeQuarterdeck(on, [
    goal({ id: 'g1', name: 'Issues', watches: watch(false) }),
    goal({ id: 'g2', name: 'Pulls', watches: watch(true) }),
  ])
  await $.session.start(START)
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  // Working: one quiet line until expanded
  expect(await ui.find({ key: 'pause-g1' })).toBeUndefined()
  await ui.press({ key: 'toggle-g1' })
  expect(await ui.find({ type: 'Text', text: /Also runs when "new issues" sees something new \(checked every 5 min, last .* ago\)/ })).toBeDefined()
  // Failing: the card stays, and says so
  expect(await ui.find({ key: 'pause-g2' })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /^a watch can't check: expand the goal to see why$/ })).toBeDefined()
  await ui.press({ key: 'toggle-g2' })
  expect(await ui.find({ type: 'Text', text: /can't check: Exit code 4: gh: not logged in/ })).toBeDefined()
  await ui.unmount()
})

test('while the usage limit holds runs, the pane says so', async ($, on) => {
  engine(on)
  fakeQuarterdeck(on, [goal({ id: 'g1', name: 'Inbox' })], { hold: { until: '2026-11-07T20:10:00Z', reason: "You've hit your 5-hour limit" } })
  await $.session.start(START)
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  expect((await ui.find({ type: 'Text', text: /on hold until/ }))?.text).toContain('the usage limit is reached')
  await ui.unmount()
})
