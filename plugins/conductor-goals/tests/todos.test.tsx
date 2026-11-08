import { expect, test } from 'claude-code/testing'

import { engine, fakeConductor, PANE, START, SURFACES } from './fixtures'

const roadmap = () => ({
  id: 'p1',
  name: 'Goals roadmap',
  items: [
    { id: '1.1', text: 'Approvals away from the terminal', status: 'pending', depth: 0, notes: null },
    { id: '1.2', text: 'Runs with Claude Code closed', status: 'completed', depth: 0, notes: null },
    { id: '1.3', text: 'Set autonomy from Claude Code', status: 'pending', depth: 0, notes: null },
  ],
})

const typed = (command: string, args: string) => ({ command, args, origin: { kind: 'person' } }) as never

test('the pane shows each list collapsed, then its open to-dos with tick and Do it', async ($, on) => {
  engine(on)
  fakeConductor(on, [], { todos: [roadmap()] })
  await $.session.start(START)
  for (const surface of SURFACES) {
    const ui = await $.ui.mount({ ...PANE, surface })
    expect((await ui.find({ key: 'todo-toggle-p1' }))?.props.label).toBe('▸ Goals roadmap (2 to do)')
    expect(await ui.find({ key: 'todo-tick-p1/1.1' })).toBeUndefined()
    await ui.press({ key: 'todo-toggle-p1' })
    expect((await ui.find({ key: 'todo-tick-p1/1.1' }))?.props.label).toContain('☐ 1.1 Approvals away from the terminal')
    expect(await ui.find({ key: 'todo-tick-p1/1.2' })).toBeUndefined()
    expect(await ui.find({ type: 'Text', text: /1 done/ })).toBeDefined()
    await ui.press({ key: 'todo-toggle-p1' })
    await ui.unmount()
  }
})

test('ticking, adding and Do it from the pane', async ($, on) => {
  const { spawned, clock } = engine(on)
  const fake = fakeConductor(on, [], { todos: [roadmap()] })
  await $.session.start(START)
  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  await ui.press({ key: 'todo-toggle-p1' })

  await ui.press({ key: 'todo-tick-p1/1.1' })
  expect(fake.of('todo_set').at(-1)?.input).toEqual({ list_id: 'p1', item_id: '1.1', status: 'completed' })
  expect(await ui.find({ key: 'todo-tick-p1/1.1' })).toBeUndefined()

  await ui.input({ key: 'todo-add-p1', text: 'Goal templates' })
  expect(fake.of('todo_add').at(-1)?.input).toEqual({ working_dir: '/work/project', text: 'Goal templates', added_by: 'human', list_id: 'p1' })
  expect(await ui.find({ key: 'todo-tick-p1/4' })).toBeDefined()

  await ui.press({ key: 'todo-do-p1/1.3' })
  await clock.settle()
  expect(fake.of('create_goal').at(-1)?.input).toMatchObject({ name: 'Set autonomy from Claude Code', one_off: true, working_dir: '/work/project' })
  expect(fake.of('todo_set').at(-1)?.input).toMatchObject({ list_id: 'p1', item_id: '1.3', status: 'active' })
  expect(spawned.map((x) => x.prompt)).toEqual(['Run Set autonomy from Claude Code'])
  expect((await ui.find({ key: 'todo-tick-p1/1.3' }))?.props.label).toContain('◐ 1.3 ')
  await ui.unmount()
})

test('/todo adds to the To do list, /todo done ticks off, /todo alone lists', async ($, on) => {
  engine(on)
  const fake = fakeConductor(on, [], { todos: [roadmap()] })
  await $.session.start(START)
  const added = await $.command.run(typed('todo', 'Try it on my phone'))
  expect(added.text).toBe('Added to your to-do list (1): Try it on my phone')
  expect(fake.lists[0]).toMatchObject({ name: 'To do', items: [expect.objectContaining({ text: 'Try it on my phone' })] })
  const listed = await $.command.run(typed('todo', ''))
  expect(listed.text).toContain('## To do')
  expect(listed.text).toContain('- [ ] 1.3: Set autonomy from Claude Code')
  expect(listed.text).not.toContain('Runs with Claude Code closed')
  const ticked = await $.command.run(typed('todo', 'done 1.3'))
  expect(ticked.text).toBe('Ticked off: Set autonomy from Claude Code')
  const missing = await $.command.run(typed('todo', 'done 9.9'))
  expect(missing.text).toContain('No to-do 9.9')
})

test("Claude's to-do tools: list, add (as the agent), tick off", async ($, on) => {
  engine(on)
  const fake = fakeConductor(on, [], { todos: [roadmap()] })
  await $.session.start(START)
  const listed = await $.tool.call({ tool: 'mcp__conductor-goals__todos' } as never)
  expect(String(listed.result)).toContain('1.1: Approvals away from the terminal')
  const added = await $.tool.call({ tool: 'mcp__conductor-goals__add_todo', text: 'Rename the package', list: 'goals roadmap' } as never)
  expect(String(added.result)).toBe('Added to Goals roadmap as 4: Rename the package')
  expect(fake.of('todo_add').at(-1)?.input).toMatchObject({ added_by: 'agent', list_id: 'p1' })
  const done = await $.tool.call({ tool: 'mcp__conductor-goals__complete_todo', item: '1.1' } as never)
  expect(String(done.result)).toBe('Ticked off 1.1: Approvals away from the terminal')
  const nope = await $.tool.call({ tool: 'mcp__conductor-goals__add_todo', text: 'x', list: 'nowhere' } as never)
  expect(String(nope.result)).toContain('No list "nowhere"')
})
