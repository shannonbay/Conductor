import { z } from 'zod'

export const CreatePlanSchema = z.object({
  name: z.string().min(1).describe('Human-readable plan name'),
  description: z.string().optional().describe('Optional summary of the plan\'s purpose'),
  working_dir: z.string().optional().describe('Working directory for the plan. Defaults to the server\'s current working directory.'),
})

export const ListPlansSchema = z.object({
  status: z.enum(['active', 'archived', 'all']).default('active').describe('Filter by status'),
})

export const OpenPlanSchema = z.object({
  plan_id: z.string().describe('ID of the plan to open'),
})

export const ArchivePlanSchema = z.object({
  plan_id: z.string().describe('ID of the plan to archive'),
})

/** Verification gates a task can carry. All must pass before it can be completed. */
const GateFields = {
  acceptance_criteria: z.array(z.string().min(1)).max(20).optional().describe(
    'Checkable statements that must be true when the task is done, e.g. "GET /users returns 401 without a token". ' +
    'When completing, you must give evidence for each one.'),
  verify_command: z.string().min(1).nullable().optional().describe(
    'Shell command Conductor runs in the plan\'s working_dir when you complete the task, e.g. "npm test -- auth". ' +
    'It must exit 0 or completion is refused. Pass null to remove (pending tasks only).'),
  verify_timeout_s: z.number().int().min(1).max(3600).optional().describe('Timeout for verify_command in seconds (default 300)'),
  requires_approval: z.boolean().optional().describe(
    'If true, a human must approve the task in the web UI before it is completed.'),
}

export const CreateTaskSchema = z.object({
  goal: z.string().min(1).describe('What this task should accomplish'),
  parent_id: z.string().optional().describe('ID of the parent task. Omit only when creating the first root task on an empty tree.'),
  initial_state: z.record(z.unknown()).optional().describe('Freeform starting state (default {})'),
  depends_on: z.array(z.string()).optional().describe('Sibling task IDs that must complete first'),
  status: z.enum(['active', 'pending']).default('active').describe('Initial status'),
  ...GateFields,
})

export const UpdateTaskSchema = z.object({
  task_id: z.string().describe('ID of the task to update'),
  result: z.string().optional().describe('Human-readable summary of progress or outcome'),
  state_patch: z.record(z.unknown()).optional().describe('Shallow-merge patch applied to state'),
  notes: z.string().nullable().optional().describe('Freeform text scratchpad — use for mid-task observations, corrections, or context for downstream tasks. Unlike result, notes can be set and updated at any point. Pass null to clear.'),
  goal: z.string().min(1).optional().describe('Rename the task goal. Only allowed while the task is still pending — throws if the task is active, completed, or abandoned.'),
  ...GateFields,
})

export const SetStatusSchema = z.object({
  task_id: z.string().describe('ID of the task to update'),
  status: z.enum(['active', 'pending', 'completed', 'abandoned']).describe('New status'),
  reason: z.string().optional().describe('Required when status is abandoned'),
  result: z.string().optional().describe('Optional summary of what the task produced'),
  evidence: z.array(z.string()).optional().describe(
    'When completing a task with acceptance_criteria: one entry per criterion, in order, saying how it is met ' +
    '(e.g. "covered by auth.test.ts: rejects missing token").'),
})

// ── Persistent goals ──────────────────────────────────────────────────────────

export const ListGoalsSchema = z.object({
  status: z.enum(['active', 'paused', 'retired', 'all']).default('active').describe('Filter by goal status'),
})

export const GetGoalBriefSchema = z.object({
  goal_id: z.string().describe('ID of the goal (its plan ID)'),
  run_id: z.string().optional().describe('The run you were started for (given in the run request). Items you add are attributed to it.'),
})

export const AddItemSchema = z.object({
  goal: z.string().min(1).describe('Short description of the work item, e.g. "Reply to Alice about Thursday"'),
  external_ref: z.string().min(1).optional().describe(
    'Stable ID of the thing this is about, e.g. "gmail:18c2f…". If an item with this ref already exists it is returned instead of creating a duplicate.'),
  action: z.object({
    category: z.string().min(1).describe('Action category, e.g. "email.send". Its autonomy mode is in the brief.'),
    summary: z.string().min(1).describe('One line the human will read when approving, e.g. "Send reply confirming Thursday 2pm"'),
    params: z.record(z.unknown()).optional().describe('Exact details needed to carry the action out later (ids, draft id, labels)'),
  }).optional().describe(
    'An action this item is about. "propose" categories create an item that waits for human approval; "auto" categories record an action you already took; "off" categories are refused.'),
  status: z.enum(['pending', 'active']).optional().describe('For items without an action (default pending)'),
  ask_person: z.boolean().optional().describe(
    'true: this item asks the person for something only they can give or do (a choice, details, connecting a service, allowing a site). It waits under Needs you and alerts them; their answer arrives as memory.'),
  result: z.string().optional().describe('For auto actions: what you did'),
  notes: z.string().optional(),
})

export const RememberSchema = z.object({
  kind: z.enum(['fact', 'rule', 'preference']).describe('fact: "Alice is my manager"; rule: "Never archive mail from the bank"; preference: "Keep drafts short"'),
  text: z.string().min(1).describe('One clear statement'),
  source_ref: z.string().optional().describe('Item or run this came from'),
})

export const ForgetSchema = z.object({
  memory_id: z.string().describe('ID of a memory you (an agent) created'),
})

export const EndRunSchema = z.object({
  summary: z.string().min(1).describe('What you did this run, what is waiting for the human, and anything you learned'),
  run_id: z.string().optional().describe('Defaults to the run from get_goal_brief'),
})

export const RunGoalSchema = z.object({
  goal_id: z.string().describe('ID of the goal to run'),
})

// ── Goal runner (called by the conductor-goals plugin, not by agents) ─────────

export const GoalsTickSchema = z.object({
  holder: z.string().min(1).describe('The Claude Code session asking (its session id)'),
  tracked_run_ids: z.array(z.string()).default([]).describe('Runs this holder is tracking itself; never expired by the pass'),
  max_concurrent: z.number().int().min(1).max(10).optional().describe('Most runs at once across all goals (default 3)'),
  release: z.boolean().optional().describe('Give the scheduler lease up instead of running a pass (the session is ending)'),
})

export const GoalsOverviewSchema = z.object({
  etag: z.string().optional().describe('The etag from the last overview; an unchanged overview answers { changed: false }'),
})

export const DecideItemSchema = z.object({
  goal_id: z.string(),
  item_id: z.string(),
  decision: z.enum(['approve', 'reject', 'answer']),
  feedback: z.string().optional().describe('Required when rejecting; the answer when answering a question item'),
})

export const CancelRunSchema = z.object({
  goal_id: z.string(),
  reason: z.string().optional(),
})

export const DeleteGoalSchema = z.object({
  goal_id: z.string(),
})

export const SetGoalStatusSchema = z.object({
  goal_id: z.string(),
  status: z.enum(['active', 'paused']),
})

export const AttachAgentSchema = z.object({
  run_id: z.string(),
  agent_id: z.string(),
})

export const FailRunSchema = z.object({
  run_id: z.string(),
  status: z.enum(['failed', 'timed_out']).default('failed'),
  reason: z.string().min(1),
})

export const GuardCheckSchema = z.object({
  run_id: z.string(),
  tool_name: z.string().describe('The tool the run agent is about to call'),
})

const GoalScheduleSchema = z.union([
  z.object({
    kind: z.literal('interval'),
    minutes: z.number().int().min(5).describe('Run every N minutes (at least 5)'),
    active_hours: z.string().regex(/^\d{2}:\d{2}-\d{2}:\d{2}$/).optional().describe('Only run inside this local-time window, e.g. "08:00-20:00"'),
  }),
  z.object({ kind: z.literal('cron'), expr: z.string().min(1).describe('5-field cron, local time') }),
  z.null(),
])

export const CreateGoalSchema = z.object({
  name: z.string().trim().min(1),
  objective: z.string().trim().min(1),
  working_dir: z.string().min(1).describe('Where its runs work'),
  instructions: z.string().optional(),
  autonomy: z.record(z.enum(['off', 'propose', 'auto'])).optional().describe('Category → off | propose | auto'),
  tool_map: z.record(z.string()).optional().describe('Tool name pattern → category'),
  schedule: GoalScheduleSchema.optional().describe('When it runs on its own; left out or null, on demand'),
  one_off: z.boolean().optional().describe('Runs once now; done when its run leaves nothing open'),
})

export const SetScheduleSchema = z.object({
  goal_id: z.string(),
  schedule: GoalScheduleSchema.describe('null makes the goal run only on demand'),
  one_off: z.boolean().optional().describe('With schedule null: the goal runs once and is done when its run leaves nothing open'),
})

// ── The person's to-do lists ────────────────────────────────────────────────────

export const TodoListSchema = z.object({
  working_dir: z.string().min(1).describe("The project's directory; its lists are the active plans there"),
})

export const TodoAddSchema = z.object({
  working_dir: z.string().min(1),
  text: z.string().trim().min(1).describe('The to-do, in the words the person would use'),
  list_id: z.string().optional().describe('A list from todo_list; left out, the project\'s "To do" list (made on first use)'),
  added_by: z.enum(['human', 'agent']).default('human'),
})

export const TodoSetSchema = z.object({
  list_id: z.string(),
  item_id: z.string(),
  status: z.enum(['pending', 'active', 'completed']).describe('completed ticks it off; pending puts it back'),
  notes: z.string().optional(),
})

const Mode = z.enum(['off', 'propose', 'auto'])

export const UpdateGoalSchema = z.object({
  goal_id: z.string(),
  name: z.string().trim().min(1).optional(),
  objective: z.string().trim().min(1).optional(),
  instructions: z.string().optional().describe('Standing instructions; "" clears them'),
  autonomy: z.record(Mode.nullable()).optional().describe('Category → off | propose | auto; null removes the category'),
  tool_map: z.record(z.string().nullable()).optional().describe('Tool name pattern → category; null removes the rule'),
  add_memory: z.array(z.object({ kind: z.enum(['fact', 'rule', 'preference']), text: z.string().trim().min(1), pinned: z.boolean().optional() })).optional(),
  forget_memory: z.array(z.string()).optional().describe('Memory ids to forget'),
  status: z.enum(['active', 'paused']).optional(),
})

export const ReportRunEndSchema = z.object({
  run_id: z.string(),
  answer: z.string().describe("The run agent's final message"),
  reason: z.string().optional().describe("turn.complete's reason, e.g. error"),
  usage: z.object({
    input_tokens: z.number(), output_tokens: z.number(),
    cache_read_input_tokens: z.number(), cache_creation_input_tokens: z.number(),
    model: z.string().optional(),
  }).optional().describe("The turn's token counts, added to the run"),
})

export const DeleteMemorySchema = z.object({
  goal_id: z.string(),
  memory_id: z.string(),
})

export const VerifyTaskSchema = z.object({
  task_id: z.string().describe('ID of the task whose checks to run'),
})

export const SynthesizeSchema = z.object({
  task_id: z.string().describe('ID of the task whose children to synthesize'),
})

export const GetContextSchema = z.object({
  task_id: z.string().optional().describe('ID of the task to get context for. Defaults to the root task ("1") if omitted.'),
})

const TaskSpecSchema = z.object({
  goal: z.string().min(1).describe('What this task should accomplish'),
  status: z.enum(['active', 'pending']).default('pending').describe('Initial status'),
  depends_on: z.array(z.string()).optional().describe('Sibling task IDs that must complete first'),
  initial_state: z.record(z.unknown()).optional().describe('Freeform starting state (default {})'),
  ...GateFields,
})

export const NextTaskSchema = z.object({})

export const GetHistorySchema = z.object({
  task_id: z.string().optional().describe('Only changes to this task and its sub-tasks. Omit for the whole plan.'),
  limit: z.number().int().min(1).max(200).default(30).describe('Newest N changes (default 30, max 200)'),
})

export const ProvisionTasksSchema = z.object({
  tasks: z.record(z.string(), TaskSpecSchema).describe(
    'Map of task ID → spec. IDs are absolute hierarchical addresses e.g. "1", "1.1", "1.2.3". ' +
    'Parent IDs must exist in the DB or be included in this batch. ' +
    'Duplicate IDs (already in DB) are rejected. ' +
    'Root-level IDs (no dot) require the plan to be empty.'
  ),
})
