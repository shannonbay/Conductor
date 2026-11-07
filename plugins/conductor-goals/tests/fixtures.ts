/**
 * A stand-in for the Conductor web app and the engine nouns the plugin uses,
 * shared by the tests. The fake keeps goals in memory and records requests.
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

export type Request = { method: string; path: string; body?: string; headers?: Record<string, string> }

/** The fake web app. `fail` makes every request throw (offline). */
export function fakeConductor(on: On, goals: FakeGoal[], opts: { fail?: boolean; errors?: Record<string, [number, string]> } = {}) {
  const requests: Request[] = []
  let version = 0
  const etag = () => `"v${version}"`
  const json = (status: number, data: unknown, headers: Record<string, string> = {}) =>
    ({ value: { status, ok: status < 300, headers, text: data === null ? '' : JSON.stringify(data) } })

  on('http.fetch', (_, e) => {
    if (opts.fail) throw new Error('connect ECONNREFUSED 127.0.0.1:3000')
    const method = e.init?.method ?? 'GET'
    const url = new URL(e.url)
    const path = url.pathname
    requests.push({ method, path, body: e.init?.body, headers: e.init?.headers })
    const error = opts.errors?.[`${method} ${path}`]
    if (error) return json(error[0], { error: error[1] })
    const byId = (id: string) => goals.find((g) => g.id === decodeURIComponent(id))
    let m: RegExpMatchArray | null

    if (method === 'GET' && path === '/api/goals/overview') {
      if (e.init?.headers?.['If-None-Match'] === etag()) return json(304, null, { ETag: etag() })
      const body = goals.map((g) => ({ ...g, open_item_count: g.open_items.length }))
      return json(200, { goals: body }, { ETag: etag() })
    }
    if (method === 'POST' && (m = path.match(/^\/api\/plans\/([^/]+)\/tasks\/([^/]+)\/(approve|reject)$/))) {
      const g = byId(m[1]!)!
      g.needs_you = g.needs_you.filter((t) => t.id !== m![2])
      version++
      return json(200, {})
    }
    if ((m = path.match(/^\/api\/goals\/([^/]+)\/run$/))) {
      const g = byId(m[1]!)!
      g.open_run = method === 'POST' ? { id: 'r-new', status: 'queued' } : null
      version++
      return json(method === 'POST' ? 202 : 200, {})
    }
    if (method === 'PATCH' && (m = path.match(/^\/api\/goals\/([^/]+)$/))) {
      byId(m[1]!)!.status = JSON.parse(e.init!.body!).status
      version++
      return json(200, {})
    }
    if (method === 'DELETE' && (m = path.match(/^\/api\/goals\/([^/]+)\/memory\/([^/]+)$/))) {
      const g = byId(m[1]!)!
      g.memory = g.memory.filter((x) => x.id !== m![2])
      version++
      return json(200, {})
    }
    if (method === 'POST' && path === '/api/goals') {
      const input = JSON.parse(e.init!.body!)
      goals.push(goal({ id: `g${goals.length + 1}`, name: input.name, objective: input.objective }))
      version++
      return json(201, { id: `g${goals.length}` })
    }
    return json(404, { error: 'not found' })
  })

  return {
    requests,
    /** Call after changing `goals` directly, as the web app's ETag would change. */
    bump: () => {
      version++
    },
  }
}

/** Answers the engine nouns the plugin calls; records what it shows. */
export function engine(on: On, opts: { answer?: string } = {}) {
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
  return { toasts, notifications, statuses, asked, clock }
}

export const START = { cwd: '/work/project', surface: 'terminal', isInteractive: true } as const
