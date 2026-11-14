import { expect, test } from 'claude-code/testing'
import type { On } from 'claude-code'

const START = { cwd: '/work/project', surface: 'terminal', isInteractive: true } as const

/**
 * The engine beneath the guard: the session's agents (one run started by
 * quarterdeck-goals, one of the model's own with the same description), and a
 * quarterdeck MCP server answering guard_check. Records the run_scope each
 * Quarterdeck call arrived with.
 */
const unsubscribeApproved = { value: false }

function world(on: On, P = 'mcp__quarterdeck__') {
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('tool.register', (_, e) => ({ value: { tool: `mcp__quarterdeck-guard__${e.name}` } }))
  on('agent.list', () => ({
    value: [
      { id: 'run-agent', description: 'Goal: Inbox (run_abc123)', type: 'quarterdeck-goals:goal-runner', status: 'running', spawnedBy: 'quarterdeck-goals' },
      { id: 'model-agent', description: 'Goal: Inbox (run_abc123)', type: 'general-purpose', status: 'running' },
    ],
  }) as never)
  const scopes: unknown[] = []
  on('tool.call', { tool: `${P}get_goal_brief` }, (_, e) => {
    scopes.push((e as unknown as { run_scope?: unknown }).run_scope)
    return { result: '{}' } as never
  })
  on('tool.call', { tool: `${P}decide_item` }, () => ({ result: '{"ok":true}' }) as never)
  const inputs: unknown[] = []
  on('tool.call', { tool: `${P}guard_check` }, (_, e) => {
    const { tool_name: name, input } = e as unknown as { tool_name: string; input?: { command?: string } }
    inputs.push(input)
    return { result: JSON.stringify(name === 'mcp__gmail__delete'
      ? { decision: 'deny', category: 'email.delete', reason: 'email.delete is off for this goal' }
      : name === 'mcp__quarterdeck__unsubscribe_one_click' && !unsubscribeApproved.value
        ? { decision: 'deny', category: 'email.unsubscribe', reason: 'email.unsubscribe needs approval first' }
        : input?.command?.includes('.quarterdeck')
          ? { decision: 'deny', category: 'quarterdeck-data', reason: "a goal run can't read or change Quarterdeck's own data" }
          : { decision: 'allow' }) } as never
  })
  on('tool.call', { tool: 'Bash' }, () => ({ result: 'ran' }) as never)
  return { scopes, inputs }
}

const call = (input: Record<string, unknown>) => input as never
const said = (r: { text?: string; deny?: string; result?: unknown }) =>
  String(r.deny ?? r.text ?? (typeof r.result === "string" ? r.result : JSON.stringify(r.result)))

test('Quarterdeck calls from a run carry its run; other agents\' calls do not', async ($, on) => {
  const { scopes } = world(on)
  await $.session.start(START)
  await $.tool.call(call({ tool: 'mcp__quarterdeck__get_goal_brief', goal_id: 'g1', agentId: 'run-agent' }))
  await $.tool.call(call({ tool: 'mcp__quarterdeck__get_goal_brief', goal_id: 'g1', agentId: 'model-agent' }))
  await $.tool.call(call({ tool: 'mcp__quarterdeck__get_goal_brief', goal_id: 'g1' }))
  expect(scopes).toEqual(['run_abc123', undefined, undefined])
})

test("the person's Quarterdeck actions are refused to a run, to other agents and to the model", async ($, on) => {
  world(on)
  await $.session.start(START)
  for (const agentId of ['run-agent', 'model-agent', undefined]) {
    const r = await $.tool.call(call({ tool: 'mcp__quarterdeck__decide_item', goal_id: 'g1', item_id: '1', decision: 'approve', ...(agentId && { agentId }) }))
    expect(said(r)).toContain('Goals pane')
    const s = await $.tool.call(call({ tool: 'mcp__quarterdeck__set_schedule', goal_id: 'g1', schedule: null, ...(agentId && { agentId }) }))
    expect(said(s)).toContain('Goals pane')
  }
})

test("a run's handback goes on, so Claude Code counts its report delivered", async ($, on) => {
  const { inputs } = world(on)
  on('tool.call', { tool: 'SubagentHandback' }, () => ({ result: 'delivered' }) as never)
  await $.session.start(START)
  const r = await $.tool.call(call({ tool: 'SubagentHandback', message: 'All done', agentId: 'run-agent' }))
  expect(said(r)).toBe('delivered')
  expect(inputs).toEqual([])
})

test('the guard says it is there, for quarterdeck-goals to check', async ($, on) => {
  world(on)
  await $.session.start(START)
  const r = await $.tool.call(call({ tool: 'mcp__quarterdeck-guard__status' }))
  expect(said(r)).toContain('"guarded":true')
})

test("a run's other tools go through the goal's guard", async ($, on) => {
  world(on)
  await $.session.start(START)
  const r = await $.tool.call(call({ tool: 'mcp__gmail__delete', id: 'm1', agentId: 'run-agent' }))
  expect(said(r)).toContain('email.delete is off')
})

test("a run's command and paths go to the guard (only those fields), which refuses one that touches Quarterdeck's data", async ($, on) => {
  const { inputs } = world(on)
  await $.session.start(START)
  const r = await $.tool.call(call({ tool: 'Bash', command: 'sqlite3 ~/.quarterdeck/tasks.db .dump', description: 'dump', agentId: 'run-agent' }))
  expect(said(r)).toContain("Quarterdeck's own data")
  expect(inputs.at(-1)).toEqual({ command: 'sqlite3 ~/.quarterdeck/tasks.db .dump' })
  const ok = await $.tool.call(call({ tool: 'Bash', command: 'npm test', agentId: 'run-agent' }))
  expect(said(ok)).toBe('ran')
  await $.tool.call(call({ tool: 'mcp__gmail__delete', id: 'm1', agentId: 'run-agent' }))
  expect(inputs.at(-1)).toBeUndefined()
})

test("a run stopped by the usage limit is reported to Quarterdeck; an ordinary turn isn't", async ($, on) => {
  world(on)
  const reports: unknown[] = []
  on('tool.call', { tool: 'mcp__quarterdeck__report_run_end' }, (_, e) => {
    const { run_id, answer, reason } = e as unknown as Record<string, unknown>
    reports.push({ run_id, answer, reason })
    return { result: '{"outcome":"held"}' } as never
  })
  on('turn.complete', (_, e) => ({ text: e.answer }) as never)
  await $.session.start(START)
  const turn = (answer: string, agentId: string) =>
    $.turn.complete({ answer, agentId, reason: 'answer', durationMs: 10, isAborted: false, turnId: 't1' } as never)
  await turn('Archived 3 newsletters.', 'run-agent')
  await turn("You've hit your 5-hour limit · resets 8:10pm", 'model-agent')
  await turn("You've hit your 5-hour limit · resets 8:10pm", 'run-agent')
  expect(reports).toEqual([{ run_id: 'run_abc123', answer: "You've hit your 5-hour limit · resets 8:10pm", reason: 'answer' }])
})

test("one-click unsubscribe goes through the goal's guard, and carries the run once allowed", async ($, on) => {
  const { scopes } = world(on)
  const sent: unknown[] = []
  on('tool.call', { tool: 'mcp__quarterdeck__unsubscribe_one_click' }, (_, e) => {
    sent.push((e as unknown as { run_scope?: unknown }).run_scope)
    return { result: '{"unsubscribed":true}' } as never
  })
  await $.session.start(START)
  unsubscribeApproved.value = false
  const refused = await $.tool.call(call({ tool: 'mcp__quarterdeck__unsubscribe_one_click', url: 'https://x.example/u', agentId: 'run-agent' }))
  expect(said(refused)).toContain('needs approval')
  unsubscribeApproved.value = true
  await $.tool.call(call({ tool: 'mcp__quarterdeck__unsubscribe_one_click', url: 'https://x.example/u', agentId: 'run-agent' }))
  expect(sent).toEqual(['run_abc123'])
  expect(scopes).toEqual([])
})

test('with the server from the quarterdeck-goals plugin, its tools are named mcp__plugin_quarterdeck-goals_quarterdeck__* and the same rules apply', async ($, on) => {
  const P = 'mcp__plugin_quarterdeck-goals_quarterdeck__'
  const { scopes } = world(on, P)
  await $.session.start(START)
  await $.tool.call(call({ tool: `${P}get_goal_brief`, goal_id: 'g1', agentId: 'run-agent' }))
  expect(scopes).toEqual(['run_abc123'])
  const r = await $.tool.call(call({ tool: `${P}decide_item`, goal_id: 'g1', item_id: '1', decision: 'approve', agentId: 'run-agent' }))
  expect(said(r)).toContain('Goals pane')
  const m = await $.tool.call(call({ tool: `${P}decide_item`, goal_id: 'g1', item_id: '1', decision: 'approve' }))
  expect(said(m)).toContain('Goals pane')
  const d = await $.tool.call(call({ tool: 'mcp__gmail__delete', id: 'm1', agentId: 'run-agent' }))
  expect(said(d)).toContain('email.delete is off')
})

test("a run's calls are reported for the Goals pane, and a call put to the person shows as waiting until it settles", async ($, on) => {
  world(on)
  const progress: unknown[] = []
  on('tool.call', { tool: 'mcp__quarterdeck__run_progress' }, (_, e) => {
    const { run_id, event, label } = e as unknown as Record<string, unknown>
    progress.push({ run_id, event, label })
    return { result: '{"updated":true}' } as never
  })
  on('tool.call', { tool: 'mcp__notes__read' }, () => ({ result: 'ok' }) as never)
  on('tool.check', { tool: 'mcp__notes__send' }, () => ({ decision: 'ask' }))
  on('tool.call', { tool: 'mcp__notes__send' }, () => ({ result: 'sent' }) as never)
  await $.session.start(START)
  await $.tool.call(call({ tool: 'mcp__notes__read', agentId: 'run-agent' }))
  // Nobody answers the ask here, so the call is refused: the wait is over all the same
  await $.tool.call(call({ tool: 'mcp__notes__send', to: 'a@example.com', agentId: 'run-agent' }))
  await $.tool.call(call({ tool: 'mcp__notes__read', agentId: 'model-agent' }))
  await $.tool.call(call({ tool: 'mcp__quarterdeck__get_goal_brief', goal_id: 'g1', agentId: 'run-agent' }))
  expect(progress).toEqual([
    { run_id: 'run_abc123', event: 'tool', label: 'notes read' },
    { run_id: 'run_abc123', event: 'settled', label: 'notes read' },
    { run_id: 'run_abc123', event: 'tool', label: 'notes send' },
    { run_id: 'run_abc123', event: 'waiting', label: 'notes send' },
    { run_id: 'run_abc123', event: 'settled', label: 'notes send' },
  ])
})
