import { expect, mock, test } from 'claude-code/testing'
import type { On } from 'claude-code'

const PANE = {
  plugin: 'conductor-goals',
  component: 'Pane',
  requestId: 'conductor-goals',
  props: {
    title: 'Goals',
    isFocused: false,
    bodyColumns: 60,
    placement: 'dock',
    scroll: { offset: 0, bodyRows: 30 },
    view: {},
  },
} as const

const NOW = Date.parse('2026-11-07T08:00:00Z')

function detail(needsYou: { id: string; goal: string }[], runs: object[] = []) {
  return {
    goal: { status: 'active', next_run_at: '2026-11-09T09:00:00Z' },
    open_run: null,
    runs,
    needs_you: needsYou.map((t) => ({ ...t, action: { category: 'email.send', summary: 'Send: Thursday 2pm works.' } })),
    health: [{ passed: false, value: 7 }, { passed: false, value: 11 }, { passed: false, value: 18 }],
  }
}

/** Stands in for the Conductor web app; records every request. */
function fakeConductor(on: On, state: { needsYou: { id: string; goal: string }[]; runs?: object[] }) {
  const requests: { method: string; url: string; body?: string }[] = []
  on('http.fetch', (_, e) => {
    const method = e.init?.method ?? 'GET'
    requests.push({ method, url: e.url, body: e.init?.body })
    const path = new URL(e.url).pathname
    const json = (status: number, data: unknown) => ({ value: { status, ok: status < 300, headers: {}, text: JSON.stringify(data) } })
    if (method === 'GET' && path === '/api/goals') return json(200, [{ id: 'g1', name: 'Inbox', status: 'active' }])
    if (method === 'GET' && path === '/api/goals/g1') return json(200, detail(state.needsYou, state.runs))
    if (method === 'POST' && path.endsWith('/approve')) {
      state.needsYou = state.needsYou.filter((t) => !path.includes(`/tasks/${t.id}/`))
      return json(200, {})
    }
    if (method === 'POST' && path.endsWith('/reject')) return json(400, { error: 'Feedback is required when rejecting.' })
    return json(404, { error: 'not found' })
  })
  return requests
}

function engine(on: On) {
  const toasts: string[] = []
  const statuses: (string | undefined)[] = []
  const clock = mock.clock(on, { now: NOW })
  mock.store(on)
  on('command.register', (_, e) => ({ value: { command: e.name } }))
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('ui.toast', (_, e) => {
    toasts.push(e.text)
    return { value: undefined }
  })
  on('ui.status', (_, e) => {
    statuses.push(e.text)
    return { value: undefined }
  })
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  return { toasts, statuses, clock }
}

test('the pane shows a proposal, and Approve posts to the web app', async ($, on) => {
  const { statuses } = engine(on)
  const requests = fakeConductor(on, { needsYou: [{ id: '11', goal: 'Reply to Alice about Thursday' }] })
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  expect(statuses.at(-1)).toBe('Conductor: 1 needs you')

  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({ ...PANE, surface })
    expect((await ui.find({ type: 'Text', text: /Reply to Alice/ }))?.text).toContain('Reply to Alice about Thursday')
    expect((await ui.find({ type: 'Text', text: /failing/ }))?.text).toContain('7')
    expect(await ui.find({ key: 'approve-g1/11' })).toBeDefined()
    await ui.unmount()
  }

  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  await ui.press({ key: 'approve-g1/11' })
  expect(requests.some((r) => r.method === 'POST' && r.url.endsWith('/api/plans/g1/tasks/11/approve'))).toBe(true)
  expect(await ui.find({ key: 'approve-g1/11' })).toBeUndefined()
  expect(statuses.at(-1)).toBe('Conductor: all clear')
  await ui.unmount()
})

test('Reject opens a feedback box and shows the web app error', async ($, on) => {
  engine(on)
  const requests = fakeConductor(on, { needsYou: [{ id: '11', goal: 'Reply to Alice' }] })
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })

  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  await ui.press({ key: 'reject-g1/11' })
  await ui.input({ key: 'feedback-g1/11', text: 'too formal' })
  const reject = requests.find((r) => r.url.endsWith('/reject'))
  expect(reject?.body).toBe(JSON.stringify({ feedback: 'too formal' }))
  expect((await ui.find({ type: 'Text', text: /Couldn't reject/ }))?.text).toContain('Feedback is required')
  await ui.unmount()
})

test('a new proposal raises a toast; ones already waiting at load do not', async ($, on) => {
  const { toasts, clock } = engine(on)
  const state = { needsYou: [{ id: '11', goal: 'Old one' }] }
  fakeConductor(on, state)
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  expect(toasts).toHaveLength(0)

  state.needsYou.push({ id: '12', goal: 'Archive the newsletter' })
  await clock.advance(15_000) // the next poll
  await clock.settle()
  expect(toasts).toEqual(['Conductor · Inbox: "Archive the newsletter" needs you'])
})

test('without the web app the pane says how to start it', async ($, on) => {
  const { statuses } = engine(on)
  on('http.fetch', () => {
    throw new Error('connect ECONNREFUSED 127.0.0.1:3000')
  })
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  expect(statuses.at(-1)).toBe('Conductor: offline')

  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  expect((await ui.find({ type: 'Text', text: /isn't reachable/ }))?.text).toBe("Conductor isn't reachable.")
  await ui.unmount()
})
