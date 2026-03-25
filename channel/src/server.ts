/**
 * Conductor Channel Server
 *
 * An MCP server that Claude Code spawns as a subprocess (over stdio).
 * Simultaneously listens on HTTP so the Conductor web server can send
 * work requests and receive results.
 *
 * Setup:
 *   Add to .mcp.json:
 *   { "mcpServers": { "conductor-channel": { "command": "npx", "args": ["tsx", "/path/to/Conductor/channel/src/server.ts"] } } }
 *
 *   Launch Claude Code:
 *   claude --dangerously-load-development-channels server:conductor-channel
 */

import { Server } from '@modelcontextprotocol/sdk/server/index.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { ListToolsRequestSchema, CallToolRequestSchema } from '@modelcontextprotocol/sdk/types.js'
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'

const CHANNEL_PORT = parseInt(process.env.CONDUCTOR_CHANNEL_PORT ?? '8789')

// ── State ─────────────────────────────────────────────────────────────────────

let sessionConnected = false

interface PendingOneShot {
  resolve: (value: unknown) => void
  reject: (err: Error) => void
}

// One-shot requests (plan_tasks, modify_tasks, generate_plan): resolved when Claude calls reply tool
const pendingOneShot = new Map<string, PendingOneShot>()

// Agent SSE connections: keyed by requestId, values are Node.js ServerResponse objects
const agentSseConnections = new Map<string, ServerResponse>()

// Track which requestId is currently active (only one at a time)
let currentRequestId: string | null = null

// ── Request payload types ─────────────────────────────────────────────────────

interface RunAgentPayload {
  planId: string
  rootTaskId: string
  planName: string
  workingDir: string
}

interface GeneratePlanPayload {
  planId: number
  planName: string
  description: string
  workingDir: string
  existingTasksSummary?: string
}

interface PlanTasksPayload {
  taskId: string
  planName: string
  goal: string
  parentGoal: string | null
  siblings: Array<{ id: string; goal: string; status: string; abandon_reason?: string | null; result?: string | null }>
  instruction?: string
}

interface ModifyTasksPayload {
  taskId: string
  planName: string
  goal: string
  existingChildren: Array<{ id: string; goal: string; status: string; result?: string | null; abandon_reason?: string | null }>
  instruction: string
}

type RequestPayload = RunAgentPayload | GeneratePlanPayload | PlanTasksPayload | ModifyTasksPayload

// ── Channel content builders ──────────────────────────────────────────────────

function buildChannelContent(requestId: string, type: string, payload: RequestPayload): string {
  switch (type) {
    case 'run_agent': {
      const p = payload as RunAgentPayload
      return `Work on plan "${p.planName}" (plan ID: ${p.planId}), starting from task ${p.rootTaskId}. Working directory: ${p.workingDir}. Use the conductor MCP server tools to manage the task tree (create_task, update_task, set_status, get_context, etc.). Call agent_update periodically to report progress. Call agent_done when you have finished all work on the task tree.`
    }
    case 'generate_plan': {
      const p = payload as GeneratePlanPayload
      const existing = p.existingTasksSummary
        ? `\n\nExisting tasks (do not re-propose completed ones):\n${p.existingTasksSummary}`
        : '\n\nNo tasks exist yet — propose a complete task tree from scratch.'
      return `Explore the working directory "${p.workingDir}" for plan "${p.planName}"${p.description ? ` (description: "${p.description}")` : ''}.${existing}\n\nList the directory, read 3-5 key files (README, package.json, CLAUDE.md, a key source file), then call plan_proposal with a structured task tree. Aim for 3-7 concrete child tasks. Err on the side of submitting early.`
    }
    case 'plan_tasks': {
      const p = payload as PlanTasksPayload
      const siblingLines = (p.siblings ?? [])
        .map((s) => {
          const suffix = s.status === 'abandoned' && s.abandon_reason
            ? ` — abandoned: "${s.abandon_reason}"`
            : s.result ? ` — result: "${s.result}"` : ''
          return `  ${s.id}: "${s.goal}" [${s.status}]${suffix}`
        })
        .join('\n')
      return [
        `Propose child tasks for task "${p.goal}"${p.parentGoal ? ` (parent goal: "${p.parentGoal}")` : ''} in plan "${p.planName}".`,
        siblingLines ? `\nSibling tasks:\n${siblingLines}` : '',
        p.instruction ? `\nAdditional instruction: "${p.instruction}"` : '',
        '\nPropose 3-7 concrete, actionable child tasks. Call tasks_proposal with the result.',
      ].join('')
    }
    case 'modify_tasks': {
      const p = payload as ModifyTasksPayload
      const childrenJson = JSON.stringify(
        p.existingChildren.map((c) => ({ id: c.id, goal: c.goal, status: c.status, result: c.result, abandon_reason: c.abandon_reason })),
        null,
        2,
      )
      return `Modify the child tasks of "${p.goal}" in plan "${p.planName}" per this instruction: "${p.instruction}".\n\nCurrent children:\n${childrenJson}\n\nNever remove or modify tasks with status "completed" or "active". Call tasks_diff with the result.`
    }
    default:
      return JSON.stringify({ requestId, type, payload })
  }
}

// ── MCP Server ────────────────────────────────────────────────────────────────

const mcp = new Server(
  { name: 'conductor-channel', version: '0.1.0' },
  {
    capabilities: {
      experimental: { 'claude/channel': {} },
      tools: {},
    },
    instructions: `You receive work requests from the Conductor UI as <channel source="conductor-channel" request_id="..." type="..."> events.

For each request type, call the corresponding reply tool with the exact request_id echoed back:
- run_agent: work on the task tree using the conductor MCP server tools. Call agent_update to report progress. Call agent_done when finished.
- generate_plan: explore the working_dir with your file tools, then call plan_proposal with a structured task tree.
- plan_tasks: propose child task decompositions, then call tasks_proposal with a JSON array.
- modify_tasks: propose task tree modifications, then call tasks_diff with a diff object.
- control (action=cancel): stop your current work and call agent_cancelled.
- human_message: incorporate this message from the user and respond appropriately, then continue your work.

Always echo the request_id exactly as received.`,
  },
)

// ── Reply tools ───────────────────────────────────────────────────────────────

mcp.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    {
      name: 'agent_update',
      description: 'Report progress on an agent task. Call this as you make progress.',
      inputSchema: {
        type: 'object' as const,
        properties: {
          request_id: { type: 'string', description: 'The request_id from the channel event' },
          message: { type: 'string', description: 'Description of what you just did or are doing' },
          tool: { type: 'string', description: 'Name of the tool you just called, if this is a tool update' },
        },
        required: ['request_id', 'message'],
      },
    },
    {
      name: 'agent_done',
      description: 'Signal that all agent work is complete.',
      inputSchema: {
        type: 'object' as const,
        properties: {
          request_id: { type: 'string' },
          summary: { type: 'string', description: 'Summary of what was accomplished' },
        },
        required: ['request_id', 'summary'],
      },
    },
    {
      name: 'agent_cancelled',
      description: 'Signal that agent work was cancelled in response to a cancel control message.',
      inputSchema: {
        type: 'object' as const,
        properties: {
          request_id: { type: 'string' },
        },
        required: ['request_id'],
      },
    },
    {
      name: 'plan_proposal',
      description: 'Submit a structured plan proposal with a root task and child tasks.',
      inputSchema: {
        type: 'object' as const,
        properties: {
          request_id: { type: 'string' },
          root: {
            type: 'object',
            properties: { goal: { type: 'string', description: 'Concise statement of the plan\'s primary objective' } },
            required: ['goal'],
          },
          children: {
            type: 'array',
            description: '3-7 concrete child tasks',
            items: {
              type: 'object',
              properties: {
                goal: { type: 'string' },
                suggested_depends_on: { type: 'array', items: { type: 'string' }, description: 'Indices of sibling tasks this depends on (0-based)' },
              },
              required: ['goal'],
            },
          },
        },
        required: ['request_id', 'root', 'children'],
      },
    },
    {
      name: 'tasks_proposal',
      description: 'Submit decomposed child tasks for a task.',
      inputSchema: {
        type: 'object' as const,
        properties: {
          request_id: { type: 'string' },
          tasks: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                goal: { type: 'string' },
                plan: { type: 'array', items: { type: 'string' }, description: 'Step-by-step plan hints' },
                suggested_depends_on: { type: 'array', items: { type: 'string' } },
              },
              required: ['goal'],
            },
          },
        },
        required: ['request_id', 'tasks'],
      },
    },
    {
      name: 'tasks_diff',
      description: 'Submit a plan modification diff.',
      inputSchema: {
        type: 'object' as const,
        properties: {
          request_id: { type: 'string' },
          unchanged: { type: 'array', items: { type: 'string' }, description: 'IDs of tasks that stay as-is' },
          modified: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                replaces_id: { type: 'string' },
                goal: { type: 'string' },
                plan: { type: 'array', items: { type: 'string' } },
                suggested_depends_on: { type: 'array', items: { type: 'string' } },
              },
              required: ['replaces_id', 'goal'],
            },
          },
          added: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                goal: { type: 'string' },
                plan: { type: 'array', items: { type: 'string' } },
                suggested_depends_on: { type: 'array', items: { type: 'string' } },
              },
              required: ['goal'],
            },
          },
          removed: { type: 'array', items: { type: 'string' }, description: 'IDs of pending tasks to remove' },
        },
        required: ['request_id'],
      },
    },
  ],
}))

mcp.setRequestHandler(CallToolRequestSchema, async (req) => {
  const { name, arguments: args } = req.params
  const input = (args ?? {}) as Record<string, unknown>
  const requestId = input['request_id'] as string | undefined

  if (!requestId) {
    return { content: [{ type: 'text' as const, text: JSON.stringify({ error: 'Missing request_id' }) }] }
  }

  const ack = { content: [{ type: 'text' as const, text: 'ok' }] }

  switch (name) {
    case 'agent_update': {
      const sseRes = agentSseConnections.get(requestId)
      if (sseRes && !sseRes.writableEnded) {
        try {
          const data = JSON.stringify({ type: 'update', message: input['message'], tool: input['tool'] ?? null })
          sseRes.write(`data: ${data}\n\n`)
        } catch {
          agentSseConnections.delete(requestId)
        }
      }
      return ack
    }

    case 'agent_done': {
      const sseRes = agentSseConnections.get(requestId)
      if (sseRes && !sseRes.writableEnded) {
        try {
          const data = JSON.stringify({ type: 'done', summary: input['summary'] })
          sseRes.write(`data: ${data}\n\n`)
          sseRes.end()
        } catch { /* ignore */ }
      }
      agentSseConnections.delete(requestId)
      if (currentRequestId === requestId) currentRequestId = null
      return ack
    }

    case 'agent_cancelled': {
      const sseRes = agentSseConnections.get(requestId)
      if (sseRes && !sseRes.writableEnded) {
        try {
          const data = JSON.stringify({ type: 'cancelled' })
          sseRes.write(`data: ${data}\n\n`)
          sseRes.end()
        } catch { /* ignore */ }
      }
      agentSseConnections.delete(requestId)
      if (currentRequestId === requestId) currentRequestId = null
      return ack
    }

    case 'plan_proposal': {
      const pending = pendingOneShot.get(requestId)
      if (pending) {
        pendingOneShot.delete(requestId)
        if (currentRequestId === requestId) currentRequestId = null
        const children = (input['children'] as Array<{ goal: string; suggested_depends_on?: string[] }> ?? [])
          .map((c) => ({ goal: c.goal, suggested_depends_on: c.suggested_depends_on ?? [] }))
        pending.resolve({ root: input['root'], children })
      }
      return ack
    }

    case 'tasks_proposal': {
      const pending = pendingOneShot.get(requestId)
      if (pending) {
        pendingOneShot.delete(requestId)
        if (currentRequestId === requestId) currentRequestId = null
        const tasks = (input['tasks'] as Array<{ goal: string; plan?: string[]; suggested_depends_on?: string[] }> ?? [])
          .map((t) => ({ goal: t.goal, plan: t.plan ?? [], suggested_depends_on: t.suggested_depends_on ?? [] }))
        pending.resolve(tasks)
      }
      return ack
    }

    case 'tasks_diff': {
      const pending = pendingOneShot.get(requestId)
      if (pending) {
        pendingOneShot.delete(requestId)
        if (currentRequestId === requestId) currentRequestId = null
        const unchanged = (input['unchanged'] as string[] | undefined) ?? []
        const modified = (input['modified'] as Array<{ replaces_id: string; goal: string; plan?: string[]; suggested_depends_on?: string[] }> | undefined) ?? []
        const added = (input['added'] as Array<{ goal: string; plan?: string[]; suggested_depends_on?: string[] }> | undefined) ?? []
        const removed = (input['removed'] as string[] | undefined) ?? []
        pending.resolve({
          unchanged,
          modified: modified.map((m) => ({ replaces_id: m.replaces_id, goal: m.goal, plan: m.plan ?? [], suggested_depends_on: m.suggested_depends_on ?? [] })),
          added: added.map((a) => ({ goal: a.goal, plan: a.plan ?? [], suggested_depends_on: a.suggested_depends_on ?? [] })),
          removed,
        })
      }
      return ack
    }

    default:
      return { content: [{ type: 'text' as const, text: JSON.stringify({ error: `Unknown tool: ${name}` }) }] }
  }
})

// ── Connect to Claude Code ────────────────────────────────────────────────────

const transport = new StdioServerTransport()

// Mark disconnected when Claude Code closes the stdio pipe
process.stdin.on('close', () => {
  sessionConnected = false
})

await mcp.connect(transport)
sessionConnected = true

// ── HTTP utility helpers ──────────────────────────────────────────────────────

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = []
    req.on('data', (chunk: Buffer) => chunks.push(chunk))
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')))
    req.on('error', reject)
  })
}

function jsonResponse(res: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body)
  res.writeHead(status, { 'Content-Type': 'application/json' })
  res.end(payload)
}

// ── HTTP Server ───────────────────────────────────────────────────────────────

const httpServer = createServer(async (req: IncomingMessage, res: ServerResponse) => {
  const url = new URL(req.url ?? '/', `http://localhost`)

  try {
    // GET /status
    if (req.method === 'GET' && url.pathname === '/status') {
      jsonResponse(res, 200, {
        connected: sessionConnected,
        busy: currentRequestId !== null,
        currentRequestId,
      })
      return
    }

    // GET /stream/:requestId — SSE stream for agent progress events
    if (req.method === 'GET' && url.pathname.startsWith('/stream/')) {
      const requestId = url.pathname.slice('/stream/'.length)
      res.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        Connection: 'keep-alive',
      })
      agentSseConnections.set(requestId, res)
      req.on('close', () => agentSseConnections.delete(requestId))
      // Keep alive ping every 15s
      const ping = setInterval(() => {
        if (res.writableEnded) { clearInterval(ping); return }
        try { res.write(': ping\n\n') } catch { clearInterval(ping) }
      }, 15_000)
      res.on('close', () => clearInterval(ping))
      return
    }

    // POST /request — submit a work request
    if (req.method === 'POST' && url.pathname === '/request') {
      if (!sessionConnected) {
        jsonResponse(res, 503, { error: 'Claude Code session not connected' })
        return
      }
      if (currentRequestId !== null) {
        jsonResponse(res, 503, { error: 'Channel busy' })
        return
      }

      const body = await readBody(req)
      const { requestId, type, payload } = JSON.parse(body) as { requestId: string; type: string; payload: RequestPayload }

      currentRequestId = requestId
      const content = buildChannelContent(requestId, type, payload)

      if (type === 'run_agent') {
        // Non-blocking: return 202, agent events come over SSE
        await mcp.notification({
          method: 'notifications/claude/channel',
          params: { content, meta: { request_id: requestId, type } },
        })
        jsonResponse(res, 202, { requestId })
      } else {
        // Blocking long-poll: wait for Claude to call the reply tool
        const TIMEOUT_MS = type === 'generate_plan' ? 120_000 : 60_000
        let timeoutHandle: ReturnType<typeof setTimeout> | null = null

        try {
          const result = await Promise.race([
            new Promise((resolve, reject) => {
              pendingOneShot.set(requestId, { resolve, reject })
              mcp.notification({
                method: 'notifications/claude/channel',
                params: { content, meta: { request_id: requestId, type } },
              }).catch(reject)
            }),
            new Promise((_, reject) => {
              timeoutHandle = setTimeout(() => {
                pendingOneShot.delete(requestId)
                if (currentRequestId === requestId) currentRequestId = null
                reject(new Error(`Request timed out after ${TIMEOUT_MS / 1000}s`))
              }, TIMEOUT_MS)
            }),
          ])
          jsonResponse(res, 200, { result })
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err)
          jsonResponse(res, 500, { error: message })
        } finally {
          if (timeoutHandle !== null) clearTimeout(timeoutHandle)
        }
      }
      return
    }

    // POST /control — cancel a running agent
    if (req.method === 'POST' && url.pathname === '/control') {
      const body = await readBody(req)
      const { requestId, action } = JSON.parse(body) as { requestId: string; action: string }

      if (action === 'cancel') {
        await mcp.notification({
          method: 'notifications/claude/channel',
          params: {
            content: `Stop your current work on request ${requestId} immediately and call agent_cancelled.`,
            meta: { request_id: requestId, type: 'control', action: 'cancel' },
          },
        })
      }
      jsonResponse(res, 200, { ok: true })
      return
    }

    // POST /message — inject a human message into a running agent
    if (req.method === 'POST' && url.pathname === '/message') {
      const body = await readBody(req)
      const { requestId, message } = JSON.parse(body) as { requestId: string; message: string }

      if (currentRequestId !== requestId) {
        jsonResponse(res, 400, { error: 'Request not active' })
        return
      }

      await mcp.notification({
        method: 'notifications/claude/channel',
        params: {
          content: message,
          meta: { request_id: requestId, type: 'human_message' },
        },
      })
      jsonResponse(res, 200, { ok: true })
      return
    }

    res.writeHead(404)
    res.end('Not found')
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    console.error('[channel-server] HTTP error:', message)
    if (!res.headersSent) jsonResponse(res, 500, { error: message })
  }
})

httpServer.listen(CHANNEL_PORT, '127.0.0.1', () => {
  console.error(`[conductor-channel] HTTP API listening on http://127.0.0.1:${CHANNEL_PORT}`)
})
