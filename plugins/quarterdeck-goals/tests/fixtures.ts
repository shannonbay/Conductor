/**
 * A stand-in for the quarterdeck MCP server and the engine nouns the plugin
 * uses, shared by the tests. The fake keeps goals in memory and records calls.
 */
import { mock } from 'claude-code/testing'
import type { On } from 'claude-code'

export const NOW = Date.parse('2026-11-07T08:00:00Z')

export const PANE = {
  plugin: 'quarterdeck-goals',
  component: 'Pane',
  requestId: 'quarterdeck-goals',
  props: {
    title: 'Goals',
    isFocused: false,
    bodyColumns: 60,
    placement: 'dock',
    scroll: { offset: 0, bodyRows: 40 },
    view: {},
  },
} as const

export const BAND = {
  plugin: 'quarterdeck-goals',
  component: 'AbovePrompt',
  props: { hasSurvey: false, isWorking: true, maxRows: 4, bodyColumns: 100, scroll: { offset: 0, bodyRows: 4 }, view: {} },
} as const

export const SURFACES = ['terminal', 'desktop'] as const

type Item = { id: string; goal: string; action?: { category: string; summary: string } | null; asks_person?: boolean }
type FakeGoal = {
  id: string
  name: string
  objective: string
  status: string
  one_off?: boolean
  model?: string | null
  instructions?: string
  autonomy?: Record<string, string>
  tool_map?: Record<string, string>
  next_run_at: string | null
  schedule: { kind: 'interval'; minutes: number; active_hours?: string } | { kind: 'cron'; expr: string } | null
  open_run: { id: string; status: string } | null
  activity: { state: 'running' | 'queued' | 'paused' | 'idle'; text: string; at: string | null; waiting?: { tool: string; since: string } }
  runs: { id: string; status: string; trigger: string; summary: string | null; started_at: string; ended_at: string | null; agent_id?: string | null; model?: string | null; untrusted?: string | null }[]
  needs_you: Item[]
  open_items: Item[]
  health: { passed: boolean; value: number | null }[]
  memory: { id: string; kind: string; text: string; pinned: boolean; untrusted?: string | null }[]
  suggestions: { category: string; approved_in_a_row: number }[]
  watches?: { name: string; every_minutes: number; runs: string; last_fired_at: string | null; failing: boolean; error: string | null }[]
}

export function goal(over: Partial<FakeGoal> & { id: string; name: string }): FakeGoal {
  return {
    objective: `${over.name} objective`,
    status: 'active',
    next_run_at: '2026-11-07T09:00:00Z',
    schedule: { kind: 'interval', minutes: 60 },
    open_run: null,
    activity: { state: 'idle', text: 'Waiting for its first run', at: null },
    runs: [],
    needs_you: [],
    open_items: [],
    health: [],
    memory: [],
    suggestions: [],
    ...over,
  }
}

export function proposal(id: string, title: string): Item {
  return { id, goal: title, action: { category: 'email.send', summary: `Send: ${title}` } }
}

/** A run's question or request for the person (add_item with ask_person). */
export function question(id: string, title: string): Item {
  return { id, goal: title, action: null, asks_person: true } as Item
}

export type Call = { tool: string; input: Record<string, unknown> }

const TOOLS = [
  'goals_overview', 'decide_item', 'run_goal', 'cancel_run', 'set_goal_status', 'delete_memory', 'trust_memory', 'create_goal',
  'goals_tick', 'attach_agent', 'fail_run', 'guard_check', 'set_schedule', 'todo_list', 'todo_add', 'todo_set', 'update_goal', 'delete_goal', 'watch_report',
] as const

/**
 * The fake `quarterdeck` MCP server. `fail` makes every call fail as if the
 * server were missing; `errors` makes one tool answer an error. Records calls.
 */
type FakeTodoList = { id: string; name: string; items: { id: string; text: string; status: string; depth: number; notes: string | null }[] }

export function fakeQuarterdeck(on: On, goals: FakeGoal[], opts: { fail?: boolean; errors?: Record<string, string>; todos?: FakeTodoList[]; hold?: { until: string; reason: string }; outdated?: boolean; standing?: boolean; update?: { installed: string; latest: string }; prefix?: string; /** Tool watches the next pass hands out, once. A report with text for watch `w-<goal id>` queues that goal's run. */ toolWatches?: { watch_id: string; goal_id: string; name: string; tool: string; input: Record<string, unknown> }[] } = {}) {
  const prefix = opts.prefix ?? 'mcp__quarterdeck__'
  const lists: FakeTodoList[] = opts.todos ?? []
  const listView = () => lists.map((l) => {
    const done = l.items.filter((i) => i.status === 'completed').length
    return { ...l, open: l.items.length - done, done }
  })
  const calls: Call[] = []
  let version = 0
  let runs = 0
  const etag = () => `"v${version}"`
  const ok = (data: unknown) => ({ result: JSON.stringify(data) })
  const byId = (id: unknown) => goals.find((g) => g.id === id)
  /** Runs that ended through fail_run, by id. */
  const ended: Record<string, string> = {}

  for (const name of TOOLS) {
    on('tool.call', { tool: `${prefix}${name}` as `mcp__quarterdeck__${string}` }, (_, e) => {
      // Record only the plugin's own arguments, not the fields the engine sets on every call
      const { tool: _t, tool_use_id: _u, agentId: _a, ...input } = e as unknown as Record<string, unknown>
      if (opts.fail) throw new Error(`$.tool.call: no tool named "${prefix}${name}" in this session`)
      calls.push({ tool: name, input })
      const error = opts.errors?.[name]
      if (error) return { result: `Error: ${error}`, isError: true } as never
      const g = byId(input.goal_id)
      switch (name) {
        case 'goals_overview':
          if (input.etag === etag()) return ok({ changed: false, etag: etag() }) as never
          return ok({ changed: true, etag: etag(), goals: goals.map((x) => ({ ...x, open_item_count: x.open_items.length })), hold: opts.hold ?? null, ...(opts.outdated ? { outdated: true } : {}), ...(opts.standing ? { standing: true } : {}), ...(opts.update ? { update: opts.update } : {}) }) as never
        case 'delete_goal': {
          const at = goals.findIndex((x) => x.id === input.goal_id)
          if (at >= 0) goals.splice(at, 1)
          version++
          return ok({ deleted: input.goal_id }) as never
        }
        case 'decide_item':
          g!.needs_you = g!.needs_you.filter((t) => t.id !== input.item_id)
          version++
          return ok({ item: { id: input.item_id }, queued_run: null }) as never
        case 'run_goal':
          if (g!.status === 'retired' && g!.one_off) g!.status = 'active' // a done one-off runs again
          g!.open_run = { id: `r${++runs}`, status: 'queued' }
          version++
          return ok({ run: g!.open_run }) as never
        case 'cancel_run': {
          const id = g!.open_run?.id
          g!.open_run = null
          version++
          return ok({ cancelled: id, agent_id: null }) as never
        }
        case 'set_goal_status':
          g!.status = String(input.status)
          version++
          return ok({ goal_id: g!.id, status: g!.status }) as never
        case 'delete_memory':
          g!.memory = g!.memory.filter((x) => x.id !== input.memory_id)
          version++
          return ok({ deleted: input.memory_id }) as never
        case 'trust_memory':
          g!.memory = g!.memory.map((x) => x.id === input.memory_id ? { ...x, untrusted: null } : x)
          version++
          return ok({ trusted: input.memory_id }) as never
        case 'create_goal': {
          const schedule = (input.schedule ?? null) as FakeGoal['schedule']
          const oneOff = input.one_off === true
          const made = goal({
            id: `g${goals.length + 1}`, name: String(input.name), objective: String(input.objective), schedule, one_off: oneOff,
            ...(input.instructions !== undefined && { instructions: String(input.instructions) }),
            ...(input.autonomy !== undefined && { autonomy: input.autonomy as Record<string, string> }),
            ...(input.tool_map !== undefined && { tool_map: input.tool_map as Record<string, string> }),
            ...(input.model !== undefined && { model: input.model as string | null }),
            next_run_at: schedule ? new Date(NOW).toISOString() : null,
            open_run: oneOff ? { id: `r${++runs}`, status: 'queued' } : null,
          })
          goals.push(made)
          version++
          return ok({ id: made.id, next_run_at: made.next_run_at, one_off: oneOff, queued_run: made.open_run?.id ?? null }) as never
        }
        case 'goals_tick': {
          if (input.release) return ok({ released: true }) as never
          const claimed = goals.filter((x) => x.open_run?.status === 'queued').map((x) => {
            x.open_run = { id: x.open_run!.id, status: 'running' }
            return { run_id: x.open_run.id, goal_id: x.id, name: x.name, working_dir: '/work/project', trigger: 'manual', max_run_minutes: 15, model: x.model ?? null, prompt: `Run ${x.name}` }
          })
          if (claimed.length) version++
          const due = input.tool_watches === true ? (opts.toolWatches ?? []).splice(0) : []
          return ok({ leader: true, claimed, expired: [], ...(due.length ? { tool_watches: due } : {}) }) as never
        }
        case 'watch_report': {
          // As the server does: an answer with text is something new, and queues the goal's run
          const watched = goals.find((x) => `w-${x.id}` === input.watch_id)
          const fresh = typeof input.text === 'string' && watched !== undefined && !watched.open_run
          if (fresh) {
            watched!.open_run = { id: `r${++runs}`, status: 'queued' }
            version++
          }
          return ok({ watch_id: input.watch_id, queued_run: fresh ? watched!.open_run!.id : null }) as never
        }
        case 'attach_agent':
          return ok(input) as never
        case 'fail_run': {
          const run = goals.find((x) => x.open_run?.id === input.run_id)
          if (run) {
            run.open_run = null
            ended[String(input.run_id)] = String(input.status ?? 'failed')
            version++
          }
          return ok({ run_id: input.run_id, changed: Boolean(run) }) as never
        }
        case 'set_schedule': {
          g!.schedule = (input.schedule ?? null) as FakeGoal['schedule']
          g!.one_off = input.one_off === true && !g!.schedule
          g!.next_run_at = g!.schedule ? (g!.schedule.kind === 'interval' ? new Date(NOW).toISOString() : '2026-11-08T09:00:00Z') : null
          version++
          return ok({ goal_id: g!.id, schedule: g!.schedule, next_run_at: g!.next_run_at }) as never
        }
        case 'update_goal': {
          const changed: string[] = []
          for (const [cat, mode] of Object.entries((input.autonomy ?? {}) as Record<string, string | null>)) {
            g!.autonomy = { ...g!.autonomy }
            if (mode === null) delete g!.autonomy[cat]
            else g!.autonomy[cat] = mode
            changed.push(`${cat}: ${mode ?? 'back to propose'}`)
          }
          if (input.status) { g!.status = String(input.status); changed.push(String(input.status)) }
          if (input.model !== undefined) { g!.model = (input.model as string | null) ?? null; changed.push(`runs use ${g!.model ?? "the session's model"}`) }
          // As the server does: each new watch is checked once, and the answer says how that went
          const checked: { name: string; result: string }[] = []
          for (const [name, w] of Object.entries((input.watches ?? {}) as Record<string, { command: string; every_minutes?: number } | null>)) {
            const rest = (g!.watches ?? []).filter((x) => x.name !== name)
            if (w === null) { g!.watches = rest; changed.push(`watch "${name}" removed`); continue }
            g!.watches = [...rest, { name, every_minutes: w.every_minutes ?? 5, runs: w.command, last_fired_at: null, failing: false, error: null }]
            changed.push(`watch "${name}" added: every ${w.every_minutes ?? 5} min, runs ${w.command}`)
            checked.push({ name, result: 'works: 3 items there now; a run starts when a new one appears' })
          }
          version++
          return ok({ goal_id: g!.id, changed, ...(checked.length ? { watches: checked } : {}) }) as never
        }
        case 'todo_list':
          return ok({ lists: listView() }) as never
        case 'todo_add': {
          let list = input.list_id ? lists.find((l) => l.id === input.list_id) : lists.find((l) => l.name === 'To do')
          if (!list) lists.unshift(list = { id: `list${lists.length + 1}`, name: 'To do', items: [] })
          const id = String(list.items.length + 1)
          list.items.push({ id, text: String(input.text), status: 'pending', depth: 0, notes: null })
          return ok({ list_id: list.id, item_id: id, created_list: false }) as never
        }
        case 'todo_set': {
          const item = lists.find((l) => l.id === input.list_id)!.items.find((i) => i.id === input.item_id)!
          if (input.status !== undefined) item.status = String(input.status)
          if (typeof input.notes === 'string') item.notes = input.notes
          if (typeof input.text === 'string') item.text = input.text
          return ok({ item }) as never
        }
        case 'guard_check':
          return ok(input.tool_name === 'mcp__gmail__delete'
            ? { decision: 'deny', category: 'email.delete', reason: 'email.delete is off for this goal' }
            : input.tool_name === 'mcp__gmail__send' ? { decision: 'allow', category: 'email.send' } : { decision: 'allow' }) as never
      }
    })
  }

  return {
    calls,
    lists,
    /** Calls of one tool, in order. */
    of: (tool: string) => calls.filter((c) => c.tool === tool),
    ended,
    /** Call after changing `goals` directly, as the server's etag would change. */
    bump: () => {
      version++
    },
  }
}

/** Answers the engine nouns the plugin calls; records what it shows. */
export function engine(on: On, opts: { answer?: string; answers?: string[]; guarded?: boolean; suggestion?: string | null; /** The person is at the terminal: Claude Code drops phone pushes. */ present?: boolean; /** Why no push can go out: no Remote Control, or mobile push off. */ phone?: 'no_transport' | 'config_off' } = {}) {
  const toasts: string[] = []
  const notifications: string[] = []
  const statuses: (string | undefined)[] = []
  const asked: string[] = []
  const clock = mock.clock(on, { now: NOW })
  mock.store(on)
  on('command.register', (_, e) => ({ value: { command: e.name } }))
  on('tool.register', (_, e) => ({ value: { tool: `mcp__quarterdeck-goals__${e.name}` } }))
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('session.cwd', () => ({ value: '/work/project/web' })) // the shell has cd'd into a subfolder
  on('session.root', () => ({ value: '/work/project' })) // the project root: goals and to-do lists use this
  on('ui.toast', (_, e) => {
    toasts.push(e.text)
    return { value: undefined }
  })
  on('ui.notify', (_, e) => {
    notifications.push(e.text)
    return { value: { isSent: true, channel: 'terminal_bell' } }
  })
  // Claude Code's phone push (sent only while Remote Control is connected and the person is away)
  const pushes: string[] = []
  on('tool.call', { tool: 'PushNotification' }, (_, e) => {
    const message = String((e as unknown as { message: string }).message)
    if (opts.phone) return { result: { message, disabledReason: opts.phone } } as never
    if (opts.present) return { result: { message, disabledReason: 'user_present' } } as never
    pushes.push(message)
    return { result: { message: 'sent', pushSent: true } } as never
  })
  on('ui.status', (_, e) => {
    statuses.push(e.text)
    return { value: undefined }
  })
  // $.ui.ask is a call of the AskUserQuestion tool; answer it as the person would.
  on('tool.call', { tool: 'AskUserQuestion' }, (_, e) => {
    const question = e.questions[0]!.question
    asked.push(question)
    // `answers` are given in order, one per question; otherwise `answer` to every one
    const answer = opts.answers ? (opts.answers[asked.length - 1] ?? 'Cancel') : (opts.answer ?? 'Cancel')
    return { result: { questions: e.questions, answers: { [question]: answer } } }
  })
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('session.id', () => ({ value: 'session-1' }))
  // Prompts the plugin sends into the conversation
  const prompts: string[] = []
  on('prompt.submit', (_, e) => {
    prompts.push(e.text)
    return { text: e.text }
  })
  // The prompt box: what the person has typed so far, and what plugins add to it
  const box = { draft: '' }
  on('prompt.read', () => ({ value: { text: box.draft, cursor: box.draft.length } }) as never)
  on('prompt.fill', (_, e) => {
    box.draft = e.mode === 'append' ? box.draft + e.text : e.text
    return { isFilled: true, text: box.draft, cursor: box.draft.length } as never
  })
  // The small model that suggests schedules: a JSON answer, or (null) unavailable
  const suggestion = opts.suggestion === undefined ? '{"choice": "daily", "reason": "it is ongoing upkeep"}' : opts.suggestion
  const usage = { input_tokens: 10, output_tokens: 10, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 }
  on('model.complete', () => ({
    value: suggestion === null ? { isAnswered: false, reason: 'api-error', status: 500, error: 'api_error', usage } : { isAnswered: true, text: suggestion, usage },
  }) as never)
  // The guard plugin's tool: present unless a test says otherwise
  const GUARD = { name: 'mcp__quarterdeck-guard__status', description: 'guarded' }
  let tools = opts.guarded === false ? [] : [GUARD]
  on('tool.list', () => ({ value: tools }) as never)
  // Subagents: spawned ones are listed as running until a test ends them
  const agents: { id: string; description: string; type: string; status: string }[] = []
  const spawned: { prompt: string; subagentType?: string; cwd?: string; model?: string }[] = []
  const stopped: string[] = []
  on('agent.register', (_, e) => ({ value: { agent: `quarterdeck-goals:${e.name}` } }))
  on('agent.list', () => ({ value: agents.map((a) => ({ ...a })) }) as never)
  on('agent.spawn', (_, e) => {
    const agentId = `agent-${spawned.length + 1}`
    spawned.push({ prompt: e.prompt, subagentType: e.subagentType, cwd: e.cwd, ...(e.model !== undefined && { model: e.model }) })
    agents.push({ id: agentId, description: e.description, type: e.subagentType, status: 'running' })
    return { model: 'test-model', agentId }
  })
  on('tool.call', { tool: 'TaskStop' }, (_, e) => {
    const id = String((e as unknown as { task_id: string }).task_id)
    stopped.push(id)
    const a = agents.find((x) => x.id === id)
    if (a) a.status = 'killed'
    return { result: { message: `stopped ${id}` } } as never
  })
  return {
    toasts, notifications, pushes, statuses, asked, clock, agents, spawned, stopped, prompts, box,
    /** Loads or unloads the guard plugin (its status tool). */
    setGuarded: (on: boolean) => {
      tools = on ? [GUARD] : []
    },
    /** Ends a spawned agent as if it finished its work. */
    finish: (agentId: string) => {
      const a = agents.find((x) => x.id === agentId)
      if (a) a.status = 'completed'
    },
  }
}

export const START = { cwd: '/work/project', surface: 'terminal', isInteractive: true } as const
