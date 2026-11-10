import { envVar } from '@quarterdeck/core'

/**
 * Which tools the server lists to Claude. Goals are the product, so the plan
 * tools are hidden by default: they cost tool definitions in every session and
 * nothing in a goal run needs them. Goal runs work their items with
 * update_task and set_status, which stay listed, and to-do lists have their own
 * tools. Hidden tools still answer calls; QUARTERDECK_TOOLS=all (or CONDUCTOR_TOOLS=all) lists them again.
 */
export const PLAN_TOOLS = new Set([
  'create_plan', 'list_plans', 'open_plan', 'archive_plan',
  'create_task', 'provision_tasks', 'synthesize', 'get_context', 'next_task', 'get_history', 'verify_task',
])

export function isListed(name: string, env: NodeJS.ProcessEnv = process.env): boolean {
  return envVar('TOOLS', env) === 'all' || !PLAN_TOOLS.has(name)
}
