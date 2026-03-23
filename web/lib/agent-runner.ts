import Anthropic from '@anthropic-ai/sdk'
import { nanoid } from 'nanoid'
import {
  getProject, getTask, getTreeStats, getChildren, getSiblings,
  createSession, updateSession, getActiveSession, lockSubtree, unlockSubtree,
  insertTask, updateTask, touchProject, nextChildId,
} from './db'
import { recordEvent } from './event-log'
import { broadcast } from './ws-broadcaster'

// ─── In-memory abort controllers (pause/cancel) ───────────────────────────────
const abortControllers = new Map<string, AbortController>()

// ─── Prompt construction ──────────────────────────────────────────────────────

function buildSystemPrompt(projectName: string, rootTaskId: string, workingDir: string | null): string {
  return `You are an AI agent working within a task tree project management system.
You have access to tools for managing your work: create_task, update_task, navigate, set_status, synthesize, get_context.

Your current assignment is task ${rootTaskId} in project "${projectName}".${workingDir ? `\nYour working directory is: ${workingDir}` : ''}
Your autonomy level is: full (proceed without pausing).

Rules:
- Work only within your assigned subtree (task ${rootTaskId} and its descendants).
- Do not navigate above task ${rootTaskId}.
- Update your progress via update_task after meaningful work.
- When decomposing a task into subtasks, create them as children.
- If a subtask fails, abandon it with a clear reason and create an alternative sibling.
- Use the state field to store structured data for downstream tasks.
- Use the result field for human-readable summaries.
- Proceed without pausing. The human will intervene if needed.`
}

function buildInitialMessage(task: ReturnType<typeof getTask> & {}): string {
  return `Here is your current context:

Task ${task.id}: "${task.goal}"
Status: ${task.status}
Plan:
${task.plan.map((s, i) => `  ${i + 1}. ${s}`).join('\n')}
Current step: ${task.step + 1}

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
        required: ['goal', 'plan'],
        properties: {
          goal: { type: 'string' },
          plan: { type: 'array', items: { type: 'string' } },
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
        required: ['result'],
        properties: {
          result: { type: 'string' },
          advance_step: { type: 'boolean' },
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
  ]
}

// ─── Tool dispatch ────────────────────────────────────────────────────────────

interface AgentState {
  focusTaskId: string
  projectId: string
  rootTaskId: string
  sessionId: string
}

function dispatchTool(
  toolName: string,
  toolInput: Record<string, unknown>,
  state: AgentState,
): string {
  const { projectId, sessionId } = state

  switch (toolName) {
    case 'get_context': {
      const task = getTask(projectId, state.focusTaskId)
      if (!task) return JSON.stringify({ error: 'No open task' })
      const parts = task.id.split('.')
      const parentId = parts.length > 1 ? parts.slice(0, -1).join('.') : null
      const parent = parentId ? getTask(projectId, parentId) : null
      return JSON.stringify({
        project: getProject(projectId),
        focus: task,
        parent: parent ? { id: parent.id, goal: parent.goal, status: parent.status } : null,
        children: getChildren(projectId, task.id),
        siblings: getSiblings(projectId, task.id),
        tree_stats: getTreeStats(projectId),
      })
    }

    case 'create_task': {
      const { goal, plan, status = 'active', depends_on } = toolInput as {
        goal: string; plan: string[]; status?: 'active' | 'pending'; depends_on?: string[]
      }
      const childId = nextChildId(projectId, state.focusTaskId)
      const now = new Date().toISOString()
      insertTask({
        id: childId,
        project_id: projectId,
        goal,
        plan,
        step: 0,
        status,
        result: null,
        abandon_reason: null,
        state: {},
        depends_on: depends_on ?? null,
        created_by: 'agent',
        created_at: now,
        updated_at: now,
      })
      touchProject(projectId)
      recordEvent({ projectId, taskId: childId, eventType: 'task_created', actor: 'agent', sessionId, payload: { goal } })
      state.focusTaskId = childId
      return JSON.stringify({ created: childId, task: getTask(projectId, childId) })
    }

    case 'update_task': {
      const { result, advance_step, state_patch } = toolInput as {
        result: string; advance_step?: boolean; state_patch?: Record<string, unknown>
      }
      const task = getTask(projectId, state.focusTaskId)
      if (!task) return JSON.stringify({ error: 'No focus task' })
      const now = new Date().toISOString()
      const fields: Record<string, unknown> = { result, updated_at: now }
      if (advance_step) fields['step'] = Math.min(task.step + 1, task.plan.length - 1)
      if (state_patch) fields['state'] = { ...task.state, ...state_patch }
      updateTask(projectId, state.focusTaskId, fields)
      touchProject(projectId)
      recordEvent({ projectId, taskId: state.focusTaskId, eventType: 'task_updated', actor: 'agent', sessionId, payload: { result } })
      return JSON.stringify({ updated: state.focusTaskId, task: getTask(projectId, state.focusTaskId) })
    }

    case 'set_status': {
      const { target_id, status, reason } = toolInput as {
        target_id?: string; status: 'active' | 'pending' | 'completed' | 'abandoned'; reason?: string
      }
      const targetId = target_id ?? state.focusTaskId
      const task = getTask(projectId, targetId)
      if (!task) return JSON.stringify({ error: `Task ${targetId} not found` })
      const now = new Date().toISOString()
      const fields: Record<string, unknown> = { status, updated_at: now }
      if (status === 'abandoned' && reason) fields['abandon_reason'] = reason
      updateTask(projectId, targetId, fields)
      touchProject(projectId)
      recordEvent({ projectId, taskId: targetId, eventType: 'status_changed', actor: 'agent', sessionId, payload: { to: status, reason } })
      return JSON.stringify({ updated: targetId, status, task: getTask(projectId, targetId) })
    }

    case 'navigate': {
      const { target_id } = toolInput as { target_id: string }
      const task = getTask(projectId, target_id)
      if (!task) return JSON.stringify({ error: `Task ${target_id} not found` })
      state.focusTaskId = target_id
      return JSON.stringify({ focus: target_id, task })
    }

    case 'synthesize': {
      const { target_id } = toolInput as { target_id?: string }
      const targetId = target_id ?? state.focusTaskId
      const children = getChildren(projectId, targetId)
      return JSON.stringify({
        completed: children.filter((c) => c.status === 'completed'),
        abandoned: children.filter((c) => c.status === 'abandoned'),
        pending: children.filter((c) => c.status !== 'completed' && c.status !== 'abandoned'),
      })
    }

    default:
      return JSON.stringify({ error: `Unknown tool: ${toolName}` })
  }
}

// ─── Agent runner ─────────────────────────────────────────────────────────────

export async function startAgent(projectId: string, rootTaskId: string): Promise<{ sessionId: string }> {
  const existing = getActiveSession(projectId)
  if (existing) throw new Error(`An agent session is already active for this project: ${existing.id}`)

  const project = getProject(projectId)
  if (!project) throw new Error(`Project ${projectId} not found`)

  const task = getTask(projectId, rootTaskId)
  if (!task) throw new Error(`Task ${rootTaskId} not found`)

  const sessionId = nanoid()
  const now = new Date().toISOString()

  createSession({
    id: sessionId,
    project_id: projectId,
    root_task_id: rootTaskId,
    status: 'running',
    autonomy_level: 'full',
    model: 'claude-sonnet-4-6',
    started_at: now,
  })

  lockSubtree(sessionId, projectId, rootTaskId)
  recordEvent({ projectId, taskId: rootTaskId, eventType: 'agent_started', actor: 'agent', sessionId })
  broadcast(projectId, { type: 'agent_started', sessionId, rootTaskId })

  const controller = new AbortController()
  abortControllers.set(projectId, controller)

  // Run agent asynchronously (non-blocking)
  runAgentLoop(sessionId, projectId, rootTaskId, project.name, project.working_dir, task, controller).catch((err) => {
    console.error('[AgentRunner] Unhandled error:', err)
  })

  return { sessionId }
}

async function runAgentLoop(
  sessionId: string,
  projectId: string,
  rootTaskId: string,
  projectName: string,
  workingDir: string | null,
  rootTask: NonNullable<ReturnType<typeof getTask>>,
  controller: AbortController,
): Promise<void> {
  const client = new Anthropic()
  const state: AgentState = { focusTaskId: rootTaskId, projectId, rootTaskId, sessionId }

  const messages: Anthropic.MessageParam[] = [
    { role: 'user', content: buildInitialMessage(rootTask) },
  ]

  let inputTokens = 0
  let outputTokens = 0

  try {
    while (true) {
      if (controller.signal.aborted) break

      const response = await client.messages.create({
        model: 'claude-sonnet-4-6',
        max_tokens: 4096,
        system: buildSystemPrompt(projectName, rootTaskId, workingDir),
        tools: getToolDefinitions(projectId, rootTaskId),
        messages,
      })

      inputTokens += response.usage.input_tokens
      outputTokens += response.usage.output_tokens

      // Broadcast progress
      broadcast(projectId, {
        type: 'agent_turn',
        sessionId,
        stop_reason: response.stop_reason,
        content: response.content.filter((b) => b.type === 'text'),
      })

      messages.push({ role: 'assistant', content: response.content })

      if (response.stop_reason === 'end_turn') break

      if (response.stop_reason === 'tool_use') {
        const toolResults: Anthropic.ToolResultBlockParam[] = []

        for (const block of response.content) {
          if (block.type !== 'tool_use') continue
          if (controller.signal.aborted) break

          const result = dispatchTool(block.name, block.input as Record<string, unknown>, state)
          broadcast(projectId, {
            type: 'tool_call',
            sessionId,
            tool: block.name,
            input: block.input,
            result: JSON.parse(result),
          })

          toolResults.push({ type: 'tool_result', tool_use_id: block.id, content: result })
        }

        messages.push({ role: 'user', content: toolResults })
      }

      // Pause check
      const session = getActiveSession(projectId)
      if (!session || session.status === 'paused') {
        // Wait for resume — poll until unpaused or cancelled
        await waitForResume(projectId, controller)
        if (controller.signal.aborted) break
      }
    }

    if (!controller.signal.aborted) {
      updateSession(sessionId, { status: 'completed', ended_at: new Date().toISOString(), input_tokens: inputTokens, output_tokens: outputTokens })
      recordEvent({ projectId, taskId: rootTaskId, eventType: 'agent_completed', actor: 'agent', sessionId })
      broadcast(projectId, { type: 'agent_completed', sessionId, input_tokens: inputTokens, output_tokens: outputTokens })
    }
  } catch (err) {
    const errMsg = err instanceof Error ? err.message : String(err)
    updateSession(sessionId, { status: 'failed', ended_at: new Date().toISOString(), error: errMsg, input_tokens: inputTokens, output_tokens: outputTokens })
    recordEvent({ projectId, taskId: rootTaskId, eventType: 'agent_failed', actor: 'agent', sessionId, payload: { error: errMsg } })
    broadcast(projectId, { type: 'agent_failed', sessionId, error: errMsg })
  } finally {
    unlockSubtree(sessionId, projectId)
    abortControllers.delete(projectId)
  }
}

async function waitForResume(projectId: string, controller: AbortController): Promise<void> {
  return new Promise((resolve) => {
    const interval = setInterval(() => {
      if (controller.signal.aborted) {
        clearInterval(interval)
        resolve()
        return
      }
      const session = getActiveSession(projectId)
      if (!session || session.status === 'running') {
        clearInterval(interval)
        resolve()
      }
    }, 500)
  })
}

export function pauseAgent(projectId: string): void {
  const session = getActiveSession(projectId)
  if (!session || session.status !== 'running') throw new Error('No running agent session')
  updateSession(session.id, { status: 'paused' })
  recordEvent({ projectId, taskId: session.root_task_id, eventType: 'agent_paused', actor: 'human', sessionId: session.id })
  broadcast(projectId, { type: 'agent_paused', sessionId: session.id })
}

export function resumeAgent(projectId: string): void {
  const session = getActiveSession(projectId)
  if (!session || session.status !== 'paused') throw new Error('No paused agent session')
  updateSession(session.id, { status: 'running' })
  recordEvent({ projectId, taskId: session.root_task_id, eventType: 'agent_resumed', actor: 'human', sessionId: session.id })
  broadcast(projectId, { type: 'agent_resumed', sessionId: session.id })
}

export function cancelAgent(projectId: string): void {
  const session = getActiveSession(projectId)
  if (!session) throw new Error('No active agent session')

  const controller = abortControllers.get(projectId)
  if (controller) controller.abort()

  updateSession(session.id, { status: 'cancelled', ended_at: new Date().toISOString() })
  unlockSubtree(session.id, projectId)
  recordEvent({ projectId, taskId: session.root_task_id, eventType: 'agent_cancelled', actor: 'human', sessionId: session.id })
  broadcast(projectId, { type: 'agent_cancelled', sessionId: session.id })
}
