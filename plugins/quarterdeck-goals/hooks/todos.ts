/**
 * The person's to-do lists: what was agreed in a conversation, kept outside
 * it so it survives compaction. A list is an active plan in the project's
 * directory; /todo and add_todo add to the "To do" list. Nothing is added to
 * the conversation unless someone asks: no hooks, no reminders. Plan and
 * Start bring a to-do into the conversation as a prompt.
 */
import type { EngineInterface } from 'claude-code'

import type { TodoItem, TodoList } from '../types'
import { addTodo, editTodo, fetchTodos, setTodo } from './api'
import { clip } from './model'
import { act, refresh, refreshTodos } from './sync'
import { setAskingAbout, setEditingTodo } from './state'

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
  const dir = await $.session.root()
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

/**
 * The prompt that brings a to-do into this conversation. Plan asks Claude to
 * plan it in plan mode for the person to review; Start asks it to begin. Work
 * on a to-do happens here, where Claude can ask questions, not in a
 * background run (background runs are for goals).
 */
export function todoPrompt(list: TodoList, item: TodoItem, mode: 'plan' | 'start' | 'ask', question?: string): string {
  if (mode === 'ask' && question?.trim()) {
    return `About to-do ${item.id} on my list "${list.name}":\n\n${item.text}${item.notes ? `\n\n(Notes: ${item.notes})` : ''}\n\nMy question: ${question.trim()}\n\nAnswer it. Don't change anything or start work on it.`
  }
  if (mode === 'ask') {
    return `What do you think of to-do ${item.id} on my list "${list.name}"?\n\n${item.text}${item.notes ? `\n\n(Notes: ${item.notes})` : ''}\n\nGive me your opinion and the trade-offs. Don't change anything or start work on it.`
  }
  const from = `From my to-do list "${list.name}", item ${item.id}:\n\n${item.text}${item.notes ? `\n\n(Notes: ${item.notes})` : ''}`
  const end = `When it's done, tick it off with complete_todo (item ${item.id}${list.name !== 'To do' ? `, list "${list.name}"` : ''}).`
  return mode === 'plan'
    ? `${from}\n\nEnter plan mode and plan this before changing anything: explore what it involves, ask me what you need to, and present the plan for me to review. ${end}`
    : `${from}\n\nLet's work on this now. Ask me if anything is unclear. ${end}`
}

/** Plan / Start: marks the to-do under way and sends it to this conversation (it starts when Claude is free). */
export async function workOnTodo($: $, list: TodoList, item: TodoItem, mode: 'plan' | 'start'): Promise<void> {
  await setTodo($, list.id, item.id, 'active', mode === 'plan' ? 'Planning it in the conversation' : 'Working on it in the conversation')
  await $.prompt.submit({ text: todoPrompt(list, item, mode) })
}

/**
 * Ask: the person's question about a to-do (typed in the pane's box), or
 * Claude's opinion when they leave it empty. Nothing is changed or started.
 */
export async function askAboutTodo($: $, list: TodoList, item: TodoItem, question?: string): Promise<void> {
  await $.prompt.submit({ text: todoPrompt(list, item, 'ask', question) })
}

/** The pane's actions, through the shared busy/notice/re-read wrapper. */
export async function toggleTodo($: $, list: TodoList, item: TodoItem): Promise<boolean> {
  const ticking = !isDone(item)
  const ok = await act($, `todo:${list.id}/${item.id}`, 'update the to-do', () => setTodo($, list.id, item.id, ticking ? 'completed' : 'pending'))
  if (ok) $.ui.toast(ticking ? `Ticked off ${item.id}. To undo, open "done" under ${list.name} and press it.` : `${item.id} is back on ${list.name}.`)
  return ok
}
export function addFromPane($: $, dir: string, list: TodoList, text: string): Promise<boolean> {
  return act($, `todo-add:${list.id}`, 'add the to-do', async () => void (await addTodo($, { dir, text, listId: list.id })))
}
/** Sends the question and closes the box. */
export async function askFromPane($: $, list: TodoList, item: TodoItem, question: string): Promise<boolean> {
  const ok = await act($, `todo-ask:${list.id}/${item.id}`, 'ask about it', () => askAboutTodo($, list, item, question))
  if (ok) await setAskingAbout($, null)
  return ok
}
/** Saves the new wording from the pane's edit box and closes it; the toast keeps the old wording. */
export async function editFromPane($: $, list: TodoList, item: TodoItem, text: string): Promise<boolean> {
  const wording = text.trim()
  if (!wording || wording === item.text) {
    await setEditingTodo($, null)
    return true
  }
  const ok = await act($, `todo-edit:${list.id}/${item.id}`, 'change the to-do', () => editTodo($, list.id, item.id, { text: wording, by: 'human' }))
  if (ok) {
    await setEditingTodo($, null)
    $.ui.toast(`Changed ${item.id}. It said: ${clip(item.text, 80)}`)
  }
  return ok
}
export function workFromPane($: $, list: TodoList, item: TodoItem, mode: 'plan' | 'start'): Promise<boolean> {
  return act($, `todo-${mode}:${list.id}/${item.id}`, mode === 'plan' ? 'plan it' : 'start it', () => workOnTodo($, list, item, mode))
}
