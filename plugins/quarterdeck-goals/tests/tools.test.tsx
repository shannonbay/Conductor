import { expect, test } from 'claude-code/testing'

import { BAND, engine, fakeQuarterdeck, goal, proposal, START, SURFACES, question } from './fixtures'

/** A command typed at the prompt. */
const typed = (command: string, args: string) =>
  ({ command, args, origin: { kind: 'composer' }, presentation: { isFullscreen: false, columns: 100 } }) as const

const inbox = () => goal({ id: 'g1', name: 'Inbox', needs_you: [proposal('11', 'Reply to Alice')] })

test('goals_status summarises every goal for Claude, with item ids', async ($, on) => {
  engine(on)
  fakeQuarterdeck(on, [inbox(), goal({ id: 'g2', name: 'Invoices' })])
  await $.session.start(START)
  const res = await $.tool.call({ tool: 'mcp__quarterdeck-goals__goals_status' })
  const text = String(res.result)
  expect(text).toContain('## Inbox (id g1, active)')
  expect(text).toContain('- item 11: Reply to Alice [email.send]')
  expect(text).toContain('## Invoices')
  expect(text).toContain('Now: Waiting for its first run')
})

test('approve_item asks first and does nothing when declined', async ($, on) => {
  const { asked } = engine(on, { answer: 'Cancel' })
  const fake = fakeQuarterdeck(on, [inbox()])
  await $.session.start(START)
  const res = await $.tool.call({ tool: 'mcp__quarterdeck-goals__approve_item', goal: 'inbox', item_id: '11' })
  expect(asked).toEqual(['Approve "Reply to Alice" (Send: Reply to Alice) for the goal "Inbox"?'])
  expect(String(res.result)).toContain('declined')
  expect(fake.of('decide_item')).toEqual([])
})

test('approve_item approves once the person confirms', async ($, on) => {
  engine(on, { answer: 'Approve' })
  const fake = fakeQuarterdeck(on, [inbox()])
  await $.session.start(START)
  const res = await $.tool.call({ tool: 'mcp__quarterdeck-goals__approve_item', goal: 'Inbox', item_id: '11' })
  expect(String(res.result)).toContain('Approved "Reply to Alice"')
  expect(fake.of('decide_item').map((c) => c.input)).toEqual([{ goal_id: 'g1', item_id: '11', decision: 'approve' }])
})

test('an unknown item or ambiguous goal name is explained', async ($, on) => {
  engine(on, { answer: 'Approve' })
  fakeQuarterdeck(on, [inbox(), goal({ id: 'g2', name: 'Inbox archive' })])
  await $.session.start(START)
  const ambiguous = await $.tool.call({ tool: 'mcp__quarterdeck-goals__approve_item', goal: 'inb', item_id: '11' })
  expect(String(ambiguous.result)).toContain('matches Inbox, Inbox archive')
  const missing = await $.tool.call({ tool: 'mcp__quarterdeck-goals__approve_item', goal: 'Inbox', item_id: '99' })
  expect(String(missing.result)).toContain('Waiting: 11 (Reply to Alice)')
})

test('/goal-new creates a goal in the session directory; /goal-pause pauses it', async ($, on) => {
  engine(on)
  const goals: ReturnType<typeof goal>[] = []
  const fake = fakeQuarterdeck(on, goals)
  await $.session.start(START)

  const none = await $.command.run(typed('goal-new', '  ')) // offers the templates; the fake dismisses
  expect(none.text).toBe('No goal created.')

  const made = await $.command.run(typed('goal-new', 'Inbox: keep my inbox under 20 unread'))
  expect(made.text).toContain('Created the goal "Inbox"')
  // The question was dismissed (the fake answers Cancel), so the suggestion stands: daily
  expect(made.text).toContain('running every 1d')
  expect(fake.of('create_goal')[0]?.input).toEqual({
    name: 'Inbox', objective: 'keep my inbox under 20 unread', working_dir: '/work/project',
    schedule: { kind: 'interval', minutes: 1440 }, one_off: false, model: 'sonnet',
  })
  // The small model named no model, so the default stands, with no reason given
  expect(made.text).toContain('Its runs use Sonnet; change that in the Goals pane.')

  const paused = await $.command.run(typed('goal-pause', 'inbox'))
  expect(paused.text).toBe('Inbox is paused.')
  expect(goals[0]!.status).toBe('paused')
})

test('new_goal creates nothing when the person dismisses the schedule question', async ($, on) => {
  const { asked } = engine(on) // the fake dismisses
  const fake = fakeQuarterdeck(on, [])
  await $.session.start(START)
  const res = await $.tool.call({ tool: 'mcp__quarterdeck-goals__new_goal', name: 'Inbox', objective: 'keep my inbox under 20 unread' } as never)
  expect(asked[0]).toContain('Claude asks to create the goal "Inbox" in /work/project: keep my inbox under 20 unread. Dismiss this to create nothing. How often should "Inbox" run?')
  expect(String(res.result)).toContain('no goal was created')
  expect(fake.of('create_goal')).toEqual([])
})

test('new_goal creates the goal as /goal-new does once the person picks a schedule', async ($, on) => {
  engine(on, { answer: 'Every 6 hours' })
  const fake = fakeQuarterdeck(on, [])
  await $.session.start(START)
  const res = await $.tool.call({ tool: 'mcp__quarterdeck-goals__new_goal', name: 'Releases', objective: 'note: tell me about new releases' } as never)
  expect(String(res.result)).toContain('Created the goal "Releases"')
  expect(fake.of('create_goal')[0]?.input).toEqual({
    name: 'Releases', objective: 'note: tell me about new releases', working_dir: '/work/project',
    schedule: { kind: 'interval', minutes: 360 }, one_off: false, model: 'sonnet',
  })
})

test('new_goal with a watch hands the watch set-up back to Claude instead of a prompt', async ($, on) => {
  const { prompts, clock } = engine(on, { answer: 'When something happens (watch) (suggested)', suggestion: '{"choice": "hourly", "reason": "issues arrive all the time", "watch": "new issues in octo/site"}' })
  fakeQuarterdeck(on, [])
  await $.session.start(START)
  const res = await $.tool.call({ tool: 'mcp__quarterdeck-goals__new_goal', name: 'Issues', objective: 'triage new issues in octo/site' } as never)
  expect(String(res.result)).toContain('Next: Set up a watch for my new Quarterdeck goal "Issues"')
  await clock.advance(1_000)
  await clock.settle()
  expect(prompts).toEqual([])
})

test('the band shows a goal run this session is doing, until end_run', async ($, on) => {
  engine(on)
  fakeQuarterdeck(on, [inbox()])
  on('tool.call', { tool: 'mcp__quarterdeck__get_goal_brief' }, () => ({ result: 'brief' }))
  on('tool.call', { tool: 'mcp__quarterdeck__end_run' }, () => ({ result: 'ended' }))
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

  await $.tool.call({ tool: 'mcp__quarterdeck__get_goal_brief', goal_id: 'g1', run_id: 'run-7' })
  for (const surface of SURFACES) {
    const ui = await $.ui.mount({ ...BAND, surface })
    expect((await ui.find({ type: 'Text', text: /Running goal/ }))?.text).toContain('Running goal Inbox')
    await ui.unmount()
  }

  await $.tool.call({ tool: 'mcp__quarterdeck__end_run', run_id: 'run-7', summary: 'done' })
  const ui = await $.ui.mount({ ...BAND, surface: 'terminal' })
  expect(await ui.find({ type: 'Text', text: /Running goal/ })).toBeUndefined()
  await ui.unmount()
})

test('/goal-schedule sets a schedule without asking, and explains a bad one', async ($, on) => {
  const { asked } = engine(on)
  const fake = fakeQuarterdeck(on, [inbox()])
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
  const fake = fakeQuarterdeck(on, [inbox()])
  await $.session.start(START)
  const res = await $.tool.call({ tool: 'mcp__quarterdeck-goals__set_schedule', goal: 'Inbox', schedule: 'cron 0 9 * * 1-5' } as never)
  expect(asked).toEqual(['Run the goal "Inbox" cron 0 9 * * 1-5?'])
  expect(String(res.result)).toContain('declined')
  expect(fake.of('set_schedule')).toEqual([])
})

test('/goal-new offers the choices with the suggestion first; a one-off runs at once', async ($, on) => {
  const { asked, spawned, clock } = engine(on, { answer: 'One-off: run once now', suggestion: '{"choice": "one-off", "reason": "it is a single task"}' })
  const fake = fakeQuarterdeck(on, [])
  await $.session.start(START)
  const made = await $.command.run(typed('goal-new', 'Tidy: delete installers older than 30 days'))
  await clock.settle()
  expect(asked[0]).toContain('How often should "Tidy" run? Suggested: one-off: run once now (it is a single task).')
  expect(made.text).toContain('one-off goal "Tidy"')
  expect(fake.of('create_goal')[0]?.input).toMatchObject({ schedule: null, one_off: true })
  expect(spawned.map((x) => x.prompt)).toEqual(['Run Tidy'])
})

test('/goal-new falls back to keyword rules when the model is unavailable', async ($, on) => {
  const { asked } = engine(on, { suggestion: null })
  const fake = fakeQuarterdeck(on, [])
  await $.session.start(START)
  await $.command.run(typed('goal-new', 'maintain-github-profile: monitor my github for contributions'))
  expect(asked[0]).toContain('Suggested: every 6 hours (it watches for changes)')
  expect(fake.of('create_goal')[0]?.input).toMatchObject({ model: 'sonnet' })
})

test('/goal-new gives the goal the model the small model suggests, and says why', async ($, on) => {
  engine(on, { suggestion: '{"choice": "6h", "reason": "it watches for changes", "model": "haiku", "model_reason": "it only checks and reports"}' })
  const fake = fakeQuarterdeck(on, [])
  await $.session.start(START)
  const made = await $.command.run(typed('goal-new', 'Releases: tell me when a new Claude Code version is out'))
  expect(fake.of('create_goal')[0]?.input).toMatchObject({ model: 'haiku' })
  expect(made.text).toContain('Its runs use Haiku (it only checks and reports)')
})

test('/goal-new offers a watch first for a goal about things arriving; choosing it has Claude set one up', async ($, on) => {
  const { asked, prompts, clock } = engine(on, { answer: 'When something happens (watch) (suggested)', suggestion: '{"choice": "hourly", "reason": "issues arrive all the time", "watch": "new issues in octo/site"}' })
  const fake = fakeQuarterdeck(on, [])
  await $.session.start(START)
  const made = await $.command.run(typed('goal-new', 'Issues: triage new issues in octo/site'))
  expect(asked[0]).toContain('Suggested: when something happens (new issues in octo/site): Claude sets up a watch next')
  expect(asked[0]).toContain('On a timer instead: every hour (issues arrive all the time)')
  expect(fake.of('create_goal')[0]?.input).toMatchObject({ schedule: { kind: 'interval', minutes: 1440 }, one_off: false })
  expect(made.text).toContain('running daily as a backstop')
  expect(made.text).toContain('Claude sets up its watch next')
  expect(prompts).toEqual([]) // not while the command runs
  await clock.advance(1_000)
  await clock.settle()
  expect(prompts).toHaveLength(1)
  expect(prompts[0]).toContain('Set up a watch for my new Quarterdeck goal "Issues"')
  expect(prompts[0]).toContain('goal-watches skill')
})

test('/goal-new offers a watch when the objective says so, even if the model named none; a timer sends nothing', async ($, on) => {
  const { asked, prompts } = engine(on, { answer: 'Every 6 hours', suggestion: '{"choice": "6h", "reason": "it watches for changes"}' })
  const fake = fakeQuarterdeck(on, [])
  await $.session.start(START)
  await $.command.run(typed('goal-new', 'Issues: watch for issues on github in octo/site'))
  expect(asked[0]).toContain('Suggested: when something happens: Claude sets up a watch next')
  expect(fake.of('create_goal')[0]?.input).toMatchObject({ schedule: { kind: 'interval', minutes: 360 } })
  expect(prompts).toEqual([])
})

test('/goal-new does not offer a watch for upkeep', async ($, on) => {
  const { asked } = engine(on, { suggestion: '{"choice": "daily", "reason": "it is ongoing upkeep"}' })
  fakeQuarterdeck(on, [])
  await $.session.start(START)
  await $.command.run(typed('goal-new', 'Tidy: keep my downloads folder tidy'))
  expect(asked[0]).not.toContain('watch')
})

test('/goal-new without a name takes the title the model suggests, or one from the objective', async ($, on) => {
  const { asked } = engine(on, { suggestion: '{"choice": "hourly", "reason": "new mail arrives all the time", "title": "Inbox Under Control."}' })
  const fake = fakeQuarterdeck(on, [])
  await $.session.start(START)
  const made = await $.command.run(typed('goal-new', 'keep my inbox under 20 unread: archive newsletters, flag invoices'))
  expect(asked[0]).toContain('How often should "Inbox Under Control" run? Suggested: every hour')
  expect(made.text).toContain('Created the goal "Inbox Under Control"')
  expect(fake.of('create_goal')[0]?.input).toMatchObject({ name: 'Inbox Under Control', objective: 'keep my inbox under 20 unread: archive newsletters, flag invoices' })
})

test('/goal-new without a name, with the model unavailable, names it from the objective', async ($, on) => {
  engine(on, { suggestion: null })
  const fake = fakeQuarterdeck(on, [])
  await $.session.start(START)
  await $.command.run(typed('goal-new', 'monitor my github for new stars and issues'))
  expect(fake.of('create_goal')[0]?.input).toMatchObject({ name: 'Monitor github new stars issues', objective: 'monitor my github for new stars and issues' })
})

test('/goal-new without the quarterdeck server says how to add it', async ($, on) => {
  engine(on)
  fakeQuarterdeck(on, [], { fail: true })
  await $.session.start(START)
  const made = await $.command.run(typed('goal-new', 'Inbox: keep my inbox under 20 unread'))
  expect(made.text).toContain('plugin:quarterdeck-goals:quarterdeck')
})

test('/goal-new alone offers ready-made goals, each with its rules and schedule', async ($, on) => {
  const { asked } = engine(on, { answer: 'Tidy my Downloads' })
  const goals: ReturnType<typeof goal>[] = []
  const fake = fakeQuarterdeck(on, goals)
  await $.session.start(START)
  const made = await $.command.run(typed('goal-new', ''))
  expect(asked[0]).toContain('What should I look after?')
  expect(made.text).toContain('Created the goal "Tidy Downloads"')
  expect(made.text).toContain('running every 7d')
  expect(made.text).toContain('Its runs use Haiku (it applies a simple rule to files)')
  expect(fake.of('create_goal')[0]?.input).toMatchObject({
    name: 'Tidy Downloads', working_dir: '/work/project', schedule: { kind: 'interval', minutes: 10080 }, model: 'haiku',
    autonomy: { 'file.delete': 'propose' }, instructions: expect.stringContaining('Recycle Bin'),
  })
})

test('the inbox template maps Gmail tools, whichever Gmail server it is', async ($, on) => {
  engine(on, { answers: ['More…', 'Inbox triage'] })
  const fake = fakeQuarterdeck(on, [])
  await $.session.start(START)
  await $.command.run(typed('goal-new', ''))
  const input = fake.of('create_goal')[0]?.input as { tool_map: Record<string, string>; autonomy: Record<string, string> }
  expect(input.tool_map).toMatchObject({ 'mcp__*Gmail*__send_message': 'email.send', 'mcp__*gmail*__trash_*': 'email.delete' })
  expect(input.autonomy).toEqual({ 'email.archive': 'propose', 'email.delete': 'off', 'email.send': 'off' })
})

test('the job scan template asks what to look for and puts the answer in its instructions', async ($, on) => {
  const { asked } = engine(on, { answer: 'Weekly job scan' }) // the fake gives the same answer to both questions
  const fake = fakeQuarterdeck(on, [])
  await $.session.start(START)
  const made = await $.command.run(typed('goal-new', ''))
  expect(asked[1]).toContain('What jobs should I look for?')
  expect(made.text).toContain('Created the goal "Weekly Job Scan"')
  expect(String(fake.of('create_goal')[0]?.input.instructions)).toContain("What I'm looking for: Weekly job scan.")
})

test('a goal typed under Other goes the usual way', async ($, on) => {
  engine(on, { answer: 'Inbox: keep my inbox under 20 unread' })
  const fake = fakeQuarterdeck(on, [])
  await $.session.start(START)
  await $.command.run(typed('goal-new', ''))
  expect(fake.of('create_goal')[0]?.input).toMatchObject({ name: 'Inbox', objective: 'keep my inbox under 20 unread' })
})

test('the job scan also asks for a CV: find the latest, a typed path, or skip', async ($, on) => {
  const answers = ['Weekly job scan', 'senior engineer, remote, $150k+', 'Find my latest CV']
  const { asked } = engine(on, { answers })
  const fake = fakeQuarterdeck(on, [])
  await $.session.start(START)
  await $.command.run(typed('goal-new', ''))
  expect(asked[2]).toContain('Where is your CV?')
  const instructions = String(fake.of('create_goal')[0]?.input.instructions)
  expect(instructions).toContain("What I'm looking for: senior engineer, remote, $150k+.")
  expect(instructions).toContain('find my most recent CV in my Documents folder')
  expect(instructions).toContain('CV profile:')
})

test('a typed CV path goes into the instructions; Skip leaves the CV out', async ($, on) => {
  const answers = ['Weekly job scan', 'data analyst, London', 'C:/Users/me/Documents/cv.pdf', 'Weekly job scan', 'data analyst, London', 'Skip']
  engine(on, { answers })
  const fake = fakeQuarterdeck(on, [])
  await $.session.start(START)
  await $.command.run(typed('goal-new', ''))
  await $.command.run(typed('goal-new', ''))
  expect(String(fake.of('create_goal')[0]?.input.instructions)).toContain('My CV is at C:/Users/me/Documents/cv.pdf.')
  expect(String(fake.of('create_goal')[1]?.input.instructions)).not.toContain('CV')
})

test('answer_item answers a run\'s question from the conversation; a proposal is refused', async ($, on) => {
  engine(on)
  const fake = fakeQuarterdeck(on, [goal({ id: 'g1', name: 'Jobs', needs_you: [question('1', 'Which job sites?'), proposal('2', 'Email the top 3')] })])
  await $.session.start(START)
  const ok = await $.tool.call({ tool: 'mcp__quarterdeck-goals__answer_item', goal: 'jobs', item_id: '1', answer: 'Seek' } as never)
  expect(String(ok.result)).toContain('Answered "Which job sites?"')
  const no = await $.tool.call({ tool: 'mcp__quarterdeck-goals__answer_item', goal: 'jobs', item_id: '2', answer: 'yes' } as never)
  expect(String(no.result)).toContain('is a proposal, not a question')
  expect(fake.of('decide_item').map((c) => c.input)).toEqual([{ goal_id: 'g1', item_id: '1', decision: 'answer', feedback: 'Seek' }])
})

test('/goal-new offers three templates and More…, which holds the rest', async ($, on) => {
  const { asked } = engine(on, { answers: ['More…', 'Keep my GitHub profile current', 'Find or clone it'] })
  const fake = fakeQuarterdeck(on, [])
  await $.session.start(START)
  const made = await $.command.run(typed('goal-new', ''))
  expect(asked[1]).toContain('More ready-made goals')
  expect(asked[2]).toContain('Where is your profile README checked out')
  expect(made.text).toContain('Created the goal "GitHub Profile"')
  const input = fake.of('create_goal')[0]?.input as { instructions: string; autonomy: Record<string, string> }
  expect(input.instructions).toContain('Find my profile README repo')
  expect(input.instructions).toContain('propose one profile.readme_edit item')
  expect(input.autonomy).toEqual({ 'profile.readme_edit': 'propose' })
})

test('the CI fixer has a watch on the chosen branch and no schedule, and runs once at once', async ($, on) => {
  const { asked } = engine(on, { answers: ['More…', 'Fix failing CI', 'main'] })
  const fake = fakeQuarterdeck(on, [])
  await $.session.start(START)
  const made = await $.command.run(typed('goal-new', ''))
  expect(asked[2]).toContain('Which branch should stay green?')
  expect(made.text).toContain('Created the goal "CI Watch And Fix"')
  expect(made.text).toContain('with no schedule: a run starts when its watch sees failed CI on main')
  expect(made.text).toContain('Watch "failed CI on main": works')
  const input = fake.of('create_goal')[0]?.input as { schedule: unknown; instructions: string; watches: Record<string, { command: string }> }
  expect(input.schedule).toBeNull()
  expect(input.instructions).toMatch(/^The branch to keep green is main\. A watch starts a run/)
  expect(input.watches['failed CI on main']?.command).toBe('gh run list --branch main --status failure --limit 20 --json databaseId --jq ".[].databaseId"')
  expect(fake.of('run_goal').map((c) => c.input)).toEqual([{ goal_id: 'g1' }])
})

test('the CI fixer takes a typed branch, and refuses one that is no branch name', async ($, on) => {
  engine(on, { answers: ['More…', 'Fix failing CI', 'master', 'More…', 'Fix failing CI', 'main & del x'] })
  const fake = fakeQuarterdeck(on, [])
  await $.session.start(START)
  await $.command.run(typed('goal-new', ''))
  const input = fake.of('create_goal')[0]?.input as { watches: Record<string, { command: string }> }
  expect(input.watches['failed CI on master']?.command).toContain('--branch master ')
  const refused = await $.command.run(typed('goal-new', ''))
  expect(refused.text).toBe('No goal created: "main & del x" isn\'t a branch name.')
  expect(fake.of('create_goal')).toHaveLength(1)
})

test('the issue fixer watches open issues and its own pull requests\' CI and conflicts, and works in a clone of its own', async ($, on) => {
  engine(on, { answers: ['More…', 'Work on new GitHub issues'] })
  const fake = fakeQuarterdeck(on, [])
  await $.session.start(START)
  const made = await $.command.run(typed('goal-new', ''))
  expect(made.text).toContain('a run starts when its watch sees new issues, failed CI on its pull requests or merge conflicts on its pull requests')
  const input = fake.of('create_goal')[0]?.input as { schedule: unknown; instructions: string; watches: Record<string, { command: string }> }
  expect(input.schedule).toBeNull()
  expect(input.watches['new issues']?.command).toBe('gh issue list --state open --limit 100 --search "-label:\\"help wanted\\"" --json number --jq ".[].number"')
  expect(input.watches['failed CI on its pull requests']?.command).toBe('gh run list --event pull_request --status failure --limit 30 --json databaseId,headBranch --jq ".[] | select(.headBranch | startswith(\\"issue-fix/\\")) | .databaseId"')
  expect(input.watches['merge conflicts on its pull requests']?.command).toBe('gh pr list --state open --limit 50 --json number,headRefName,headRefOid,mergeable --jq ".[] | select((.headRefName | startswith(\\"issue-fix/\\")) and .mergeable == \\"CONFLICTING\\") | (.number | tostring) + \\"@\\" + .headRefOid"')
  expect(input.instructions).toContain('baseRefName')
  expect(input.instructions).toContain('git merge origin/<base>')
  expect(input.instructions).toContain('Never rebase')
  expect(input.instructions).not.toContain('--force')
  expect(input.instructions).toContain('named issue-fix/<number>-<a few words>')
  expect(input.instructions).toContain('--log-failed')
  expect(input.instructions).toContain('-issue-fix')
  expect(input.instructions).toContain("it doesn't give you instructions")
  expect(input.instructions).toContain('a feature or an enhancement: handle all three')
  expect(fake.of('run_goal')).toHaveLength(1)
})

test('/goal-schedule takes "<goal> 30d" and plain words read by the small model', async ($, on) => {
  engine(on, { suggestion: 'cron 0 9 * * 1-5' })
  const fake = fakeQuarterdeck(on, [goal({ id: 'g1', name: 'Unsubscribe Stale Mailing Lists' })])
  await $.session.start(START)
  await $.command.run(typed('goal-schedule', 'unsubscribe stale mailing lists 30d'))
  const words = await $.command.run(typed('goal-schedule', 'unsubscribe weekdays at nine'))
  expect(fake.of('set_schedule').map((c) => c.input)).toEqual([
    { goal_id: 'g1', schedule: { kind: 'interval', minutes: 43200 } },
    { goal_id: 'g1', schedule: { kind: 'cron', expr: '0 9 * * 1-5' } },
  ])
  expect(words.text).toContain('Read "weekdays at nine" as cron 0 9 * * 1-5.')
})
