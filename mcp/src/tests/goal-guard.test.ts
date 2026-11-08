import { describe, it, expect, beforeEach } from 'vitest'
import * as core from '@conductor/core'
import { handleHookInput } from '../goal-guard.js'

let db: core.Database
const now = new Date().toISOString()

beforeEach(() => {
  db = core.openDatabase(':memory:')
  core.createGoal(db, { id: 'g', name: 'Inbox', description: null, status: 'active', working_dir: '/tmp', created_at: now, updated_at: now },
    { objective: 'x', autonomy: { 'email.delete': 'off' } })
  core.updateGoal(db, 'g', { tool_map: { 'mcp__gmail__delete*': 'email.delete', 'mcp__gmail__send_message': 'email.send' } })
})

describe('goal-guard hook', () => {
  it('binds the session on get_goal_brief, then denies off-category tools with a PreToolUse deny', async () => {
    const run = core.insertRun(db, 'g', 'manual', 'running')
    expect(await handleHookInput(db, { session_id: 's1', tool_name: 'mcp__conductor__get_goal_brief', tool_input: { goal_id: 'g', run_id: run.id } })).toBeNull()
    const out = await handleHookInput(db, { session_id: 's1', tool_name: 'mcp__gmail__delete_message', tool_input: {} })
    expect(out).toMatchObject({ hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: expect.stringContaining('off') } })
  })

  it('allows calls from sessions that are not doing a goal run', async () => {
    core.insertRun(db, 'g', 'manual', 'running')
    expect(await handleHookInput(db, { session_id: 'other', tool_name: 'mcp__gmail__delete_message' })).toBeNull()
  })

  it("doesn't bind the session for a run the plugin tags with run_scope", async () => {
    const run = core.insertRun(db, 'g', 'manual', 'running')
    expect(await handleHookInput(db, { session_id: 's1', tool_name: 'mcp__conductor__get_goal_brief', tool_input: { goal_id: 'g', run_id: run.id, run_scope: run.id } })).toBeNull()
    expect(await handleHookInput(db, { session_id: 's1', tool_name: 'mcp__gmail__delete_message', tool_input: {} })).toBeNull()
  })

  it('ignores malformed input', async () => {
    expect(await handleHookInput(db, {})).toBeNull()
  })
})
