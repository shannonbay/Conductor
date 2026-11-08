/**
 * The person's to-do lists: what was agreed in a conversation, kept outside
 * it so it survives compaction. A list is an active plan in the project's
 * directory; /todo and add_todo add to the "To do" list. Nothing is added to
 * the conversation unless someone asks: no hooks, no reminders.
 */
import type { EngineInterface } from 'claude-code'

import type { TodoItem, TodoList } from '../types'
import { addTodo, createGoal, fetchTodos, setTodo } from './api'
import { clip } from './model'
import { kick } from './runner'
import { act, refresh, refreshTodos } from './sync'

type $ = EngineInterface

const isDone = (i: TodoItem) => i.status === 'completed' || i.status === 'abandoned'

/** The lists as text for Claude: each open to-do with the id to tick it off by. */
export function describeTodos(lists: TodoList[], opts: { withDone?: boolean } = {}): string {
  if (lists.length === 0) return 'No to-do lists for this project yet. Add one with /todo <text> (or the add_todo tool).'
  return lists.map((l) => {
    const items = l.items.filter((i) => opts.withDone || !isDone(i))
    const lines = items.map((i) => `${'  '.repeat(i.depth)}- [${isDone(i) ? 'x' : i.status === 'active' ? '~' : ' '}] ${i.id}: ${i.text}${i.notes ? ` (${i.notes})` : ''}`)
    return [`## ${l.name} (list ${l.id}): ${l.open} open, ${l.done} done`, ...(lines.length ? lines : ['  nothing open'])].join('\n')
  }).join('\n\n')
}

/** Finds a to-do by its id, in the given list or the only list that has it. */
export function findTodo(lists: TodoList[], itemId: string, listId?: string): { list: TodoList; item: TodoItem } | { error: string } {
  const matches = lists.filter((l) => !listId || l.id === listId || l.name.toLowerCase() === listId.toLowerCase())
    .flatMap((l) => l.items.filter((i) => i.id === itemId).map((item) => ({ list: l, item })))
  if (matches.length === 1) return matches[0]!
  if (matches.length === 0) return { error: `No to-do ${itemId}${listId ? ` in ${listId}` : ''}.` }
  return { error: `More than one list has a to-do ${itemId}: ${matches.map((m) => m.list.name).join(', ')}. Say which list.` }
}

/** /todo <text> adds; /todo done <id> ticks off; /todo alone shows the lists. */
export async function todoCommand($: $, args: string): Promise<string> {
  const dir = await $.session.cwd()
  const text = args.trim()
  if (!text) {
    const lists = await fetchTodos($, dir)
    return describeTodos(lists)
  }
  const done = /^(done|undo)\s+(\S+)$/i.exec(text)
  if (done) {
    const found = findTodo(await fetchTodos($, dir), done[2]!)
    if ('error' in found) return found.error
    const status = done[1]!.toLowerCase() === 'done' ? 'completed' : 'pending'
    await setTodo($, found.list.id, found.item.id, status)
    await refresh($)
    return `${status === 'completed' ? 'Ticked off' : 'Back on the list'}: ${found.item.text}`
  }
  const r = await addTodo($, { dir, text })
  await refreshTodos($)
  return `Added to your to-do list (${r.item_id}): ${text}`
}

/** Do it: hands a to-do to a one-off goal that runs now in the background. */
export async function doTodo($: $, dir: string, list: TodoList, item: TodoItem): Promise<void> {
  const created = await createGoal($, {
    name: clip(item.text, 48),
    objective: `${item.text}\n\n(From the to-do list "${list.name}", item ${item.id}. When it's done, say so in end_run; the person ticks it off.)`,
    working_dir: dir,
    one_off: true,
  })
  await setTodo($, list.id, item.id, 'active', `Running as a one-off goal (${created.id})`)
  await kick($)
}

/** The pane's actions, through the shared busy/notice/re-read wrapper. */
export function toggleTodo($: $, list: TodoList, item: TodoItem): Promise<boolean> {
  return act($, `todo:${list.id}/${item.id}`, 'update the to-do', () => setTodo($, list.id, item.id, isDone(item) ? 'pending' : 'completed'))
}
export function addFromPane($: $, dir: string, list: TodoList, text: string): Promise<boolean> {
  return act($, `todo-add:${list.id}`, 'add the to-do', async () => void (await addTodo($, { dir, text, listId: list.id })))
}
export function doTodoFromPane($: $, dir: string, list: TodoList, item: TodoItem): Promise<boolean> {
  return act($, `todo-do:${list.id}/${item.id}`, 'start it', () => doTodo($, dir, list, item))
}
