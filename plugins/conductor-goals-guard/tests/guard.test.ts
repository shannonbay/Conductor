import { expect, test } from 'claude-code/testing'
import type { On } from 'claude-code'

const START = { cwd: '/work/project', surface: 'terminal', isInteractive: true } as const

/**
 * The engine beneath the guard: the session's agents (one run started by
 * conductor-goals, one of the model's own with the same description), and a
 * conductor MCP server answering guard_check. Records the run_scope each
 * Conductor call arrived with.
 */
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
