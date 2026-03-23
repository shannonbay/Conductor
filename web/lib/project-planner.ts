import type Anthropic from '@anthropic-ai/sdk'
import path from 'path'
import { z } from 'zod'
import type { ProjectRow, Task } from './db'
import type { ProposedTask } from './planning'
import { getAnthropicClient } from './conductor-config'
import { safeResolvePath, toolListDir, toolReadFile } from './agent-tools'

export interface ProjectPlanProposal {
  root: { goal: string }
  children: ProposedTask[]
}

const ProposedTaskSchema = z.object({
  goal: z.string().min(1),
  suggested_depends_on: z.array(z.string()).default([]),
})

const SubmitPlanSchema = z.object({
  root: z.object({
    goal: z.string().min(1),
  }),
  children: z.array(ProposedTaskSchema).min(1),
})

const MAX_TOOL_CALLS = 50

function buildSystemPrompt(project: ProjectRow, existingTasks: Task[]): string {
  const tasksSummary = existingTasks.length > 0
    ? `\nExisting tasks:\n${existingTasks.map(t => `  ${t.id}: "${t.goal}" [${t.status}]`).join('\n')}`
    : '\nNo tasks exist yet — propose a complete task tree from scratch.'

  return `You are a project planning expert. Your job is to explore a software project and propose a structured task tree.

Project: "${project.name}"${project.description ? `\nDescription: "${project.description}"` : ''}
Working directory: ${project.working_dir}
${tasksSummary}

Instructions:
1. Start by listing the working directory. Read 3-5 of the most informative files (e.g. README, package.json, CLAUDE.md, a key source file relevant to the project goal).
2. If the project name/description already makes the goal clear, you may skip deep file exploration and submit immediately.
3. Call submit_plan as soon as you have enough context — do NOT read every file. Err on the side of submitting early.

Rules for your plan:
- The root task goal should be a concise statement of the project's primary objective.
- Each child task should be concrete and actionable.
- Order children logically; use suggested_depends_on to express sequencing (by child index, 0-based).
- Do not propose tasks that are already completed.
- Aim for 3-5 children for focused tasks, up to 7 for larger projects.`
}

export async function generateProjectPlan(
  project: ProjectRow,
  existingTasks: Task[],
): Promise<ProjectPlanProposal> {
  const messages: Anthropic.MessageParam[] = [
    {
      role: 'user',
      content: `Please explore the project at "${project.working_dir}" and propose a task tree plan. Call submit_plan when ready.`,
    },
  ]

  const tools: Anthropic.Tool[] = [
    {
      name: 'list_dir',
      description: 'List files and directories at the given path (relative to project root or absolute within it)',
      input_schema: {
        type: 'object' as const,
        properties: { path: { type: 'string', description: 'Directory path to list' } },
        required: ['path'],
      },
    },
    {
      name: 'read_file',
      description: 'Read the contents of a file (max 20KB, truncated if larger)',
      input_schema: {
        type: 'object' as const,
        properties: { path: { type: 'string', description: 'File path to read' } },
        required: ['path'],
      },
    },
    {
      name: 'submit_plan',
      description: 'Submit the proposed task tree plan. Call this when you have enough context.',
      input_schema: {
        type: 'object' as const,
        properties: {
          root: {
            type: 'object',
            description: 'The root task representing the overall project goal',
            properties: {
              goal: { type: 'string', description: 'Concise statement of the project\'s primary objective' },
            },
            required: ['goal'],
          },
          children: {
            type: 'array',
            description: '3-7 concrete child tasks',
            items: {
              type: 'object',
              properties: {
                goal: { type: 'string' },
                suggested_depends_on: { type: 'array', items: { type: 'string' }, description: 'Indices of sibling tasks this depends on (e.g. ["0", "1"])' },
              },
              required: ['goal', 'suggested_depends_on'],
            },
          },
        },
        required: ['root', 'children'],
      },
    },
  ]

  let toolCallCount = 0

  while (toolCallCount < MAX_TOOL_CALLS) {
    const response = await getAnthropicClient().messages.create({
      model: 'claude-sonnet-4-6',
      max_tokens: 4096,
      system: buildSystemPrompt(project, existingTasks),
      tools,
      messages,
    })

    messages.push({ role: 'assistant', content: response.content })

    if (response.stop_reason === 'end_turn') {
      throw new Error('Claude finished without calling submit_plan')
    }

    const toolUses = response.content.filter(b => b.type === 'tool_use')
    if (toolUses.length === 0) {
      throw new Error('No tool calls in response')
    }

    const toolResults: Anthropic.ToolResultBlockParam[] = []
    let planProposal: ProjectPlanProposal | null = null

    for (const block of toolUses) {
      if (block.type !== 'tool_use') continue
      toolCallCount++

      let result: string
      if (block.name === 'list_dir') {
        const input = block.input as { path: string }
        result = await toolListDir(project.working_dir, input.path)
      } else if (block.name === 'read_file') {
        const input = block.input as { path: string }
        result = await toolReadFile(project.working_dir, input.path)
      } else if (block.name === 'submit_plan') {
        const parsed = SubmitPlanSchema.safeParse(block.input)
        if (!parsed.success) {
          result = JSON.stringify({ error: `Invalid plan format: ${parsed.error.message}` })
        } else {
          planProposal = parsed.data
          result = JSON.stringify({ ok: true })
        }
      } else {
        result = JSON.stringify({ error: `Unknown tool: ${block.name}` })
      }

      toolResults.push({ type: 'tool_result', tool_use_id: block.id, content: result })
    }

    messages.push({ role: 'user', content: toolResults })

    if (planProposal) return planProposal
  }

  throw new Error(`Exceeded maximum tool calls (${MAX_TOOL_CALLS}) without submitting a plan`)
}
