/**
 * The person's to-do lists (core/src/todos.ts): what was agreed in a
 * conversation, kept outside it so it survives compaction. Shown in the
 * Goals pane; Claude adds to them when asked.
 */
import { todoLists, addTodo, setTodo } from '../db.js'
import { TodoListSchema, TodoAddSchema, TodoSetSchema } from '../schema.js'
import { record } from '../history.js'

export async function todo_list(args: unknown) {
  const input = TodoListSchema.parse(args)
  return { lists: todoLists(input.working_dir) }
}

export async function todo_add(args: unknown) {
  const input = TodoAddSchema.parse(args)
  const r = addTodo({ workingDir: input.working_dir, text: input.text, listId: input.list_id, by: input.added_by })
  record(r.listId, r.itemId, 'task_created', { goal: input.text, status: 'pending', todo: true }, { actor: input.added_by, via: 'todo' })
  return { list_id: r.listId, item_id: r.itemId, created_list: r.created }
}

export async function todo_set(args: unknown) {
  const input = TodoSetSchema.parse(args)
  const item = setTodo(input.list_id, input.item_id, input.status, input.notes)
  record(input.list_id, input.item_id, 'status_changed', { to: input.status, todo: true }, { actor: 'human', via: 'todo' })
  return { item }
}
