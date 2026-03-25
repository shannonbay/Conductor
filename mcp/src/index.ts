import { Server } from '@modelcontextprotocol/sdk/server/index.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { CallToolRequestSchema, ListToolsRequestSchema, ListResourcesRequestSchema, ReadResourceRequestSchema } from '@modelcontextprotocol/sdk/types.js'
import { zodToJsonSchema } from 'zod-to-json-schema'

import {
  CreatePlanSchema,
  ListPlansSchema,
  OpenPlanSchema,
  ArchivePlanSchema,
  CreateTaskSchema,
  UpdateTaskSchema,
  SetStatusSchema,
  SynthesizeSchema,
  GetContextSchema,
  ProvisionTasksSchema,
} from './schema.js'

import { create_plan } from './tools/create_plan.js'
import { list_plans } from './tools/list_plans.js'
import { open_plan } from './tools/open_plan.js'
import { archive_plan } from './tools/archive_plan.js'
import { create_task } from './tools/create_task.js'
import { update_task } from './tools/update_task.js'
import { set_status } from './tools/set_status.js'
import { synthesize } from './tools/synthesize.js'
import { get_context } from './tools/get_context.js'
import { provision_tasks } from './tools/provision_tasks.js'
import { handleListResources, handleReadResource } from './resources.js'

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
    description: 'Open an existing plan. Use this at the start of a session when resuming prior work. Opening an archived plan automatically restores it to active. Returns the list of root tasks so you can pick up where you left off. All task tools operate on the open plan, so you must open one before doing any task work.',
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
    description: 'Create a new task. Pass parent_id to create a child of an existing task. Omit parent_id only when creating the very first root task on an empty tree. Decompose work into sub-tasks before starting it — not after problems arise. For sequential work, create all sibling tasks upfront with depends_on and status="pending" so the dependency graph is explicit from the start. Prefer smaller, concrete tasks over large vague ones; a task should have a clear completion condition.',
    inputSchema: zodToJsonSchema(CreateTaskSchema),
    handler: create_task,
  },
  {
    name: 'update_task',
    description: 'Record progress on a task. Provide task_id explicitly. Call this after completing meaningful work, not just at the end — intermediate results are valuable if the session ends or an approach fails. Use result for a human-readable summary of what happened. Use state_patch for structured data (file paths, counts, flags, API responses) that this task or downstream sibling tasks will need programmatically. Use notes for freeform observations, corrections, or context — unlike result, notes can be updated at any point and cleared by passing null. Use goal to rename the task (pending tasks only).',
    inputSchema: zodToJsonSchema(UpdateTaskSchema),
    handler: update_task,
  },
  {
    name: 'set_status',
    description: 'Change the status of a task. Provide task_id explicitly. When an approach fails or hits a hard blocker, abandon it with a specific reason before creating an alternative sibling — the reason is visible to sibling tasks and prevents repeating the same mistake. When completing a task, make sure its children are all resolved first. Activating a task with unmet depends_on will return an error; complete the dependencies first.',
    inputSchema: zodToJsonSchema(SetStatusSchema),
    handler: set_status,
  },
  {
    name: 'synthesize',
    description: 'Collect the results and state from all children of a task into a single consolidated view. Provide task_id explicitly. Call this before marking a parent task complete — it gives you a full picture of what each sub-task produced, what was abandoned and why, and what is still pending. Do not complete a parent task without synthesizing first.',
    inputSchema: zodToJsonSchema(SynthesizeSchema),
    handler: synthesize,
  },
  {
    name: 'get_context',
    description: 'Read-only. Returns the context view for a task: the task itself, its parent, siblings, children, and tree-wide stats. Provide task_id explicitly. Call this to inspect any task at any time. If no plan is open, it will tell you — use list_plans and open_plan first.',
    inputSchema: zodToJsonSchema(GetContextSchema),
    handler: get_context,
  },
  {
    name: 'provision_tasks',
    description: 'Create multiple tasks in a single call by providing a map of absolute task IDs to task specs. Use this instead of repeated create_task calls when you want to lay out an entire plan or sub-tree at once. IDs are hierarchical addresses ("1", "1.1", "1.2.3"); parent IDs must exist in the DB or be included in the batch. All tasks are inserted atomically — either all succeed or none do. Focus moves to the shallowest, lowest-numbered task created. Duplicate IDs (already in DB) are rejected; use update_task to modify existing tasks.',
    inputSchema: zodToJsonSchema(ProvisionTasksSchema),
    handler: provision_tasks,
  },
]

const server = new Server(
  { name: 'conductor', version: '1.0.0' },
  { capabilities: { tools: {}, resources: {} } },
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

server.setRequestHandler(ListResourcesRequestSchema, handleListResources)
server.setRequestHandler(ReadResourceRequestSchema, handleReadResource)

const transport = new StdioServerTransport()
await server.connect(transport)
