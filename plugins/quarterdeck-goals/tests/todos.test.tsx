import { expect, test } from 'claude-code/testing'

import { engine, fakeQuarterdeck, PANE, START, SURFACES } from './fixtures'

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

test('the pane shows each list collapsed, then its open to-dos with a tick and their ids', async ($, on) => {
  engine(on)
  fakeQuarterdeck(on, [], { todos: [roadmap()] })
  await $.session.start(START)
  for (const surface of SURFACES) {
    const ui = await $.ui.mount({ ...PANE, surface })
    expect((await ui.find({ key: 'todo-toggle-p1' }))?.props.label).toBe('▸ Goals roadmap (2 to do)')
    expect(await ui.find({ key: 'todo-open-p1/1.1' })).toBeUndefined()
    await ui.press({ key: 'todo-toggle-p1' })
    expect((await ui.find({ key: 'todo-open-p1/1.1' }))?.props.label).toBe('1.1 Approvals away from the terminal')
    expect((await ui.find({ key: 'todo-tick-p1/1.1' }))?.props.label).toBe('☐')
    expect(await ui.find({ key: 'todo-open-p1/1.2' })).toBeUndefined()
    expect((await ui.find({ key: 'todo-done-toggle-p1' }))?.props.label).toBe('  ▸ 1 done')
    await ui.press({ key: 'todo-toggle-p1' })
    await ui.unmount()
  }
})

test('pressing a to-do expands it; Plan and Start send it to this conversation', async ($, on) => {
  const { prompts } = engine(on)
  const fake = fakeQuarterdeck(on, [], { todos: [roadmap()] })
  await $.session.start(START)
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  await ui.press({ key: 'todo-toggle-p1' })
  await ui.press({ key: 'todo-open-p1/1.3' })
  expect(await ui.find({ type: 'Text', text: /Set autonomy from Claude Code$/ })).toBeDefined()
  expect(fake.of('todo_set')).toEqual([]) // pressing the text changes nothing

  await ui.press({ key: 'todo-plan-p1/1.3' })
  expect(prompts).toHaveLength(1)
  expect(prompts[0]).toContain('From my to-do list "Goals roadmap", item 1.3:\n\nSet autonomy from Claude Code')
  expect(prompts[0]).toContain('Enter plan mode and plan this')
  expect(prompts[0]).toContain('complete_todo (item 1.3, list "Goals roadmap")')
  expect(fake.of('todo_set').at(-1)?.input).toEqual({ list_id: 'p1', item_id: '1.3', status: 'active', notes: 'Planning it in the conversation' })
  expect(fake.of('create_goal')).toEqual([]) // no background run

  await ui.press({ key: 'todo-start-p1/1.3' })
  expect(prompts[1]).toContain("Let's work on this now")
  await ui.unmount()
})

test('ticking says how to undo; done to-dos can be put back; adding works', async ($, on) => {
  const { toasts } = engine(on)
  const fake = fakeQuarterdeck(on, [], { todos: [roadmap()] })
  await $.session.start(START)
  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  await ui.press({ key: 'todo-toggle-p1' })

  await ui.press({ key: 'todo-tick-p1/1.1' })
  expect(fake.of('todo_set').at(-1)?.input).toEqual({ list_id: 'p1', item_id: '1.1', status: 'completed' })
  expect(toasts.at(-1)).toBe('Ticked off 1.1. To undo, open "done" under Goals roadmap and press it.')
  expect(await ui.find({ key: 'todo-open-p1/1.1' })).toBeUndefined()

  await ui.press({ key: 'todo-done-toggle-p1' })
  expect((await ui.find({ key: 'todo-untick-p1/1.1' }))?.props.label).toContain('☑ 1.1 Approvals away from the terminal')
  await ui.press({ key: 'todo-untick-p1/1.1' })
  expect(fake.of('todo_set').at(-1)?.input).toEqual({ list_id: 'p1', item_id: '1.1', status: 'pending' })
  expect(await ui.find({ key: 'todo-open-p1/1.1' })).toBeDefined()

  expect(await ui.find({ key: 'todo-add-p1' })).toBeUndefined() // closed until + Add is pressed
  await ui.press({ key: 'todo-addbtn-p1' })
  expect((await ui.find({ key: 'todo-add-p1' }))?.props).toMatchObject({ autoFocus: true, placeholder: 'type it, then Enter' })
  await ui.input({ key: 'todo-add-p1', text: 'Goal templates' })
  expect(fake.of('todo_add').at(-1)?.input).toEqual({ working_dir: '/work/project', text: 'Goal templates', added_by: 'human', list_id: 'p1' })
  expect(await ui.find({ key: 'todo-open-p1/4' })).toBeDefined()
  expect(await ui.find({ key: 'todo-add-p1' })).toBeUndefined() // closes after adding
  await ui.press({ key: 'todo-addbtn-p1' })
  await ui.press({ key: 'todo-add-cancel-p1' })
  expect(await ui.find({ key: 'todo-add-p1' })).toBeUndefined()
  await ui.unmount()
})

test('/todo adds to the To do list, /todo done ticks off, /todo alone lists', async ($, on) => {
  engine(on)
  const fake = fakeQuarterdeck(on, [], { todos: [roadmap()] })
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
  const fake = fakeQuarterdeck(on, [], { todos: [roadmap()] })
  await $.session.start(START)
  const listed = await $.tool.call({ tool: 'mcp__quarterdeck-goals__todos' } as never)
  expect(String(listed.result)).toContain('1.1: Approvals away from the terminal')
  const added = await $.tool.call({ tool: 'mcp__quarterdeck-goals__add_todo', text: 'Rename the package', list: 'goals roadmap' } as never)
  expect(String(added.result)).toBe('Added to Goals roadmap as 4: Rename the package')
  expect(fake.of('todo_add').at(-1)?.input).toMatchObject({ added_by: 'agent', list_id: 'p1' })
  const done = await $.tool.call({ tool: 'mcp__quarterdeck-goals__complete_todo', item: '1.1' } as never)
  expect(String(done.result)).toBe('Ticked off 1.1: Approvals away from the terminal')
  const nope = await $.tool.call({ tool: 'mcp__quarterdeck-goals__add_todo', text: 'x', list: 'nowhere' } as never)
  expect(String(nope.result)).toContain('No list "nowhere"')
})

test("edit_todo rewords a to-do as the agent and shows the old wording", async ($, on) => {
  const { toasts } = engine(on)
  const fake = fakeQuarterdeck(on, [], { todos: [roadmap()] })
  await $.session.start(START)
  const r = await $.tool.call({ tool: 'mcp__quarterdeck-goals__edit_todo', item: '1.3', text: 'Set autonomy from the pane' } as never)
  expect(String(r.result)).toBe('Reworded 1.3: Set autonomy from the pane (it said: Set autonomy from Claude Code)')
  expect(fake.of('todo_set').at(-1)?.input).toMatchObject({ list_id: 'p1', item_id: '1.3', text: 'Set autonomy from the pane', changed_by: 'agent' })
  expect(fake.of('todo_set').at(-1)?.input).not.toHaveProperty('status')
  expect(toasts.at(-1)).toContain('It said: Set autonomy from Claude Code')
  const empty = await $.tool.call({ tool: 'mcp__quarterdeck-goals__edit_todo', item: '1.3', text: '  ' } as never)
  expect(String(empty.result)).toContain('needs some text')
})

test('Edit opens a box holding the to-do; Save rewords it, Cancel and unchanged text change nothing', async ($, on) => {
  const { toasts } = engine(on)
  const fake = fakeQuarterdeck(on, [], { todos: [roadmap()] })
  await $.session.start(START)
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  await ui.press({ key: 'todo-toggle-p1' })
  await ui.press({ key: 'todo-open-p1/1.3' })

  await ui.press({ key: 'todo-edit-p1/1.3' })
  expect((await ui.find({ key: 'todo-edit-input-p1/1.3' }))?.props).toMatchObject({ autoFocus: true, value: 'Set autonomy from Claude Code' })
  await ui.press({ key: 'todo-edit-cancel-p1/1.3' })
  expect(await ui.find({ key: 'todo-edit-input-p1/1.3' })).toBeUndefined()

  await ui.press({ key: 'todo-edit-p1/1.3' })
  await ui.input({ key: 'todo-edit-input-p1/1.3', text: 'Set autonomy from Claude Code' })
  expect(fake.of('todo_set')).toHaveLength(0)

  await ui.press({ key: 'todo-edit-p1/1.3' })
  await ui.input({ key: 'todo-edit-input-p1/1.3', text: 'Set autonomy from the pane ' })
  expect(fake.of('todo_set').at(-1)?.input).toMatchObject({ text: 'Set autonomy from the pane', changed_by: 'human' })
  expect(toasts.at(-1)).toContain('It said: Set autonomy from Claude Code')
  expect(await ui.find({ key: 'todo-edit-input-p1/1.3' })).toBeUndefined()
  expect((await ui.find({ key: 'todo-open-p1/1.3' }))?.props.label).toBeDefined()
  await ui.unmount()
})

test('Ask opens a box for a question; empty asks for an opinion; Cancel sends nothing', async ($, on) => {
  const { prompts } = engine(on)
  const fake = fakeQuarterdeck(on, [], { todos: [roadmap()] })
  await $.session.start(START)
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  await ui.press({ key: 'todo-toggle-p1' })
  await ui.press({ key: 'todo-open-p1/1.3' })

  expect(await ui.find({ key: 'todo-ask-input-p1/1.3' })).toBeUndefined()
  await ui.press({ key: 'todo-ask-p1/1.3' })
  expect(prompts).toEqual([]) // nothing sent until the question is
  expect((await ui.find({ key: 'todo-ask-input-p1/1.3' }))?.props).toMatchObject({ autoFocus: true, label: 'Your question' })
  await ui.input({ key: 'todo-ask-input-p1/1.3', text: 'Is this worth doing before 1.6' })
  expect(prompts).toHaveLength(1)
  expect(prompts[0]).toContain('About to-do 1.3 on my list "Goals roadmap":')
  expect(prompts[0]).toContain('Set autonomy from Claude Code')
  expect(prompts[0]).toContain('My question: Is this worth doing before 1.6')
  expect(prompts[0]).toContain("Don't change anything or start work on it.")
  expect(fake.of('todo_set')).toEqual([]) // asking isn't starting
  expect(await ui.find({ key: 'todo-ask-input-p1/1.3' })).toBeUndefined() // closes after sending

  await ui.press({ key: 'todo-ask-p1/1.3' })
  await ui.input({ key: 'todo-ask-input-p1/1.3', text: '' })
  expect(prompts).toHaveLength(2)
  expect(prompts[1]).toContain('What do you think of to-do 1.3 on my list "Goals roadmap"?')

  await ui.press({ key: 'todo-ask-p1/1.3' })
  await ui.press({ key: 'todo-ask-cancel-p1/1.3' })
  expect(await ui.find({ key: 'todo-ask-input-p1/1.3' })).toBeUndefined()
  expect(prompts).toHaveLength(2)
  await ui.unmount()
})
