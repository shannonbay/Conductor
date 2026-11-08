/**
 * Tools Claude can call (listed as mcp__conductor-goals__<name>) and the
 * slash commands. Reading is free; anything that changes a goal on Claude's
 * behalf asks the person first.
 */
import type { EngineInterface } from 'claude-code'

import type { GoalCard } from '../types'
import { addTodo, approve, createGoal, fetchTodos, reject, runNow, setGoalStatus, setSchedule, setTodo, updateGoal } from './api'
import { ago, describe, describeGoalChanges, fallbackTitle, findGoal, noMatch, parseSchedule, SCHEDULE_USAGE, scheduleLabel, splitGoalArgs, summarize, type GoalChanges } from './model'
import { kick } from './runner'
import { askSchedule, suggestSchedule } from './schedule'
import { describeTodos, findTodo } from './todos'
import { act, refresh, refreshTodos } from './sync'
import { readLastAlert, readLastPoll, readTrace } from './alerts'

type $ = EngineInterface

const GOAL = { type: 'string', description: 'Goal name (or a unique part of it) or goal id.' }
const ITEM = { type: 'string', description: 'The item id, as goals_status lists it.' }

export const TOOLS = [
  {
    name: 'goals_status',
    description: "Lists the person's Conductor goals (persistent objectives run by scheduled agents): what waits for their approval (with item ids), whether a run is going, the last run and health. Read-only.",
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'goal_detail',
    description: "One Conductor goal in detail: objective, proposals, open items, recent runs with summaries, and its memory. Read-only.",
    inputSchema: { type: 'object', properties: { goal: GOAL }, required: ['goal'] },
  },
  {
    name: 'approve_item',
    description: 'Approves a Conductor proposal so the goal\'s next run carries it out. The person is asked to confirm first.',
    inputSchema: { type: 'object', properties: { goal: GOAL, item_id: ITEM }, required: ['goal', 'item_id'] },
  },
  {
    name: 'reject_item',
    description: "Rejects a Conductor proposal with feedback; the feedback is saved to the goal's memory so later runs learn from it. The person is asked to confirm first.",
    inputSchema: { type: 'object', properties: { goal: GOAL, item_id: ITEM, feedback: { type: 'string', description: 'What should change.' } }, required: ['goal', 'item_id', 'feedback'] },
  },
  {
    name: 'run_goal',
    description: 'Queues a run of a Conductor goal now. The person is asked to confirm first.',
    inputSchema: { type: 'object', properties: { goal: GOAL }, required: ['goal'] },
  },
  {
    name: 'todos',
    description: "The person's to-do lists for this project, with each open to-do's id. Read-only. Use it when they ask what's on their list, or refer to it after a compaction.",
    inputSchema: { type: 'object', properties: { include_done: { type: 'boolean', description: 'Also list ticked-off to-dos' } } },
  },
  {
    name: 'add_todo',
    description: "Adds a to-do to the person's list for this project, where it survives the conversation and shows in the Goals pane. Add what they ask you to; when an idea is clearly being put off for later, offer to add it rather than adding it unasked.",
    inputSchema: {
      type: 'object',
      properties: { text: { type: 'string', description: 'The to-do, short and in their words' }, list: { type: 'string', description: 'A list name or id; left out, the "To do" list' } },
      required: ['text'],
    },
  },
  {
    name: 'complete_todo',
    description: "Ticks a to-do off the person's list. Only when they say it's done or ask you to.",
    inputSchema: {
      type: 'object',
      properties: { item: { type: 'string', description: 'The to-do id from the todos tool, e.g. 3 or 1.4' }, list: { type: 'string', description: 'A list name or id, when more than one list has that id' } },
      required: ['item'],
    },
  },
  {
    name: 'update_goal',
    description: "Changes a Conductor goal: name, objective, standing instructions, autonomy per action category (off / propose / auto; null puts one back to the default, propose), tool rules (tool name pattern → category; null removes one), memory to add or forget (ids from goal_detail), or pause / resume. The person sees each change and is asked to confirm first. For the schedule use set_schedule.",
    inputSchema: {
      type: 'object',
      properties: {
        goal: GOAL,
        name: { type: 'string' },
        objective: { type: 'string' },
        instructions: { type: 'string', description: 'The new standing instructions in full; "" clears them' },
        autonomy: { type: 'object', additionalProperties: { type: ['string', 'null'], enum: ['off', 'propose', 'auto', null] } },
        tool_map: { type: 'object', additionalProperties: { type: ['string', 'null'] } },
        add_memory: {
          type: 'array',
          items: { type: 'object', properties: { kind: { type: 'string', enum: ['fact', 'rule', 'preference'] }, text: { type: 'string' }, pinned: { type: 'boolean' } }, required: ['kind', 'text'] },
        },
        forget_memory: { type: 'array', items: { type: 'string' }, description: 'Memory ids' },
        status: { type: 'string', enum: ['active', 'paused'] },
      },
      required: ['goal'],
    },
  },
  {
    name: 'set_schedule',
    description: 'Sets when a Conductor goal runs on its own, or "off" for on demand only. The person is asked to confirm first.',
    inputSchema: {
      type: 'object',
      properties: { goal: GOAL, schedule: { type: 'string', description: `One of: ${SCHEDULE_USAGE}` } },
      required: ['goal', 'schedule'],
    },
  },
] as const

export type ToolName = (typeof TOOLS)[number]['name']

export async function registerTools($: $): Promise<void> {
  for (const tool of TOOLS) {
    try {
      await $.tool.register({ name: tool.name, description: tool.description, inputSchema: tool.inputSchema })
    } catch {
      // The session isn't bound yet; the next start tries again.
    }
  }
}

type Resolved = { goal: GoalCard } | { error: string }

async function resolveGoal($: $, query: unknown): Promise<Resolved> {
  const s = await refresh($)
  if (!s.reachable) return { error: `Conductor isn't connected${s.error ? ` (${s.error})` : ''}. Check the conductor MCP server with /mcp.` }
  const found = findGoal(s.goals, typeof query === 'string' ? query : '')
  return 'goal' in found ? found : { error: noMatch(s.goals, String(query ?? ''), found.matches) }
}

/** Asks the person; a dismissed dialog counts as no. */
async function confirmWith($: $, question: string, yes: string): Promise<boolean> {
  try {
    return (await $.ui.ask(question, [yes, 'Cancel'])) === yes
  } catch {
    return false
  }
}

/** The text a tool call answers with. */
export async function runTool($: $, name: ToolName, input: Record<string, unknown>): Promise<{ text: string; isError: boolean }> {
  const now = await $.clock.now()
  const fail = (text: string) => ({ text, isError: true })

  if (name === 'todos' || name === 'add_todo' || name === 'complete_todo') return todoTool($, name, input)

  if (name === 'goals_status') {
    // Read the alert record first: the refresh below can raise an alert itself
    const lastAlert = await readLastAlert($)
    const lastPoll = await readLastPoll($)
    const traced = await readTrace($)
    const s = await refresh($)
    if (!s.reachable) return fail(`Conductor isn't connected${s.error ? ` (${s.error})` : ''}. Check the conductor MCP server with /mcp.`)
    const at = (ms: number) => `${new Date(ms).toISOString()}, ${ago(new Date(ms).toISOString(), now)}`
    const alert = lastAlert
      ? `\n\nLast alert (${at(lastAlert.at)}): ${lastAlert.text}. Notification: ${lastAlert.notify}. Phone: ${lastAlert.push}.`
      : ''
    const poll = lastPoll ? `\nLast background poll: ${at(lastPoll)}.` : '\nNo background poll recorded.'
    const checks = traced.length ? `\nAlert checks (oldest first):\n${traced.map((l) => `- ${l}`).join('\n')}` : ''
    return { text: summarize(s.goals, now) + alert + poll + checks, isError: false }
  }

  const found = await resolveGoal($, input.goal)
  if ('error' in found) return fail(found.error)
  const { goal } = found

  if (name === 'goal_detail') return { text: describe(goal, now), isError: false }

  if (name === 'update_goal') {
    // Only the change fields: the call also carries the engine's own (tool, tool_use_id)
    const keys = ['name', 'objective', 'instructions', 'autonomy', 'tool_map', 'add_memory', 'forget_memory', 'status'] as const
    const changes = Object.fromEntries(keys.filter((k) => input[k] !== undefined).map((k) => [k, input[k]])) as GoalChanges
    const lines = describeGoalChanges(goal, changes)
    if (lines.length === 0) return fail(`Nothing to change in ${goal.name}: give at least one new value.`)
    if (!(await confirmWith($, `Change the goal "${goal.name}"?\n${lines.map((l) => `• ${l}`).join('\n')}`, 'Apply changes'))) return fail('The person declined; the goal is unchanged.')
    let changed: string[] = []
    const ok = await act($, `update:${goal.id}`, 'change the goal', async () => {
      changed = await updateGoal($, goal.id, changes)
    })
    return ok ? { text: `Changed ${goal.name}: ${changed.join('; ') || 'nothing (already so)'}.`, isError: false } : fail("The change didn't go through; see the Goals pane.")
  }

  if (name === 'set_schedule') {
    const parsed = parseSchedule(String(input.schedule ?? ''))
    if ('error' in parsed) return fail(parsed.error)
    const label = parsed.oneOff ? 'once (one-off)' : scheduleLabel(parsed.schedule)
    if (!(await confirmWith($, `Run the goal "${goal.name}" ${label}?`, 'Set schedule'))) return fail('The person declined; the schedule is unchanged.')
    return { text: await applySchedule($, goal, parsed.schedule, parsed.oneOff), isError: false }
  }

  if (name === 'run_goal') {
    if (goal.openRun) return fail(`${goal.name} already has a run ${goal.openRun.status}.`)
    if (!(await confirmWith($, `Start a run of the goal "${goal.name}" now?`, 'Run it'))) return fail('The person declined; nothing was started.')
    return (await act($, `run:${goal.id}`, 'start the run', () => runNow($, goal.id)))
      ? { text: `Queued a run of ${goal.name}.`, isError: false }
      : fail(`The run didn't start.`)
  }

  const item = goal.needsYou.find((i) => i.id === String(input.item_id ?? ''))
  if (!item) {
    const waiting = goal.needsYou.map((i) => `${i.id} (${i.title})`).join(', ')
    return fail(`No proposal ${String(input.item_id)} waits in ${goal.name}.${waiting ? ` Waiting: ${waiting}.` : ' Nothing is waiting.'}`)
  }
  const key = `${goal.id}/${item.id}`

  if (name === 'approve_item') {
    const what = `"${item.title}"${item.summary ? ` (${item.summary})` : ''}`
    if (!(await confirmWith($, `Approve ${what} for the goal "${goal.name}"?`, 'Approve'))) return fail('The person declined; nothing was approved.')
    return (await act($, `approve:${key}`, 'approve', () => approve($, goal.id, item.id)))
      ? { text: `Approved "${item.title}". ${goal.name}'s next run will carry it out.`, isError: false }
      : fail('The approval failed; see the Goals pane.')
  }

  const feedback = String(input.feedback ?? '').trim()
  if (!feedback) return fail('Feedback is required to reject a proposal.')
  if (!(await confirmWith($, `Reject "${item.title}" for "${goal.name}" with this feedback: "${feedback}"?`, 'Reject'))) return fail('The person declined; nothing was rejected.')
  return (await act($, `reject:${key}`, 'reject', () => reject($, goal.id, item.id, feedback)))
    ? { text: `Rejected "${item.title}"; the feedback is saved to ${goal.name}'s memory.`, isError: false }
    : fail('The rejection failed; see the Goals pane.')
}

export const COMMANDS = [
  { name: 'goals', description: 'Show Conductor goals in a pane' },
  { name: 'goal-run', description: 'Run a Conductor goal now', argumentHint: '<goal>' },
  { name: 'goal-new', description: 'Create a Conductor goal in this directory (it suggests a title and a schedule)', argumentHint: '<objective> | <name>: <objective>' },
  { name: 'goal-pause', description: 'Pause a Conductor goal', argumentHint: '<goal>' },
  { name: 'goal-resume', description: 'Resume a paused Conductor goal', argumentHint: '<goal>' },
  { name: 'todo', description: 'Your to-do list for this project: /todo <text> adds, /todo done <id> ticks off, /todo shows it', argumentHint: '<text> | done <id>' },
  { name: 'goal-schedule', description: 'Set when a Conductor goal runs on its own', argumentHint: '<goal> every 6h | cron ... | off' },
] as const

export async function registerCommands($: $): Promise<void> {
  for (const c of COMMANDS) await $.command.register(c)
}

/** /goal-run, /goal-pause, /goal-resume: the person typed it, so no confirm. */
export async function goalCommand($: $, command: 'goal-run' | 'goal-pause' | 'goal-resume', args: string): Promise<string> {
  if (!args.trim()) {
    const s = await refresh($)
    return `Usage: /${command} <goal>. Goals: ${s.goals.map((g) => g.name).join(', ') || 'none'}.`
  }
  const found = await resolveGoal($, args)
  if ('error' in found) return found.error
  const { goal } = found
  const ok = (done: boolean, text: string) => (done ? text : `That didn't work; see the Goals pane.`)

  if (command === 'goal-run') {
    if (goal.openRun) return `${goal.name} already has a run ${goal.openRun.status}.`
    return ok(await act($, `run:${goal.id}`, 'start the run', () => runNow($, goal.id)), `Queued a run of ${goal.name}.`)
  }
  const status = command === 'goal-pause' ? 'paused' : 'active'
  if (goal.status === status) return `${goal.name} is already ${status}.`
  return ok(await act($, `${command}:${goal.id}`, `${command === 'goal-pause' ? 'pause' : 'resume'} the goal`, () => setGoalStatus($, goal.id, status)), `${goal.name} is ${status === 'paused' ? 'paused' : 'active again'}.`)
}

/**
 * /goal-new <objective> (a title is suggested) or /goal-new <name>: <objective>.
 * Asks how often it runs, with a suggestion first.
 */
export async function newGoal($: $, args: string): Promise<string> {
  const { name: given, objective } = splitGoalArgs(args)
  if (!objective) return 'Usage: /goal-new <objective>, e.g. /goal-new keep my inbox under 20 unread (or /goal-new <name>: <objective>)'
  const cwd = await $.session.root()
  const suggestion = await suggestSchedule($, given, objective)
  const name = given ?? suggestion.title ?? fallbackTitle(objective)
  const choice = await askSchedule($, name, suggestion)
  let created
  try {
    created = await createGoal($, { name, objective, working_dir: cwd, schedule: choice.schedule, one_off: choice.oneOff })
  } catch (err) {
    return `Couldn't create the goal: ${err instanceof Error ? err.message : String(err)}`
  }
  await kick($) // a new interval or a one-off has a run due now
  await refresh($)
  const where = `in ${cwd}`
  if (choice.oneOff) return `Created the one-off goal "${name}" ${where}. It runs now and moves to Done when it finishes.`
  if (!choice.schedule) return `Created the goal "${name}" ${where}. It runs when you start it (/goal-run); give it a schedule any time with /goal-schedule.`
  return `Created the goal "${name}" ${where}, running ${scheduleLabel(choice.schedule)}; the first run starts within a minute.`
}

/** Sets the schedule through the pane's action wrapper and says what happens next. */
async function applySchedule($: $, goal: GoalCard, schedule: Parameters<typeof setSchedule>[2], oneOff = false): Promise<string> {
  let next: string | null = null
  const done = await act($, `schedule:${goal.id}`, 'set the schedule', async () => {
    next = (await setSchedule($, goal.id, schedule, oneOff)).next_run_at
  })
  if (!done) return "That didn't work; see the Goals pane."
  if (oneOff) return `${goal.name} is a one-off now: run it with /goal-run; it moves to Done when a run leaves nothing open.`
  if (!schedule) return `${goal.name} now runs only on demand (/goal-run).`
  const now = await $.clock.now()
  const when = !next || Date.parse(next) <= now + 60_000 ? 'the next run starts within a minute' : `next run ${ago(next, now)}`
  return `${goal.name} runs ${scheduleLabel(schedule)}; ${when}.`
}

/** /goal-schedule <goal> <every …|cron …|off>: the person typed it, so no confirm. */
export async function scheduleCommand($: $, args: string): Promise<string> {
  const m = /^(.*?)\s+((?:every|cron)\s.*|off|manual|none|one-?off|once)$/i.exec(args.trim())
  if (!m || !m[1]!.trim()) return `Usage: /goal-schedule <goal> ${SCHEDULE_USAGE}. E.g. /goal-schedule inbox every 6h`
  const parsed = parseSchedule(m[2]!)
  if ('error' in parsed) return parsed.error
  const found = await resolveGoal($, m[1]!.trim())
  if ('error' in found) return found.error
  return applySchedule($, found.goal, parsed.schedule, parsed.oneOff)
}

/** The to-do tools: no confirm, since the person asked and every change is undone with one press. */
async function todoTool($: $, name: 'todos' | 'add_todo' | 'complete_todo', input: Record<string, unknown>): Promise<{ text: string; isError: boolean }> {
  const dir = await $.session.root()
  const lists = await fetchTodos($, dir)
  const listArg = typeof input.list === 'string' && input.list.trim() ? input.list.trim() : undefined
  if (name === 'todos') return { text: describeTodos(lists, { withDone: input.include_done === true }), isError: false }
  if (name === 'add_todo') {
    const text = String(input.text ?? '').trim()
    if (!text) return { text: 'A to-do needs some text.', isError: true }
    const list = listArg ? lists.find((l) => l.id === listArg || l.name.toLowerCase() === listArg.toLowerCase()) : undefined
    if (listArg && !list) return { text: `No list "${listArg}". Lists: ${lists.map((l) => l.name).join(', ') || 'none'}.`, isError: true }
    const r = await addTodo($, { dir, text, listId: list?.id, by: 'agent' })
    await refreshTodos($)
    return { text: `Added to ${list?.name ?? 'To do'} as ${r.item_id}: ${text}`, isError: false }
  }
  const found = findTodo(lists, String(input.item ?? ''), listArg)
  if ('error' in found) return { text: found.error, isError: true }
  await setTodo($, found.list.id, found.item.id, 'completed')
  await refreshTodos($)
  return { text: `Ticked off ${found.item.id}: ${found.item.text}`, isError: false }
}
