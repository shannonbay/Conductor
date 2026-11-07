#!/usr/bin/env node
/**
 * Conductor goal guard — a Claude Code PreToolUse hook.
 *
 * During a persistent-goal run it enforces the goal's autonomy on tools
 * outside Conductor (e.g. a mail "send" tool), using the goal's tool_map:
 * "off" categories are denied, "propose" categories need an approved
 * proposal, "auto" categories are allowed. Outside goal runs it allows
 * everything. The Claude Code session is tied to its run when the agent
 * calls mcp__conductor__get_goal_brief with a run_id.
 *
 * Install with: npm run setup-hooks --prefix mcp -- --guard
 * Fails open (allows) on internal errors so a broken database can't block all tools.
 */
import type { Database } from '@conductor/core'

export interface HookInput {
  session_id?: string
  tool_name?: string
  tool_input?: Record<string, unknown>
}

export interface HookOutput {
  hookSpecificOutput: { hookEventName: 'PreToolUse'; permissionDecision: 'deny'; permissionDecisionReason: string }
}

/** Returns the hook output to print, or null to allow the call. */
export async function handleHookInput(db: Database, input: HookInput): Promise<HookOutput | null> {
  const core = await import('@conductor/core')
  const session = input.session_id
  const tool = input.tool_name
  if (!session || !tool) return null

  if (tool === 'mcp__conductor__get_goal_brief') {
    const runId = input.tool_input?.run_id
    if (typeof runId === 'string') core.bindSessionToRun(db, runId, session)
    return null
  }

  const d = core.guardToolCall(db, session, tool)
  return d.decision === 'deny'
    ? { hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: d.reason } }
    : null
}

async function main(): Promise<void> {
  let raw = ''
  for await (const chunk of process.stdin) raw += chunk
  const input = JSON.parse(raw) as HookInput
  const core = await import('@conductor/core')
  const db = core.openDatabase()
  try {
    const out = await handleHookInput(db, input)
    if (out) process.stdout.write(JSON.stringify(out))
  } finally {
    db.close()
  }
}

// Run only when executed directly (not when imported by tests)
if (process.argv[1] && /goal-guard\.(js|ts)$/.test(process.argv[1])) {
  main().catch((err) => {
    process.stderr.write(`Conductor goal guard error (allowing the call): ${err instanceof Error ? err.message : String(err)}\n`)
    process.exit(0)
  })
}
