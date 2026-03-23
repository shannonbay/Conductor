import { z } from 'zod'
import type { Task } from './db'
import { getAnthropicClient } from './conductor-config'

export interface ProposedTask {
  goal: string
  plan: string[]
  suggested_depends_on: string[]
}

export interface ModifyDiff {
  unchanged: string[]
  modified: Array<ProposedTask & { replaces_id: string }>
  added: ProposedTask[]
  removed: string[]
}

const ProposedTaskSchema = z.object({
  goal: z.string().min(1),
  plan: z.array(z.string()).min(1),
  suggested_depends_on: z.array(z.string()).default([]),
})

const ProposedTasksSchema = z.array(ProposedTaskSchema)

const ModifyDiffSchema = z.object({
  unchanged: z.array(z.string()).default([]),
  modified: z.array(ProposedTaskSchema.extend({ replaces_id: z.string() })).default([]),
  added: z.array(ProposedTaskSchema).default([]),
  removed: z.array(z.string()).default([]),
})

function buildPlanningPrompt(
  projectName: string,
  task: Task,
  parentAndSiblingContext: string,
  instruction?: string,
): string {
  return `You are a planning assistant helping a human structure their work into a task tree.
You do NOT execute tasks. You propose task decompositions that the human will review.

Project: "${projectName}"
Task being planned: ${task.id} — "${task.goal}"

${parentAndSiblingContext}

Rules:
- Propose concrete, actionable child tasks with clear goals.
- Each proposed task should include a goal and 2-5 plan steps.
- Suggest dependencies between siblings where ordering matters (use sibling index 1, 2, 3... to reference).
- Keep decompositions to 3-7 children — enough detail to be useful, not so many as to be overwhelming.
- If any sibling tasks have been abandoned, note their reasons and avoid proposing approaches that would hit the same problems.
${instruction ? `\nAdditional instruction from the human: "${instruction}"` : ''}

Respond with ONLY a valid JSON array of proposed tasks. No markdown, no explanation. Format:
[
  {
    "goal": "...",
    "plan": ["step 1", "step 2", ...],
    "suggested_depends_on": []
  }
]`
}

function buildModifyPrompt(
  projectName: string,
  task: Task,
  existingChildren: Task[],
  instruction: string,
): string {
  const childrenJson = existingChildren.map((c) => ({
    id: c.id,
    goal: c.goal,
    status: c.status,
    result: c.result,
    abandon_reason: c.abandon_reason,
  }))

  return `You are a planning assistant helping a human restructure an existing task subtree.

Project: "${projectName}"
Parent task: ${task.id} — "${task.goal}"

Current children:
${JSON.stringify(childrenJson, null, 2)}

Human's modification request: "${instruction}"

Rules for modifications:
- NEVER propose removing or modifying tasks with status "completed" or "active".
- You may propose removing, splitting, merging, or reordering "pending" tasks.
- You may propose new tasks to add.
- "unchanged" lists task IDs that remain as-is.
- "modified" lists tasks that replace an existing pending task (include replaces_id).
- "added" lists brand new tasks.
- "removed" lists IDs of pending tasks to remove. Never include completed or active task IDs here.

Respond with ONLY a valid JSON object. No markdown, no explanation. Format:
{
  "unchanged": ["1.1", "1.2"],
  "modified": [{ "replaces_id": "1.3", "goal": "...", "plan": [...], "suggested_depends_on": [] }],
  "added": [{ "goal": "...", "plan": [...], "suggested_depends_on": [] }],
  "removed": ["1.4"]
}`
}

function formatParentSiblingContext(parentGoal: string | null, siblings: Task[]): string {
  const lines: string[] = []
  if (parentGoal) lines.push(`Parent task goal: "${parentGoal}"`)
  if (siblings.length > 0) {
    lines.push('\nSibling tasks:')
    for (const s of siblings) {
      const suffix = s.status === 'abandoned' && s.abandon_reason
        ? ` — abandoned: "${s.abandon_reason}"`
        : s.result ? ` — result: "${s.result}"` : ''
      lines.push(`  ${s.id}: "${s.goal}" [${s.status}]${suffix}`)
    }
  }
  return lines.join('\n')
}

function extractJson(text: string): string {
  // Strip markdown code blocks if present
  const match = text.match(/```(?:json)?\s*([\s\S]*?)```/)
  return match ? match[1].trim() : text.trim()
}

export async function generatePlan(
  task: Task,
  projectName: string,
  parentGoal: string | null,
  siblings: Task[],
  instruction?: string,
): Promise<ProposedTask[]> {
  const context = formatParentSiblingContext(parentGoal, siblings)
  const prompt = buildPlanningPrompt(projectName, task, context, instruction)

  const response = await getAnthropicClient().messages.create({
    model: 'claude-sonnet-4-6',
    max_tokens: 2048,
    messages: [{ role: 'user', content: prompt }],
  })

  const text = response.content.find((b) => b.type === 'text')?.text ?? ''
  const json = extractJson(text)
  const parsed = ProposedTasksSchema.parse(JSON.parse(json))
  return parsed
}

export async function modifyPlan(
  task: Task,
  projectName: string,
  existingChildren: Task[],
  instruction: string,
): Promise<ModifyDiff> {
  const prompt = buildModifyPrompt(projectName, task, existingChildren, instruction)

  const response = await getAnthropicClient().messages.create({
    model: 'claude-sonnet-4-6',
    max_tokens: 2048,
    messages: [{ role: 'user', content: prompt }],
  })

  const text = response.content.find((b) => b.type === 'text')?.text ?? ''
  const json = extractJson(text)
  const parsed = ModifyDiffSchema.parse(JSON.parse(json))

  // Safety: never remove completed or active tasks
  const protectedStatuses = new Set(['completed', 'active'])
  const childById = new Map(existingChildren.map((c) => [c.id, c]))
  parsed.removed = parsed.removed.filter((id) => {
    const child = childById.get(id)
    return child && !protectedStatuses.has(child.status)
  })

  return parsed
}
