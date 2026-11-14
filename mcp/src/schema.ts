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
    'Shell command Quarterdeck runs in the plan\'s working_dir when you complete the task, e.g. "npm test -- auth". ' +
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
    category: z.string().min(1).describe('Action category, e.g. "email.send". Reuse one from known_categories in the brief when it fits the action; invent a new one only for a different kind of action. Its autonomy mode is in the brief.'),
    summary: z.string().min(1).describe('One line the human will read when approving, e.g. "Send reply confirming Thursday 2pm"'),
    params: z.record(z.unknown()).optional().describe('Exact details needed to carry the action out later (ids, draft id, labels)'),
  }).optional().describe(
    'An action this item is about. "propose" categories create an item that waits for human approval; "auto" categories record an action you already took; "off" categories are refused.'),
  status: z.enum(['pending', 'active']).optional().describe('For items without an action (default pending)'),
  ask_person: z.boolean().optional().describe(
    'true: this item asks the person for something only they can give or do (a choice, details, connecting a service, allowing a site). It waits under Needs you and alerts them; their answer arrives as memory. Keep goal to the short question and put what they need to answer it (the options, what you would do and why) in notes: the Goals pane shows notes under the question.'),
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
  status: z.string().max(200).optional().describe('A few words on how the goal stands now, shown in its one-line summary in the Goals pane until a later run changes it, e.g. "clean" or "2 PRs awaiting review" (plain text, cut to 40 characters). Set it when the goal\'s instructions say what it means; leave it out to keep the current one, or pass "" to clear it.'),
  status_check: z.object({
    kind: z.enum(['github_pr', 'github_issue']).describe('What to look at: a GitHub pull request or issue'),
    repo: z.string().describe('owner/name on GitHub'),
    number: z.number().int().positive().describe('The pull request or issue number'),
    holds_while: z.array(z.string()).min(1).describe('The states for which the status still holds: OPEN, CLOSED, MERGED (MERGED only for github_pr)'),
    otherwise: z.record(z.string()).optional().describe('What the status becomes for other states, e.g. {"MERGED": "PR #12 merged", "CLOSED": "PR #12 closed"}; any other state shows the status as stale'),
  }).optional().describe('Give it with status whenever the status describes something outside Quarterdeck that can change without this goal running (a PR awaiting review, an open issue): the scheduler checks it about every 5 minutes and updates the status. Setting or clearing the status later replaces or clears the check.'),
})

export const RunGoalSchema = z.object({
  goal_id: z.string().describe('ID of the goal to run'),
})

// ── Goal runner (called by the quarterdeck-goals plugin, not by agents) ─────────

export const GoalsTickSchema = z.object({
  holder: z.string().min(1).describe('The Claude Code session asking (its session id)'),
  tracked_run_ids: z.array(z.string()).default([]).describe('Runs this holder is tracking itself; never expired by the pass'),
  max_concurrent: z.number().int().min(1).max(10).optional().describe('Most runs at once across all goals (default 3)'),
  release: z.boolean().optional().describe('Give the scheduler lease up instead of running a pass (the session is ending)'),
  tool_watches: z.boolean().optional().describe('The caller checks tool watches: the due ones come back in tool_watches, to call and answer with watch_report'),
})

export const WatchReportSchema = z.object({
  watch_id: z.string(),
  text: z.string().optional().describe("The tool's answer as text"),
  error: z.string().optional().describe('Why the call failed, when it did'),
}).refine((v) => v.text !== undefined || v.error !== undefined, { message: 'Give the text the tool answered, or the error.' })

export const GoalsOverviewSchema = z.object({
  etag: z.string().optional().describe('The etag from the last overview; an unchanged overview answers { changed: false }'),
  detail: z.array(z.string()).optional().describe('Goal ids to give in full (runs, memory, open items, instructions, tool rules); the rest are cards. Left out: every goal in full'),
})

export const DecideItemSchema = z.object({
  goal_id: z.string(),
  item_id: z.string(),
  decision: z.enum(['approve', 'reject', 'answer']),
  feedback: z.string().optional().describe('Required when rejecting; the answer when answering a question item'),
})

export const GetItemSchema = z.object({
  goal_id: z.string(),
  item_id: z.string(),
})

export const CancelRunSchema = z.object({
  goal_id: z.string(),
  reason: z.string().optional(),
})

export const UnsubscribeOneClickSchema = z.object({
  url: z.string().describe("The https link from the message's List-Unsubscribe header (only when its List-Unsubscribe-Post header is List-Unsubscribe=One-Click)"),
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
  input: z.record(z.unknown()).optional().describe("The call's command and path fields, for the rule on Quarterdeck's own data"),
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

const WatchSchema = z.object({
  command: z.string().trim().min(1).optional().describe('A shell command, run in the goal\'s directory, that prints one line per current item (an issue number, a feed entry\'s id). Lines not seen before start a run; the first check only records what is there. Must exit 0'),
  tool: z.string().trim().min(1).optional().describe('Instead of a command: a connector or MCP tool (mcp__…) that only reads, called by the session that runs goals, e.g. a mail search'),
  input: z.record(z.unknown()).optional().describe("The tool's arguments"),
  match: z.string().optional().describe('A regular expression over the tool\'s answer; each match (its first group) is one line. Left out: every "id" in a JSON answer'),
  every_minutes: z.number().int().min(1).optional().describe('How often to check (default 5)'),
  fires: z.enum(['new', 'change']).optional().describe("'new' (default): a line never seen before starts a run. 'change': for a state (a working tree, a health URL): a run starts when the output differs from the last check, with the lines that weren't in it ((none) when it became empty)"),
}).refine((v) => (v.command === undefined) !== (v.tool === undefined), { message: 'A watch has a command or a tool, one of them.' })

export const CreateGoalSchema = z.object({
  name: z.string().trim().min(1),
  objective: z.string().trim().min(1),
  working_dir: z.string().min(1).describe('Where its runs work'),
  instructions: z.string().optional(),
  autonomy: z.record(z.enum(['off', 'propose', 'auto'])).optional().describe('Category → off | propose | auto'),
  tool_map: z.record(z.string()).optional().describe('Tool name pattern → category'),
  schedule: GoalScheduleSchema.optional().describe('When it runs on its own; left out or null, on demand'),
  one_off: z.boolean().optional().describe('Runs once now; done when its run leaves nothing open'),
  watches: z.record(WatchSchema).optional().describe('Watch name → what it checks: a run starts when a watch sees something new'),
  model: z.string().nullable().optional().describe("The model its runs use: haiku, sonnet, opus or a full model id; left out or null, the model of the session that starts each run"),
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
  status: z.enum(['pending', 'active', 'completed']).optional().describe('completed ticks it off; pending puts it back'),
  notes: z.string().optional(),
  text: z.string().trim().min(1).optional().describe("New wording for the to-do, only when the person asks for it"),
  changed_by: z.enum(['human', 'agent']).default('human'),
}).refine((v) => v.status !== undefined || v.notes !== undefined || v.text !== undefined, { message: 'Give a status, notes or text to change.' })

const Mode = z.enum(['off', 'propose', 'auto'])

export const UpdateGoalSchema = z.object({
  goal_id: z.string(),
  name: z.string().trim().min(1).optional(),
  objective: z.string().trim().min(1).optional(),
  instructions: z.string().optional().describe('Standing instructions; "" clears them'),
  autonomy: z.record(Mode.nullable()).optional().describe('Category → off | propose | auto; null removes the category'),
  tool_map: z.record(z.string().nullable()).optional().describe('Tool name pattern → category; null removes the rule'),
  merge_categories: z.record(z.string().trim().min(1)).optional().describe('Old action category → the category to merge it into: past items, autonomy and tool rules take the new name, so earlier approvals count toward the Switch to auto suggestion'),
  add_memory: z.array(z.object({ kind: z.enum(['fact', 'rule', 'preference']), text: z.string().trim().min(1), pinned: z.boolean().optional() })).optional(),
  forget_memory: z.array(z.string()).optional().describe('Memory ids to forget'),
  watches: z.record(WatchSchema.nullable()).optional().describe('Watch name → what it checks; null removes the watch. A run starts when a watch sees something new'),
  status: z.enum(['active', 'paused']).optional(),
  model: z.string().nullable().optional().describe("The model its runs use: haiku, sonnet, opus or a full model id; null: the model of the session that starts each run"),
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

export const RunProgressSchema = z.object({
  run_id: z.string(),
  event: z.enum(['tool', 'waiting', 'settled']).describe("tool: a call starting; waiting: put to the person for a permission answer; settled: finished, allowed or refused"),
  label: z.string().trim().min(1).max(200).describe('The call, as the pane shows it (`Bash: npm test`)'),
})

export const DeleteMemorySchema = z.object({
  goal_id: z.string(),
  memory_id: z.string(),
})

export const TrustMemorySchema = DeleteMemorySchema

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
