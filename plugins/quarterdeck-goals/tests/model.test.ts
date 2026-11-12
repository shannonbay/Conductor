import { expect, test } from 'claude-code/testing'

import { phoneText } from '../hooks/alerts'

import {
  ago, choiceFromAnswer, choiceOptions, clip, diffAlerts, EMPTY, findGoal, nextRunText, parseSchedule, parseSuggestion, scheduleLabel, spark,
  statusText, suggestByKeywords, toCard, cleanTitle, fallbackTitle, splitGoalArgs, runCost, planModeBlocked, soundsEventDriven, isQuiet, allowRules, allowRulesPrompt, describe, describeGoalChanges, modelName, newGoalModelText, readModelAnswer } from '../hooks/model'
import { TEMPLATES } from '../hooks/templates'
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
  expect(statusText(EMPTY)).toBe('Quarterdeck: offline')
  const s = { ...EMPTY, reachable: true, goals: [
    card({ id: 'g1', name: 'Inbox', needs_you: [proposal('1', 'A'), proposal('2', 'B')] }),
    card({ id: 'g2', name: 'Invoices', open_run: { id: 'r', status: 'running' } }),
  ] }
  expect(statusText(s)).toBe('Quarterdeck: 2 need you · Invoices running')
  const asking = card({ id: 'g3', name: 'Tidy', open_run: { id: 'r3', status: 'running' }, activity: { state: 'running', text: 'Waiting for your permission: Bash: rm a.txt', at: null, waiting: { tool: 'Bash: rm a.txt', since: '2026-11-07T08:00:00Z' } } })
  expect(statusText({ ...s, goals: [...s.goals, asking] })).toBe('Quarterdeck: 2 need you · Tidy waiting for your permission · Invoices running')
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
  expect(parseSchedule('every 6 weeks')).toEqual({ schedule: { kind: 'interval', minutes: 60480 } })
  expect(parseSchedule('every 1h between 25:00-26:00')).toEqual({ error: expect.stringContaining('24-hour') })
  expect(parseSchedule('cron 0 9 *')).toEqual({ error: expect.stringContaining('5 fields') })
  expect(parseSchedule('sometimes')).toEqual({ error: expect.stringContaining('every 30m | 6h | 30d') })
})

test('scheduleLabel and nextRunText say when a goal runs next', async () => {
  expect(scheduleLabel({ kind: 'interval', minutes: 360 })).toBe('every 6h')
  expect(scheduleLabel({ kind: 'interval', minutes: 90, active_hours: '08:00-20:00' })).toBe('every 90m, 08:00–20:00')
  expect(scheduleLabel({ kind: 'cron', expr: '0 9 * * *' })).toBe('cron 0 9 * * *')
  expect(scheduleLabel(null)).toBe('on demand')
  const g = { status: 'active', openRun: null, oneOff: false, schedule: { kind: 'interval' as const, minutes: 60 } }
  expect(nextRunText({ ...g, nextRunAt: new Date(NOW + 25 * 60_000).toISOString() }, NOW)).toBe(' · next in 25m')
  expect(nextRunText({ ...g, nextRunAt: new Date(NOW - 60_000).toISOString() }, NOW)).toBe(' · next run due now')
  expect(nextRunText({ ...g, nextRunAt: null, schedule: null }, NOW)).toBe(' · no schedule')
  expect(nextRunText({ ...g, nextRunAt: null, schedule: null, oneOff: true }, NOW)).toBe(' · one-off')
  expect(nextRunText({ ...g, status: 'paused', nextRunAt: null, schedule: null }, NOW)).toBe('')
  expect(nextRunText({ ...g, openRun: { id: 'r', status: 'running' }, nextRunAt: null }, NOW)).toBe('')
})

test('keyword suggestions lean towards a schedule, and spot one-offs', async () => {
  expect(suggestByKeywords('maintain-github-profile', 'monitor my github for contributions').choice).toBe('6h')
  expect(suggestByKeywords('Inbox', 'keep my inbox under 20 unread').choice).toBe('hourly')
  expect(suggestByKeywords('Profile', 'maintain my profile README').choice).toBe('daily')
  expect(suggestByKeywords('Status', 'weekly report of open PRs').choice).toBe('weekly')
  expect(suggestByKeywords('Setup', 'install gh and sign in').choice).toBe('one-off')
  expect(suggestByKeywords('Plants', 'water the plants').choice).toBe('daily')
})

test('the model suggestion is read from JSON, and anything else falls through', async () => {
  expect(parseSuggestion('```json\n{"choice": "weekly", "reason": "It sums up a week."}\n```')).toEqual({ choice: 'weekly', reason: 'It sums up a week' })
  expect(parseSuggestion('{"choice": "on-demand"}')).toBeNull()
  expect(parseSuggestion('daily, I think')).toBeNull()
  expect(parseSchedule('one-off')).toEqual({ schedule: null, oneOff: true })
})

test('the suggestion carries the model for the goal\'s runs; an unknown or missing one is left out', async () => {
  expect(parseSuggestion('{"choice": "6h", "reason": "x", "model": "Haiku", "model_reason": "it only checks and reports."}'))
    .toEqual({ choice: '6h', reason: 'x', model: 'haiku', modelReason: 'it only checks and reports' })
  expect(parseSuggestion('{"choice": "daily", "reason": "x", "model": "opus"}')).toEqual({ choice: 'daily', reason: 'x', model: 'opus' })
  expect(parseSuggestion('{"choice": "daily", "reason": "x", "model": "gpt-5", "model_reason": "y"}')).toEqual({ choice: 'daily', reason: 'x' })
  expect(newGoalModelText('haiku', 'it only checks and reports')).toBe(' Its runs use Haiku (it only checks and reports); change that in the Goals pane.')
  expect(newGoalModelText('sonnet')).toBe(' Its runs use Sonnet; change that in the Goals pane.')
})

test('every template names a model and why', async () => {
  for (const t of TEMPLATES) {
    expect(['haiku', 'sonnet', 'opus']).toContain(t.model)
    expect(t.modelReason).toBeTruthy()
  }
  expect(TEMPLATES.find((t) => t.name === 'GitHub Profile')?.model).toBe('opus')
  expect(TEMPLATES.find((t) => t.name === 'Tidy Downloads')?.model).toBe('haiku')
})

test('choices put the suggestion first, and answers map back to choices', async () => {
  const options = choiceOptions('weekly')
  expect(options).toEqual(['Weekly (suggested)', 'Daily', 'One-off: run once now', 'Every hour'])
  expect(choiceOptions('one-off')).toEqual(['One-off: run once now (suggested)', 'Daily', 'Weekly', 'Every hour'])
  expect(choiceFromAnswer('Weekly (suggested)')).toMatchObject({ key: 'weekly', schedule: { kind: 'interval', minutes: 10080 } })
  expect(choiceFromAnswer('One-off: run once now')).toMatchObject({ key: 'one-off', oneOff: true, schedule: null })
  expect(choiceFromAnswer('every 12h')).toMatchObject({ key: 'custom', label: 'every 12h', schedule: { kind: 'interval', minutes: 720 } })
  expect(choiceFromAnswer('off')).toMatchObject({ key: 'custom', schedule: null, oneOff: false })
  expect(choiceFromAnswer('Cancel')).toBeNull()
  expect(choiceFromAnswer(null)).toBeNull()
})

test('/goal-new arguments: a short name before a colon, otherwise all objective; titles are tidied', async () => {
  expect(splitGoalArgs('Inbox: keep it under 20')).toEqual({ name: 'Inbox', objective: 'keep it under 20' })
  expect(splitGoalArgs('keep my inbox under 20 unread please: archive newsletters')).toEqual({ name: null, objective: 'keep my inbox under 20 unread please: archive newsletters' })
  expect(splitGoalArgs('watch the build')).toEqual({ name: null, objective: 'watch the build' })
  expect(splitGoalArgs('Inbox:')).toEqual({ name: null, objective: 'Inbox:' })
  expect(cleanTitle('"Weekly PR Digest."')).toBe('Weekly PR Digest')
  expect(fallbackTitle('keep my inbox under 20 unread')).toBe('Keep inbox under 20 unread')
  expect(fallbackTitle('!!!')).toBe('New goal')
  expect(parseSuggestion('{"choice": "daily", "reason": "x", "title": "Tidy Downloads"}')).toEqual({ choice: 'daily', reason: 'x', title: 'Tidy Downloads' })
})

test('phoneText keeps the answer instructions and fits a push', () => {
  const g = { name: 'Tidy downloads' } as never
  const long = phoneText([{ goal: g, item: { title: 'Delete '.concat('x'.repeat(300)) } }], [])
  expect(long.length).toBeLessThanOrEqual(200)
  expect(long).toContain('Reply "approve"')
  expect(phoneText([], [{ goal: g }, { goal: g }])).toBe('Quarterdeck: 2 goal runs failed.')
  expect(phoneText([{ goal: g, item: { title: 'a' } }, { goal: g, item: { title: 'b' } }], [{ goal: g }]))
    .toBe('Quarterdeck: 2 proposals need you. Reply "what needs me?" in Claude. Tidy downloads: run failed.')
})

test('runCost shows tokens and time, or nothing when unknown', () => {
  expect(runCost({ tokens: 48_200, startedAt: '2026-11-09T00:00:00Z', endedAt: '2026-11-09T00:02:10Z' })).toBe('48k tokens · 2m')
  expect(runCost({ tokens: 1_250_000, startedAt: '2026-11-09T00:00:00Z', endedAt: '2026-11-09T00:00:40Z' })).toBe('1.3M tokens · 40s')
  expect(runCost({ tokens: 0, startedAt: '2026-11-09T00:00:00Z', endedAt: null })).toBe('')
})

test('parseSchedule takes intervals with or without "every", in weeks, and as words', () => {
  const minutes = (t: string) => { const r = parseSchedule(t); return 'error' in r ? r.error : (r.schedule as { minutes: number }).minutes }
  expect(minutes('30d')).toBe(43200)
  expect(minutes('30 days')).toBe(43200)
  expect(minutes('every 30 days')).toBe(43200)
  expect(minutes('2 weeks')).toBe(20160)
  expect(minutes('monthly')).toBe(43200)
  expect(minutes('weekly')).toBe(10080)
  expect(minutes('hourly')).toBe(60)
  expect(parseSchedule('daily between 08:00-20:00')).toEqual({ schedule: { kind: 'interval', minutes: 1440, active_hours: '08:00-20:00' } })
  expect(minutes('30 fortnights')).toContain('minutes, hours, days or weeks')
})

test("planModeBlocked spots Claude Code refusing a plugin's write in plan mode, and nothing else", () => {
  expect(planModeBlocked("mcp__plugin_quarterdeck-goals_quarterdeck__todo_set wasn't run: this call needs a person's approval, and a mod's own call can't ask for it.")).toBe(true)
  expect(planModeBlocked('Feedback is required')).toBe(false)
  expect(planModeBlocked('fetch failed')).toBe(false)
})

test('an objective about things happening is spotted, so /goal-new can mention watches', () => {
  expect(soundsEventDriven('Triage new issues in octo/site')).toBe(true)
  expect(soundsEventDriven('When a pull request is opened, review it')).toBe(true)
  expect(soundsEventDriven('Whenever a release is published, write the notes')).toBe(true)
  expect(soundsEventDriven('Keep my inbox under 20 unread')).toBe(false)
  expect(soundsEventDriven('Water the plants every morning')).toBe(false)
})

test('a goal whose watch cannot check is not quiet, and an older server without watches still reads', () => {
  const watch = (failing: boolean) => ({ name: 'new issues', every_minutes: 5, runs: 'gh issue list', last_fired_at: null, failing, error: failing ? 'Exit code 4' : null })
  expect(isQuiet(card({ id: 'g1', name: 'Issues', watches: [watch(false)] }))).toBe(true)
  expect(isQuiet(card({ id: 'g1', name: 'Issues', watches: [watch(true)] }))).toBe(false)
  expect(card({ id: 'g1', name: 'Issues' })).toMatchObject({ watches: [], watchCount: 0, watchFailing: false })
})

test("allowRules lists a Claude Code allow rule for each of a goal's auto tool rules, and what can't be one", async () => {
  const g = {
    autonomy: { 'email.unsubscribe': 'auto', 'email.delete': 'propose', 'shell': 'auto', 'all': 'auto' },
    toolMap: {
      'mcp__claude_ai_Gmail__unsubscribe*': 'email.unsubscribe',
      'mcp__claude_ai_Gmail__trash_thread': 'email.delete',
      Bash: 'shell',
      'mcp__quarterdeck__unsubscribe_one_click': 'email.unsubscribe',
      'mcp__*': 'all',
    },
  }
  expect(allowRules(g)).toEqual({
    rules: [
      'Bash',
      'mcp__claude_ai_Gmail__unsubscribe*',
      // Quarterdeck's own server under both of its names
      'mcp__plugin_quarterdeck-goals_quarterdeck__unsubscribe_one_click',
      'mcp__quarterdeck__unsubscribe_one_click',
    ],
    skipped: ['mcp__*'],
  })
  expect(allowRules({ autonomy: {}, toolMap: { Bash: 'shell' } })).toEqual({ rules: [], skipped: [] })

  const prompt = allowRulesPrompt({ id: 'g1', name: 'Inbox' }, ['Bash'])
  expect(prompt).toContain('"Inbox" (id g1)')
  expect(prompt).toContain('- `Bash`')
  expect(prompt).toContain('wait for my yes')

  const detail = describe(card({ id: 'g1', name: 'Inbox', autonomy: { shell: 'auto' }, tool_map: { Bash: 'shell' } }), NOW)
  expect(detail).toContain('Claude Code allow rules for its auto tools')
  expect(describe(card({ id: 'g2', name: 'Quiet' }), NOW)).not.toContain('allow rules')
})

test('modelName reads a model id as the person would say it', async () => {
  expect(modelName('claude-opus-5-5')).toBe('Opus 5.5')
  expect(modelName('claude-haiku-4-5-20251001')).toBe('Haiku 4.5')
  expect(modelName('claude-sonnet-4-20250514')).toBe('Sonnet 4')
  expect(modelName('claude-3-5-sonnet-20241022')).toBe('Sonnet')
  expect(modelName('sonnet')).toBe('Sonnet')
  expect(modelName('some-other-model')).toBe('some-other-model')
})

test('readModelAnswer: a choice, a typed id, or nothing for a dismissed question', async () => {
  expect(readModelAnswer('Opus')).toEqual({ model: 'opus' })
  expect(readModelAnswer("Session's model")).toEqual({ model: null })
  expect(readModelAnswer(' claude-sonnet-5-5 ')).toEqual({ model: 'claude-sonnet-5-5' })
  expect(readModelAnswer('Cancel')).toBeNull()
  expect(readModelAnswer(null)).toBeNull()
})

test("a goal's model shows in its detail and in a change the person confirms", async () => {
  const g = card({ id: 'g1', name: 'Inbox', model: 'sonnet' })
  expect(describe(g, NOW)).toContain('Model: Sonnet')
  expect(describeGoalChanges(g, { model: 'opus' })).toEqual(['Model: Sonnet → Opus'])
  expect(describeGoalChanges(g, { model: null })).toEqual(["Model: Sonnet → the session's model"])
  expect(describeGoalChanges(g, { model: 'sonnet' })).toEqual([])
})

test('runCost names the model a run used', async () => {
  expect(runCost({ tokens: 48_000, startedAt: '2026-11-07T07:00:00Z', endedAt: '2026-11-07T07:02:00Z', model: 'claude-opus-5-5' })).toBe('Opus 5.5 · 48k tokens · 2m')
})
