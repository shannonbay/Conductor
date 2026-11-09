import { expect, test } from 'claude-code/testing'
import type { On } from 'claude-code'

const START = { cwd: '/work/project', surface: 'terminal', isInteractive: true } as const

/**
 * The engine beneath the guard: the session's agents (one run started by
 * conductor-goals, one of the model's own with the same description), and a
 * conductor MCP server answering guard_check. Records the run_scope each
 * Conductor call arrived with.
 */
const unsubscribeApproved = { value: false }

function world(on: On) {
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('tool.register', (_, e) => ({ value: { tool: `mcp__conductor-goals-guard__${e.name}` } }))
  on('agent.list', () => ({
    value: [
      { id: 'run-agent', description: 'Goal: Inbox (run_abc123)', type: 'conductor-goals:goal-runner', status: 'running', spawnedBy: 'conductor-goals' },
      { id: 'model-agent', description: 'Goal: Inbox (run_abc123)', type: 'general-purpose', status: 'running' },
    ],
  }) as never)
  const scopes: unknown[] = []
  on('tool.call', { tool: 'mcp__conductor__get_goal_brief' }, (_, e) => {
    scopes.push((e as unknown as { run_scope?: unknown }).run_scope)
    return { result: '{}' } as never
  })
  on('tool.call', { tool: 'mcp__conductor__decide_item' }, () => ({ result: '{"ok":true}' }) as never)
  on('tool.call', { tool: 'mcp__conductor__guard_check' }, (_, e) => {
    const name = (e as unknown as { tool_name: string }).tool_name
    return { result: JSON.stringify(name === 'mcp__gmail__delete'
      ? { decision: 'deny', category: 'email.delete', reason: 'email.delete is off for this goal' }
      : name === 'mcp__conductor__unsubscribe_one_click' && !unsubscribeApproved.value
        ? { decision: 'deny', category: 'email.unsubscribe', reason: 'email.unsubscribe needs approval first' }
        : { decision: 'allow' }) } as never
  })
  return { scopes }
}

const call = (input: Record<string, unknown>) => input as never
const said = (r: { text?: string; deny?: string; result?: unknown }) =>
  String(r.deny ?? r.text ?? (typeof r.result === "string" ? r.result : JSON.stringify(r.result)))

test('Conductor calls from a run carry its run; other agents\' calls do not', async ($, on) => {
  const { scopes } = world(on)
  await $.session.start(START)
  await $.tool.call(call({ tool: 'mcp__conductor__get_goal_brief', goal_id: 'g1', agentId: 'run-agent' }))
  await $.tool.call(call({ tool: 'mcp__conductor__get_goal_brief', goal_id: 'g1', agentId: 'model-agent' }))
  await $.tool.call(call({ tool: 'mcp__conductor__get_goal_brief', goal_id: 'g1' }))
  expect(scopes).toEqual(['run_abc123', undefined, undefined])
})

test("the person's Conductor actions are refused to a run, to other agents and to the model", async ($, on) => {
  world(on)
  await $.session.start(START)
  for (const agentId of ['run-agent', 'model-agent', undefined]) {
    const r = await $.tool.call(call({ tool: 'mcp__conductor__decide_item', goal_id: 'g1', item_id: '1', decision: 'approve', ...(agentId && { agentId }) }))
    expect(said(r)).toContain('Goals pane')
    const s = await $.tool.call(call({ tool: 'mcp__conductor__set_schedule', goal_id: 'g1', schedule: null, ...(agentId && { agentId }) }))
    expect(said(s)).toContain('Goals pane')
  }
})

test("a run's report is kept by Conductor, not handed back into the chat", async ($, on) => {
  world(on)
  await $.session.start(START)
  const r = await $.tool.call(call({ tool: 'SubagentHandback', report: 'All done', agentId: 'run-agent' }))
  expect(said(r)).toContain('Report saved by Conductor')
})

test('the guard says it is there, for conductor-goals to check', async ($, on) => {
  world(on)
  await $.session.start(START)
  const r = await $.tool.call(call({ tool: 'mcp__conductor-goals-guard__status' }))
  expect(said(r)).toContain('"guarded":true')
})

test("a run's other tools go through the goal's guard", async ($, on) => {
  world(on)
  await $.session.start(START)
  const r = await $.tool.call(call({ tool: 'mcp__gmail__delete', id: 'm1', agentId: 'run-agent' }))
  expect(said(r)).toContain('email.delete is off')
})

test("a run stopped by the usage limit is reported to Conductor; an ordinary turn isn't", async ($, on) => {
  world(on)
  const reports: unknown[] = []
  on('tool.call', { tool: 'mcp__conductor__report_run_end' }, (_, e) => {
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
  on('tool.call', { tool: 'mcp__conductor__unsubscribe_one_click' }, (_, e) => {
    sent.push((e as unknown as { run_scope?: unknown }).run_scope)
    return { result: '{"unsubscribed":true}' } as never
  })
  await $.session.start(START)
  unsubscribeApproved.value = false
  const refused = await $.tool.call(call({ tool: 'mcp__conductor__unsubscribe_one_click', url: 'https://x.example/u', agentId: 'run-agent' }))
  expect(said(refused)).toContain('needs approval')
  unsubscribeApproved.value = true
  await $.tool.call(call({ tool: 'mcp__conductor__unsubscribe_one_click', url: 'https://x.example/u', agentId: 'run-agent' }))
  expect(sent).toEqual(['run_abc123'])
  expect(scopes).toEqual([])
})
