/**
 * A stand-in for the conductor MCP server and the engine nouns the plugin
 * uses, shared by the tests. The fake keeps goals in memory and records calls.
 */
import { mock } from 'claude-code/testing'
import type { On } from 'claude-code'

export const NOW = Date.parse('2026-11-07T08:00:00Z')

export const PANE = {
  plugin: 'conductor-goals',
  component: 'Pane',
  requestId: 'conductor-goals',
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
  plugin: 'conductor-goals',
  component: 'AbovePrompt',
  props: { hasSurvey: false, isWorking: true, maxRows: 4, bodyColumns: 100, scroll: { offset: 0, bodyRows: 4 }, view: {} },
} as const

export const SURFACES = ['terminal', 'desktop'] as const

type Item = { id: string; goal: string; action?: { category: string; summary: string } | null }
type FakeGoal = {
  id: string
  name: string
  objective: string
  status: string
  next_run_at: string | null
  open_run: { id: string; status: string } | null
  activity: { state: 'running' | 'queued' | 'paused' | 'idle'; text: string; at: string | null }
  runs: { id: string; status: string; trigger: string; summary: string | null; started_at: string; ended_at: string | null }[]
  needs_you: Item[]
  open_items: Item[]
  health: { passed: boolean; value: number | null }[]
  memory: { id: string; kind: string; text: string; pinned: boolean }[]
  suggestions: { category: string; approved_in_a_row: number }[]
}

export function goal(over: Partial<FakeGoal> & { id: string; name: string }): FakeGoal {
  return {
    objective: `${over.name} objective`,
    status: 'active',
    next_run_at: '2026-11-07T09:00:00Z',
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

export type Call = { tool: string; input: Record<string, unknown> }

const TOOLS = [
  'goals_overview', 'decide_item', 'run_goal', 'cancel_run', 'set_goal_status', 'delete_memory', 'create_goal',
  'goals_tick', 'attach_agent', 'fail_run', 'guard_check',
] as const

/**
 * The fake `conductor` MCP server. `fail` makes every call fail as if the
 * server were missing; `errors` makes one tool answer an error. Records calls.
 */
export function fakeConductor(on: On, goals: FakeGoal[], opts: { fail?: boolean; errors?: Record<string, string> } = {}) {
  const calls: Call[] = []
  let version = 0
  let runs = 0
  const etag = () => `"v${version}"`
  const ok = (data: unknown) => ({ result: JSON.stringify(data) })
  const byId = (id: unknown) => goals.find((g) => g.id === id)
  /** Runs that ended through fail_run, by id. */
  const ended: Record<string, string> = {}

  for (const name of TOOLS) {
    on('tool.call', { tool: `mcp__conductor__${name}` }, (_, e) => {
      // Record only the plugin's own arguments, not the fields the engine sets on every call
      const { tool: _t, tool_use_id: _u, agentId: _a, ...input } = e as unknown as Record<string, unknown>
      if (opts.fail) throw new Error('No such tool available: mcp__conductor__' + name)
      calls.push({ tool: name, input })
      const error = opts.errors?.[name]
      if (error) return { result: `Error: ${error}`, isError: true } as never
      const g = byId(input.goal_id)
      switch (name) {
        case 'goals_overview':
          if (input.etag === etag()) return ok({ changed: false, etag: etag() }) as never
          return ok({ changed: true, etag: etag(), goals: goals.map((x) => ({ ...x, open_item_count: x.open_items.length })) }) as never
        case 'decide_item':
          g!.needs_you = g!.needs_you.filter((t) => t.id !== input.item_id)
          version++
          return ok({ item: { id: input.item_id }, queued_run: null }) as never
        case 'run_goal':
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
        case 'create_goal':
          goals.push(goal({ id: `g${goals.length + 1}`, name: String(input.name), objective: String(input.objective) }))
          version++
          return ok({ id: `g${goals.length}` }) as never
        case 'goals_tick': {
          if (input.release) return ok({ released: true }) as never
          const claimed = goals.filter((x) => x.open_run?.status === 'queued').map((x) => {
            x.open_run = { id: x.open_run!.id, status: 'running' }
            return { run_id: x.open_run.id, goal_id: x.id, name: x.name, working_dir: '/work/project', trigger: 'manual', max_run_minutes: 15, prompt: `Run ${x.name}` }
          })
          if (claimed.length) version++
          return ok({ leader: true, claimed, expired: [] }) as never
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
        case 'guard_check':
          return ok(input.tool_name === 'mcp__gmail__delete'
            ? { decision: 'deny', category: 'email.delete', reason: 'email.delete is off for this goal' }
            : input.tool_name === 'mcp__gmail__send' ? { decision: 'allow', category: 'email.send' } : { decision: 'allow' }) as never
      }
    })
  }

  return {
    calls,
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
export function engine(on: On, opts: { answer?: string; guarded?: boolean } = {}) {
  const toasts: string[] = []
  const notifications: string[] = []
  const statuses: (string | undefined)[] = []
  const asked: string[] = []
  const clock = mock.clock(on, { now: NOW })
  mock.store(on)
  on('command.register', (_, e) => ({ value: { command: e.name } }))
  on('tool.register', (_, e) => ({ value: { tool: `mcp__conductor-goals__${e.name}` } }))
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('session.cwd', () => ({ value: '/work/project' }))
  on('ui.toast', (_, e) => {
    toasts.push(e.text)
    return { value: undefined }
  })
  on('ui.notify', (_, e) => {
    notifications.push(e.text)
    return { value: { isSent: true, channel: 'terminal_bell' } }
  })
  on('ui.status', (_, e) => {
    statuses.push(e.text)
    return { value: undefined }
  })
  // $.ui.ask is a call of the AskUserQuestion tool; answer it as the person would.
  on('tool.call', { tool: 'AskUserQuestion' }, (_, e) => {
    const question = e.questions[0]!.question
    asked.push(question)
    return { result: { questions: e.questions, answers: { [question]: opts.answer ?? 'Cancel' } } }
  })
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('session.id', () => ({ value: 'session-1' }))
  // The guard plugin's tool: present unless a test says otherwise
  const GUARD = { name: 'mcp__conductor-goals-guard__status', description: 'guarded' }
  let tools = opts.guarded === false ? [] : [GUARD]
  on('tool.list', () => ({ value: tools }) as never)
  // Subagents: spawned ones are listed as running until a test ends them
  const agents: { id: string; description: string; type: string; status: string }[] = []
  const spawned: { prompt: string; subagentType?: string; cwd?: string }[] = []
  const stopped: string[] = []
  on('agent.register', (_, e) => ({ value: { agent: `conductor-goals:${e.name}` } }))
  on('agent.list', () => ({ value: agents.map((a) => ({ ...a })) }) as never)
  on('agent.spawn', (_, e) => {
    const agentId = `agent-${spawned.length + 1}`
    spawned.push({ prompt: e.prompt, subagentType: e.subagentType, cwd: e.cwd })
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
    toasts, notifications, statuses, asked, clock, agents, spawned, stopped,
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
