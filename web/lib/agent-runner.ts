import type Anthropic from '@anthropic-ai/sdk'
import { getAnthropicClient, getBraveSearchApiKey } from './conductor-config'
import { generateNickname } from './agent-nickname'
import {
  toolListDir, toolReadFile, toolWriteFile, toolEditFile,
  toolGlobFiles, toolSearchFiles, toolRunCommand, toolWebSearch,
} from './agent-tools'
import { nanoid } from 'nanoid'
import {
  getPlan, getTask, getTreeStats, getChildren, getSiblings,
  createSession, updateSession, getActiveSession, lockSubtree, unlockSubtree,
  insertTask, updateTask, touchPlan, nextChildId,
} from './db'
import { recordEvent } from './event-log'
import { broadcast } from './ws-broadcaster'

// ─── In-memory abort controllers (pause/cancel) ───────────────────────────────
const abortControllers = new Map<string, AbortController>()

// ─── Pending human messages (prompt bar injection) ─────────────────────────────
const pendingMessages = new Map<string, string[]>()

export function enqueueUserMessage(planId: string, message: string): void {
  const queue = pendingMessages.get(planId) ?? []
  queue.push(message)
  pendingMessages.set(planId, queue)
}

function drainUserMessages(planId: string): string[] {
  const msgs = pendingMessages.get(planId) ?? []
  pendingMessages.delete(planId)
  return msgs
}

// ─── Prompt construction ──────────────────────────────────────────────────────

function buildSystemPrompt(planName: string, rootTaskId: string, workingDir: string | null): string {
  return `You are an AI agent working within a task tree plan management system.
You have access to tools for managing your work and for reading/writing files and running commands.

Your current assignment is task ${rootTaskId} in plan "${planName}".${workingDir ? `\nYour working directory is: ${workingDir}` : ''}
Your autonomy level is: full (proceed without pausing).

Task management rules:
- Work only within your assigned subtree (task ${rootTaskId} and its descendants).
- Do not navigate above task ${rootTaskId}.
- When decomposing a task into subtasks, use create_task then navigate into each child.
- If a subtask fails, abandon it with a clear reason and create an alternative sibling.
- Use the state field to store structured data for downstream tasks.
- Use the result field for human-readable summaries.
- Always call set_status completed with a result summary when finishing a task.
- Proceed without pausing. The human will intervene if needed.

Filesystem and execution rules:
- Use list_dir and read_file to understand the codebase before making changes.
- Use search_files to locate relevant code; use glob_files to find files by name pattern.
- Prefer edit_file for targeted changes to existing files; use write_file only for new files or complete rewrites.
- After making changes, use run_command to verify (run tests, lint, build) where appropriate.
- All file paths are relative to your working directory unless absolute.`
}

function buildInitialMessage(task: ReturnType<typeof getTask> & {}): string {
  return `Here is your current context:

Task ${task.id}: "${task.goal}"
Status: ${task.status}

Begin working on this task. Decompose it into child tasks as needed, execute them in order, and mark them complete when done.`
}

// ─── Tool definitions matching Conductor MCP tools ────────────────────────────

function getToolDefinitions(projectId: string, rootTaskId: string): Anthropic.Tool[] {
  return [
    {
      name: 'get_context',
      description: 'Get the current task context view.',
      input_schema: { type: 'object' as const, properties: {} },
    },
    {
      name: 'create_task',
      description: 'Create a child task under the current focus task.',
      input_schema: {
        type: 'object' as const,
        required: ['goal'],
        properties: {
          goal: { type: 'string' },
          status: { type: 'string', enum: ['active', 'pending'] },
          depends_on: { type: 'array', items: { type: 'string' } },
        },
      },
    },
    {
      name: 'update_task',
      description: 'Record progress on the current focus task.',
      input_schema: {
        type: 'object' as const,
        properties: {
          result: { type: 'string' },
          state_patch: { type: 'object' },
        },
      },
    },
    {
      name: 'set_status',
      description: 'Change a task status to active, completed, or abandoned.',
      input_schema: {
        type: 'object' as const,
        required: ['status'],
        properties: {
          target_id: { type: 'string' },
          status: { type: 'string', enum: ['active', 'pending', 'completed', 'abandoned'] },
          reason: { type: 'string' },
          result: { type: 'string' },
        },
      },
    },
    {
      name: 'navigate',
      description: 'Move focus to a different task.',
      input_schema: {
        type: 'object' as const,
        required: ['target_id'],
        properties: { target_id: { type: 'string' } },
      },
    },
    {
      name: 'synthesize',
      description: 'Get a summary of direct children grouped by completion status.',
      input_schema: {
        type: 'object' as const,
        properties: { target_id: { type: 'string' } },
      },
    },
    // ── Filesystem tools ──────────────────────────────────────────────────────
    {
      name: 'list_dir',
      description: 'List files and directories at a path (relative to working directory).',
      input_schema: {
        type: 'object' as const,
        properties: { path: { type: 'string', description: 'Directory path. Defaults to working directory.' } },
      },
    },
    {
      name: 'read_file',
      description: 'Read the contents of a file (up to 50KB). Use for source files, configs, docs.',
      input_schema: {
        type: 'object' as const,
        required: ['path'],
        properties: { path: { type: 'string' } },
      },
    },
    {
      name: 'write_file',
      description: 'Write or create a file with the given content. Creates parent directories automatically. Use for new files or complete rewrites only.',
      input_schema: {
        type: 'object' as const,
        required: ['path', 'content'],
        properties: {
          path: { type: 'string' },
          content: { type: 'string' },
        },
      },
    },
    {
      name: 'edit_file',
      description: 'Replace an exact string in a file with a new string. The old_string must be unique in the file. Preferred over write_file for targeted edits.',
      input_schema: {
        type: 'object' as const,
        required: ['path', 'old_string', 'new_string'],
        properties: {
          path: { type: 'string' },
          old_string: { type: 'string', description: 'Exact text to find and replace (must be unique in the file, include surrounding context if needed)' },
          new_string: { type: 'string', description: 'Text to replace it with' },
        },
      },
    },
    {
      name: 'glob_files',
      description: 'Find files by name/path pattern (e.g. "**/*.ts", "src/*.tsx"). Returns matching file paths.',
      input_schema: {
        type: 'object' as const,
        required: ['pattern'],
        properties: {
          pattern: { type: 'string', description: 'Glob pattern, e.g. "**/*.ts" or "*.json"' },
          path: { type: 'string', description: 'Directory to search in. Defaults to working directory.' },
        },
      },
    },
    {
      name: 'search_files',
      description: 'Search file contents using a regex pattern (like grep). Returns matching lines with file and line number.',
      input_schema: {
        type: 'object' as const,
        required: ['pattern'],
        properties: {
          pattern: { type: 'string', description: 'Regex pattern to search for' },
          path: { type: 'string', description: 'Directory to search in. Defaults to working directory.' },
          glob: { type: 'string', description: 'Optional file glob filter, e.g. "*.ts"' },
        },
      },
    },
    // ── Shell tool ────────────────────────────────────────────────────────────
    {
      name: 'run_command',
      description: 'Run a shell command in the working directory. Use to run tests, builds, linters, git commands, etc. Returns stdout, stderr, and exit code.',
      input_schema: {
        type: 'object' as const,
        required: ['command'],
        properties: {
          command: { type: 'string', description: 'Shell command to execute' },
          timeout: { type: 'number', description: 'Timeout in milliseconds (default 30000, max 120000)' },
        },
      },
    },
    // ── Web search ────────────────────────────────────────────────────────────
    {
      name: 'web_search',
      description: 'Search the web for information. Requires BRAVE_SEARCH_API_KEY to be configured in Settings.',
      input_schema: {
        type: 'object' as const,
        required: ['query'],
        properties: { query: { type: 'string' } },
      },
    },
  ]
}

// ─── Tool dispatch ────────────────────────────────────────────────────────────

interface AgentState {
  focusTaskId: string
  planId: string
  rootTaskId: string
  sessionId: string
}

async function dispatchTool(
  toolName: string,
  toolInput: Record<string, unknown>,
  state: AgentState,
  workingDir: string,
): Promise<string> {
  const { planId, sessionId } = state

  switch (toolName) {
    case 'get_context': {
      const task = getTask(planId, state.focusTaskId)
      if (!task) return JSON.stringify({ error: 'No open task' })
      const parts = task.id.split('.')
      const parentId = parts.length > 1 ? parts.slice(0, -1).join('.') : null
      const parent = parentId ? getTask(planId, parentId) : null
      return JSON.stringify({
        plan: getPlan(planId),
        focus: task,
        parent: parent ? { id: parent.id, goal: parent.goal, status: parent.status } : null,
        children: getChildren(planId, task.id),
        siblings: getSiblings(planId, task.id),
        tree_stats: getTreeStats(planId),
      })
    }

    case 'create_task': {
      const { goal, status = 'active', depends_on } = toolInput as {
        goal: string; status?: 'active' | 'pending'; depends_on?: string[]
      }
      const childId = nextChildId(planId, state.focusTaskId)
      const now = new Date().toISOString()
      insertTask({
        id: childId,
        plan_id: planId,
        goal,
        status,
        result: null,
        abandon_reason: null,
        state: {},
        depends_on: depends_on ?? null,
        created_by: 'agent',
        created_at: now,
        updated_at: now,
      })
      touchPlan(planId)
      recordEvent({ planId, taskId: childId, eventType: 'task_created', actor: 'agent', sessionId, payload: { goal } })
      state.focusTaskId = childId
      return JSON.stringify({ created: childId, task: getTask(planId, childId) })
    }

    case 'update_task': {
      const { result, state_patch } = toolInput as {
        result?: string; state_patch?: Record<string, unknown>
      }
      const task = getTask(planId, state.focusTaskId)
      if (!task) return JSON.stringify({ error: 'No focus task' })
      const now = new Date().toISOString()
      const fields: Record<string, unknown> = { updated_at: now }
      if (result !== undefined) fields['result'] = result
      if (state_patch) fields['state'] = { ...task.state, ...state_patch }
      updateTask(planId, state.focusTaskId, fields)
      touchPlan(planId)
      recordEvent({ planId, taskId: state.focusTaskId, eventType: 'task_updated', actor: 'agent', sessionId, payload: { result } })
      return JSON.stringify({ updated: state.focusTaskId, task: getTask(planId, state.focusTaskId) })
    }

    case 'set_status': {
      const { target_id, status, reason, result } = toolInput as {
        target_id?: string; status: 'active' | 'pending' | 'completed' | 'abandoned'; reason?: string; result?: string
      }
      const targetId = target_id ?? state.focusTaskId
      const task = getTask(planId, targetId)
      if (!task) return JSON.stringify({ error: `Task ${targetId} not found` })
      const now = new Date().toISOString()
      const fields: Record<string, unknown> = { status, updated_at: now }
      if (status === 'abandoned' && reason) fields['abandon_reason'] = reason
      if (result !== undefined) fields['result'] = result
      updateTask(planId, targetId, fields)
      touchPlan(planId)
      recordEvent({ planId, taskId: targetId, eventType: 'status_changed', actor: 'agent', sessionId, payload: { to: status, reason } })
      return JSON.stringify({ updated: targetId, status, task: getTask(planId, targetId) })
    }

    case 'navigate': {
      const { target_id } = toolInput as { target_id: string }
      const task = getTask(planId, target_id)
      if (!task) return JSON.stringify({ error: `Task ${target_id} not found` })
      state.focusTaskId = target_id
      return JSON.stringify({ focus: target_id, task })
    }

    case 'synthesize': {
      const { target_id } = toolInput as { target_id?: string }
      const targetId = target_id ?? state.focusTaskId
      const children = getChildren(planId, targetId)
      return JSON.stringify({
        completed: children.filter((c) => c.status === 'completed'),
        abandoned: children.filter((c) => c.status === 'abandoned'),
        pending: children.filter((c) => c.status !== 'completed' && c.status !== 'abandoned'),
      })
    }

    // ── Filesystem tools ────────────────────────────────────────────────────
    case 'list_dir': {
      const { path: p = '.' } = toolInput as { path?: string }
      return toolListDir(workingDir, p)
    }
    case 'read_file': {
      const { path: p } = toolInput as { path: string }
      return toolReadFile(workingDir, p)
    }
    case 'write_file': {
      const { path: p, content } = toolInput as { path: string; content: string }
      return toolWriteFile(workingDir, p, content)
    }
    case 'edit_file': {
      const { path: p, old_string, new_string } = toolInput as { path: string; old_string: string; new_string: string }
      return toolEditFile(workingDir, p, old_string, new_string)
    }
    case 'glob_files': {
      const { pattern, path: p } = toolInput as { pattern: string; path?: string }
      return toolGlobFiles(workingDir, pattern, p)
    }
    case 'search_files': {
      const { pattern, path: p, glob } = toolInput as { pattern: string; path?: string; glob?: string }
      return toolSearchFiles(workingDir, pattern, p, glob)
    }
    // ── Shell tool ──────────────────────────────────────────────────────────
    case 'run_command': {
      const { command, timeout } = toolInput as { command: string; timeout?: number }
      return toolRunCommand(workingDir, command, timeout)
    }
    // ── Web search ──────────────────────────────────────────────────────────
    case 'web_search': {
      const { query } = toolInput as { query: string }
      return toolWebSearch(query, getBraveSearchApiKey() ?? '')
    }

    default:
      return JSON.stringify({ error: `Unknown tool: ${toolName}` })
  }
}

// ─── Agent runner ─────────────────────────────────────────────────────────────

export async function startAgent(planId: string, rootTaskId: string): Promise<{ sessionId: string }> {
  const existing = getActiveSession(planId)
  if (existing) throw new Error(`An agent session is already active for this plan: ${existing.id}`)

  const plan = getPlan(planId)
  if (!plan) throw new Error(`Plan ${planId} not found`)

  const task = getTask(planId, rootTaskId)
  if (!task) throw new Error(`Task ${rootTaskId} not found`)

  const sessionId = nanoid()
  const now = new Date().toISOString()

  createSession({
    id: sessionId,
    plan_id: planId,
    root_task_id: rootTaskId,
    nickname: generateNickname(),
    status: 'running',
    autonomy_level: 'full',
    model: 'claude-sonnet-4-6',
    started_at: now,
  })

  lockSubtree(sessionId, planId, rootTaskId)
  recordEvent({ planId, taskId: rootTaskId, eventType: 'agent_started', actor: 'agent', sessionId })
  broadcast(planId, { type: 'agent_started', sessionId, rootTaskId })

  const controller = new AbortController()
  abortControllers.set(planId, controller)

  // Run agent asynchronously (non-blocking)
  runAgentLoop(sessionId, planId, rootTaskId, plan.name, plan.working_dir, task, controller).catch((err) => {
    console.error('[AgentRunner] Unhandled error:', err)
  })

  return { sessionId }
}

async function createMessageWithRetry(
  client: ReturnType<typeof getAnthropicClient>,
  params: Anthropic.MessageCreateParamsNonStreaming,
  controller: AbortController,
  maxRetries = 3,
): Promise<Anthropic.Message> {
  let delay = 60_000 // start with 60s for rate limit errors
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    if (controller.signal.aborted) throw new Error('Aborted')
    try {
      return await client.messages.create(params)
    } catch (err) {
      const isRateLimit = err instanceof Error && (
        err.message.includes('rate_limit_error') || err.message.startsWith('429')
      )
      if (!isRateLimit || attempt === maxRetries) throw err
      // Wait, then retry
      await new Promise<void>((resolve, reject) => {
        const t = setTimeout(resolve, delay)
        controller.signal.addEventListener('abort', () => { clearTimeout(t); reject(new Error('Aborted')) }, { once: true })
      })
      delay = Math.min(delay * 1.5, 300_000) // cap at 5 min
    }
  }
  throw new Error('Unreachable')
}

async function runAgentLoop(
  sessionId: string,
  planId: string,
  rootTaskId: string,
  planName: string,
  workingDir: string | null,
  rootTask: NonNullable<ReturnType<typeof getTask>>,
  controller: AbortController,
): Promise<void> {
  const client = getAnthropicClient()
  const state: AgentState = { focusTaskId: rootTaskId, planId, rootTaskId, sessionId }

  const messages: Anthropic.MessageParam[] = [
    { role: 'user', content: buildInitialMessage(rootTask) },
  ]

  let inputTokens = 0
  let outputTokens = 0

  try {
    while (true) {
      if (controller.signal.aborted) break

      // Inject any queued human messages before the next API call
      for (const msg of drainUserMessages(planId)) {
        messages.push({ role: 'user', content: msg })
        recordEvent({ planId, taskId: state.focusTaskId, eventType: 'human_prompt', actor: 'human', sessionId, payload: { message: msg } })
        broadcast(planId, { type: 'human_prompt', sessionId, message: msg })
      }

      const response = await createMessageWithRetry(client, {
        model: 'claude-sonnet-4-6',
        max_tokens: 4096,
        system: buildSystemPrompt(planName, rootTaskId, workingDir),
        tools: getToolDefinitions(planId, rootTaskId),
        messages,
      }, controller)

      inputTokens += response.usage.input_tokens
      outputTokens += response.usage.output_tokens

      // Broadcast progress
      broadcast(planId, {
        type: 'agent_turn',
        sessionId,
        stop_reason: response.stop_reason,
        content: response.content.filter((b) => b.type === 'text'),
      })

      // Persist agent text turns to the event log
      const textContent = response.content
        .filter((b): b is Anthropic.TextBlock => b.type === 'text')
        .map((b) => b.text)
        .join('\n')
        .trim()
      if (textContent) {
        recordEvent({ planId, taskId: state.focusTaskId, eventType: 'agent_message', actor: 'agent', sessionId, payload: { text: textContent } })
      }

      messages.push({ role: 'assistant', content: response.content })

      if (response.stop_reason === 'end_turn') {
        // Drain any pending human messages that arrived while the agent was working.
        // If the prompt bar enqueued a message concurrently with the first API call,
        // it may not have been visible at the top-of-loop drain — give it one more chance.
        const remaining = drainUserMessages(planId)
        if (remaining.length === 0) break
        for (const msg of remaining) {
          messages.push({ role: 'user', content: msg })
          recordEvent({ planId, taskId: state.focusTaskId, eventType: 'human_prompt', actor: 'human', sessionId, payload: { message: msg } })
          broadcast(planId, { type: 'human_prompt', sessionId, message: msg })
        }
        // Don't break — let the agent respond to the injected messages
        continue
      }

      if (response.stop_reason === 'tool_use') {
        const toolResults: Anthropic.ToolResultBlockParam[] = []

        for (const block of response.content) {
          if (block.type !== 'tool_use') continue
          if (controller.signal.aborted) break

          const result = await dispatchTool(block.name, block.input as Record<string, unknown>, state, workingDir ?? process.cwd())
          const parsedResult = JSON.parse(result)
          broadcast(planId, {
            type: 'tool_call',
            sessionId,
            tool: block.name,
            input: block.input,
            result: parsedResult,
          })

          // Persist tool calls that have visible side-effects so they show in the activity feed
          if (['run_command', 'edit_file', 'write_file', 'web_search'].includes(block.name)) {
            const input = block.input as Record<string, unknown>
            const summary: Record<string, unknown> = { tool: block.name }
            if (block.name === 'run_command') summary.command = input['command']
            else if (block.name === 'edit_file' || block.name === 'write_file') summary.path = input['path']
            else if (block.name === 'web_search') summary.query = input['query']
            if (parsedResult && typeof parsedResult === 'object') {
              if ('exit_code' in parsedResult) summary.exit_code = parsedResult.exit_code
              if ('error' in parsedResult) summary.error = parsedResult.error
            }
            recordEvent({ planId, taskId: state.focusTaskId, eventType: 'tool_call', actor: 'agent', sessionId, payload: summary })
          }

          toolResults.push({ type: 'tool_result', tool_use_id: block.id, content: result })
        }

        messages.push({ role: 'user', content: toolResults })
      }

      // Pause check
      const session = getActiveSession(planId)
      if (!session || session.status === 'paused') {
        // Wait for resume — poll until unpaused or cancelled
        await waitForResume(planId, controller)
        if (controller.signal.aborted) break
      }
    }

    if (!controller.signal.aborted) {
      updateSession(sessionId, { status: 'completed', ended_at: new Date().toISOString(), input_tokens: inputTokens, output_tokens: outputTokens })
      recordEvent({ planId, taskId: rootTaskId, eventType: 'agent_completed', actor: 'agent', sessionId })
      broadcast(planId, { type: 'agent_completed', sessionId, input_tokens: inputTokens, output_tokens: outputTokens })
    }
  } catch (err) {
    const errMsg = err instanceof Error ? err.message : String(err)
    updateSession(sessionId, { status: 'failed', ended_at: new Date().toISOString(), error: errMsg, input_tokens: inputTokens, output_tokens: outputTokens })
    recordEvent({ planId, taskId: rootTaskId, eventType: 'agent_failed', actor: 'agent', sessionId, payload: { error: errMsg } })
    broadcast(planId, { type: 'agent_failed', sessionId, error: errMsg })
  } finally {
    unlockSubtree(sessionId, planId)
    abortControllers.delete(planId)
    pendingMessages.delete(planId)
  }
}

async function waitForResume(planId: string, controller: AbortController): Promise<void> {
  return new Promise((resolve) => {
    const interval = setInterval(() => {
      if (controller.signal.aborted) {
        clearInterval(interval)
        resolve()
        return
      }
      const session = getActiveSession(planId)
      if (!session || session.status === 'running') {
        clearInterval(interval)
        resolve()
      }
    }, 500)
  })
}

export function pauseAgent(planId: string): void {
  const session = getActiveSession(planId)
  if (!session || session.status !== 'running') throw new Error('No running agent session')
  updateSession(session.id, { status: 'paused' })
  recordEvent({ planId, taskId: session.root_task_id, eventType: 'agent_paused', actor: 'human', sessionId: session.id })
  broadcast(planId, { type: 'agent_paused', sessionId: session.id })
}

export function resumeAgent(planId: string): void {
  const session = getActiveSession(planId)
  if (!session || session.status !== 'paused') throw new Error('No paused agent session')
  updateSession(session.id, { status: 'running' })
  recordEvent({ planId, taskId: session.root_task_id, eventType: 'agent_resumed', actor: 'human', sessionId: session.id })
  broadcast(planId, { type: 'agent_resumed', sessionId: session.id })
}

export function cancelAgent(planId: string): void {
  const session = getActiveSession(planId)
  if (!session) throw new Error('No active agent session')

  const controller = abortControllers.get(planId)
  if (controller) controller.abort()

  updateSession(session.id, { status: 'cancelled', ended_at: new Date().toISOString() })
  unlockSubtree(session.id, planId)
  recordEvent({ planId, taskId: session.root_task_id, eventType: 'agent_cancelled', actor: 'human', sessionId: session.id })
  broadcast(planId, { type: 'agent_cancelled', sessionId: session.id })
}
