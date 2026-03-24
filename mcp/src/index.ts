import { Server } from '@modelcontextprotocol/sdk/server/index.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js'
import { zodToJsonSchema } from 'zod-to-json-schema'

import {
  CreatePlanSchema,
  ListPlansSchema,
  OpenPlanSchema,
  ArchivePlanSchema,
  CreateTaskSchema,
  UpdateTaskSchema,
  NavigateSchema,
  SetStatusSchema,
  SynthesizeSchema,
  GetContextSchema,
} from './schema.js'

import { create_plan } from './tools/create_plan.js'
import { list_plans } from './tools/list_plans.js'
import { open_plan } from './tools/open_plan.js'
import { archive_plan } from './tools/archive_plan.js'
import { create_task } from './tools/create_task.js'
import { update_task } from './tools/update_task.js'
import { navigate } from './tools/navigate.js'
import { set_status } from './tools/set_status.js'
import { synthesize } from './tools/synthesize.js'
import { get_context } from './tools/get_context.js'

const TOOLS = [
  {
    name: 'create_plan',
    description: 'Create a new plan and open it as the active context. Use this at the start of any goal that has multiple steps, unknown complexity, or may require backtracking — before doing any work. A plan is the container for a persistent task tree that survives across sessions, so create one even if you expect to finish in a single session.',
    inputSchema: zodToJsonSchema(CreatePlanSchema),
    handler: create_plan,
  },
  {
    name: 'list_plans',
    description: 'List existing plans on the server. Call this at the start of every new session before creating anything — the work you need may already exist with progress recorded. Returns active plans by default; use status="all" to include archived ones.',
    inputSchema: zodToJsonSchema(ListPlansSchema),
    handler: list_plans,
  },
  {
    name: 'open_plan',
    description: 'Open an existing plan and restore its focus cursor to where you left off. Use this at the start of a session when resuming prior work. Opening an archived plan automatically restores it to active. All task tools operate on the open plan, so you must open one before doing any task work.',
    inputSchema: zodToJsonSchema(OpenPlanSchema),
    handler: open_plan,
  },
  {
    name: 'archive_plan',
    description: 'Archive a completed or abandoned plan, hiding it from default listings while preserving its full task tree. Use this when all root-level work is done or the plan is no longer active. Archiving is reversible — open_plan restores it. Plans are never deleted; the history of what was tried and why it succeeded or failed is preserved.',
    inputSchema: zodToJsonSchema(ArchivePlanSchema),
    handler: archive_plan,
  },
  {
    name: 'create_task',
    description: 'Create a child task under the current focus, or a root task if the tree is empty. Focus moves to the new task. Decompose work into sub-tasks before starting it — not after problems arise. For sequential work, create all sibling tasks upfront with depends_on and status="pending" so the dependency graph is explicit from the start. Prefer smaller, concrete tasks over large vague ones; a task should have a clear completion condition.',
    inputSchema: zodToJsonSchema(CreateTaskSchema),
    handler: create_task,
  },
  {
    name: 'update_task',
    description: 'Record progress on the current focus task without changing focus. Call this after completing meaningful work, not just at the end — intermediate results are valuable if the session ends or an approach fails. Use result for a human-readable summary of what happened. Use state_patch for structured data (file paths, counts, flags, API responses) that this task or downstream sibling tasks will need programmatically.',
    inputSchema: zodToJsonSchema(UpdateTaskSchema),
    handler: update_task,
  },
  {
    name: 'navigate',
    description: 'Move focus to any task by ID within the open project. Use this to return to a parent after completing or abandoning a sub-task, to jump to the next sibling, or to drill into a child. Navigation is how you traverse the tree — after completing a leaf task, always navigate back up to the parent to assess what comes next.',
    inputSchema: zodToJsonSchema(NavigateSchema),
    handler: navigate,
  },
  {
    name: 'set_status',
    description: 'Change the status of a task. When an approach fails or hits a hard blocker, abandon it with a specific reason before creating an alternative sibling — the reason is visible to sibling tasks and prevents repeating the same mistake. When completing a task, make sure its children are all resolved first. Activating a task with unmet depends_on will return an error; complete the dependencies first.',
    inputSchema: zodToJsonSchema(SetStatusSchema),
    handler: set_status,
  },
  {
    name: 'synthesize',
    description: 'Collect the results and state from all children of a task into a single consolidated view. Call this before marking a parent task complete — it gives you a full picture of what each sub-task produced, what was abandoned and why, and what is still pending, without navigating each child individually. Do not complete a parent task without synthesizing first.',
    inputSchema: zodToJsonSchema(SynthesizeSchema),
    handler: synthesize,
  },
  {
    name: 'get_context',
    description: 'Read-only. Returns the context view for the current focus task: the task itself, its parent, siblings, children, and tree-wide stats. Call this at the start of every session before doing any work, to re-orient after a context switch, or any time you are unsure where you are in the tree. If no plan is open, it will tell you — use list_plans and open_plan first.',
    inputSchema: zodToJsonSchema(GetContextSchema),
    handler: get_context,
  },
]

const server = new Server(
  { name: 'conductor', version: '1.0.0' },
  { capabilities: { tools: {} } },
)

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: TOOLS.map(({ name, description, inputSchema }) => ({ name, description, inputSchema })),
}))

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const tool = TOOLS.find(t => t.name === request.params.name)
  if (!tool) {
    return {
      content: [{ type: 'text', text: `Error: Unknown tool: ${request.params.name}` }],
      isError: true,
    }
  }

  try {
    const result = await tool.handler(request.params.arguments ?? {})
    return {
      content: [{ type: 'text', text: JSON.stringify(result, null, 2) }],
    }
  } catch (e) {
    return {
      content: [{ type: 'text', text: `Error: ${(e as Error).message}` }],
      isError: true,
    }
  }
})

const transport = new StdioServerTransport()
await server.connect(transport)
