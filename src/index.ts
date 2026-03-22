import { Server } from '@modelcontextprotocol/sdk/server/index.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js'
import { zodToJsonSchema } from 'zod-to-json-schema'

import {
  CreateProjectSchema,
  ListProjectsSchema,
  OpenProjectSchema,
  ArchiveProjectSchema,
  CreateTaskSchema,
  UpdateTaskSchema,
  NavigateSchema,
  SetStatusSchema,
  SynthesizeSchema,
  GetContextSchema,
} from './schema.js'

import { create_project } from './tools/create_project.js'
import { list_projects } from './tools/list_projects.js'
import { open_project } from './tools/open_project.js'
import { archive_project } from './tools/archive_project.js'
import { create_task } from './tools/create_task.js'
import { update_task } from './tools/update_task.js'
import { navigate } from './tools/navigate.js'
import { set_status } from './tools/set_status.js'
import { synthesize } from './tools/synthesize.js'
import { get_context } from './tools/get_context.js'

const TOOLS = [
  {
    name: 'create_project',
    description: 'Create a new project. The project starts with an empty task tree and becomes the currently open project.',
    inputSchema: zodToJsonSchema(CreateProjectSchema),
    handler: create_project,
  },
  {
    name: 'list_projects',
    description: 'List projects on the server. By default, returns only active projects.',
    inputSchema: zodToJsonSchema(ListProjectsSchema),
    handler: list_projects,
  },
  {
    name: 'open_project',
    description: 'Open an existing project, making it the active context for all subsequent task operations.',
    inputSchema: zodToJsonSchema(OpenProjectSchema),
    handler: open_project,
  },
  {
    name: 'archive_project',
    description: 'Archive a project, removing it from default listings. The task tree is preserved intact.',
    inputSchema: zodToJsonSchema(ArchiveProjectSchema),
    handler: archive_project,
  },
  {
    name: 'create_task',
    description: 'Create a new child task under the current focus (or a root task if the tree is empty). Focus moves to the new task.',
    inputSchema: zodToJsonSchema(CreateTaskSchema),
    handler: create_task,
  },
  {
    name: 'update_task',
    description: 'Record progress on the current focus task. Does not change focus.',
    inputSchema: zodToJsonSchema(UpdateTaskSchema),
    handler: update_task,
  },
  {
    name: 'navigate',
    description: 'Move focus to any task by ID within the open project.',
    inputSchema: zodToJsonSchema(NavigateSchema),
    handler: navigate,
  },
  {
    name: 'set_status',
    description: 'Change a task\'s status. Use to mark work as completed, abandon a dead end, or activate a pending task.',
    inputSchema: zodToJsonSchema(SetStatusSchema),
    handler: set_status,
  },
  {
    name: 'synthesize',
    description: 'Gather the results and state from all children of a task into a single summary.',
    inputSchema: zodToJsonSchema(SynthesizeSchema),
    handler: synthesize,
  },
  {
    name: 'get_context',
    description: 'Read-only. Returns the context view for the current focus task without modifying anything.',
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
