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
  NextTaskSchema,
  GetHistorySchema,
  VerifyTaskSchema,
  ListGoalsSchema,
  GetGoalBriefSchema,
  AddItemSchema,
  RememberSchema,
  ForgetSchema,
  EndRunSchema,
  RunGoalSchema,
  GoalsTickSchema,
  GoalsOverviewSchema,
  DecideItemSchema,
  CancelRunSchema,
  SetGoalStatusSchema,
  AttachAgentSchema,
  FailRunSchema,
  GuardCheckSchema,
  CreateGoalSchema,
  DeleteMemorySchema,
  SetScheduleSchema,
  UpdateGoalSchema,
  ReportRunEndSchema,
  TodoListSchema,
  TodoAddSchema,
  TodoSetSchema,
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
import { next_task } from './tools/next_task.js'
import { get_history } from './tools/get_history.js'
import { verify_task } from './tools/verify_task.js'
import { list_goals, get_goal_brief, add_item, remember, forget, end_run, run_goal } from './tools/goals.js'
import {
  goals_tick, goals_overview, decide_item, cancel_run, set_goal_status, attach_agent, fail_run, guard_check,
  create_goal, delete_memory, set_schedule, update_goal, report_run_end,
} from './tools/goal_runner.js'
import { todo_list, todo_add, todo_set } from './tools/todos.js'
import { handleListResources, handleReadResource } from './resources.js'
import { getRun } from './db.js'
import { withScope } from './session.js'

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
    description: 'Create a new task. Pass parent_id to create a child of an existing task. Omit parent_id only when creating the very first root task on an empty tree. Decompose work into sub-tasks before starting it — not after problems arise. For sequential work, create all sibling tasks upfront with depends_on and status="pending" so the dependency graph is explicit from the start. Prefer smaller, concrete tasks over large vague ones; a task should have a clear completion condition. Make that condition checkable with verification gates: acceptance_criteria (statements you will give evidence for), verify_command (a command that must exit 0, e.g. the relevant tests), and requires_approval for work a human should sign off. Gates can only be changed while the task is pending.',
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
    description: 'Change the status of a task. Provide task_id explicitly. When an approach fails or hits a hard blocker, abandon it with a specific reason before creating an alternative sibling — the reason is visible to sibling tasks and prevents repeating the same mistake. When completing a task, make sure its children are all resolved first. Activating a task with unmet depends_on will return an error; complete the dependencies first. If the task has verification gates, completing it runs them: pass evidence (one entry per acceptance criterion, in order); Conductor runs verify_command and refuses completion if it fails (showing the output); if requires_approval is set, the task then waits for a human to approve it in the web UI.',
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
    description: 'Read-only. Returns the context view for a task: the task itself, its parent, siblings, children, and tree-wide stats. Omit task_id to get the root task ("1"). Call this to inspect any task at any time. If no plan is open, it will tell you — use list_plans and open_plan first.',
    inputSchema: zodToJsonSchema(GetContextSchema),
    handler: get_context,
  },
  {
    name: 'provision_tasks',
    description: 'Create multiple tasks in a single call by providing a map of absolute task IDs to task specs. Use this instead of repeated create_task calls when you want to lay out an entire plan or sub-tree at once. IDs are hierarchical addresses ("1", "1.1", "1.2.3"); parent IDs must exist in the DB or be included in the batch. All tasks are inserted atomically — either all succeed or none do. Focus moves to the shallowest, lowest-numbered task created. Duplicate IDs (already in DB) are rejected; use update_task to modify existing tasks.',
    inputSchema: zodToJsonSchema(ProvisionTasksSchema),
    handler: provision_tasks,
  },
  {
    name: 'next_task',
    description: 'Read-only. Tells you what to work on next in the open plan, so you don\'t have to walk the tree yourself. Returns action "continue" (an active task already in progress), "start" (a pending task whose dependencies are complete), "complete" (a task whose children are all resolved — synthesize it, then complete it), "fix" (an active task whose last verify command failed), or "none" with the reason (all done, tasks awaiting human review, or which tasks are blocked and on what). Includes the full context view for the chosen task. Call this when resuming a plan or after finishing a task.',
    inputSchema: zodToJsonSchema(NextTaskSchema),
    handler: next_task,
  },
  {
    name: 'get_history',
    description: 'Read-only. Recent changes to the open plan, newest first: who made each change (actor "agent" = Claude, "human" = the web UI), what changed, and old/new values for edits and status changes. Pass task_id to see only that task and its sub-tasks. Use this when resuming a plan to see what happened since you last worked on it, including edits a human made in the UI.',
    inputSchema: zodToJsonSchema(GetHistorySchema),
    handler: get_history,
  },
  {
    name: 'verify_task',
    description: "Runs a task's verify_command now, without completing it, and returns pass/fail with the output, plus the task's gates (acceptance criteria, approval, last check). Use it to check your work before calling set_status completed. The result is saved as evidence.",
    inputSchema: zodToJsonSchema(VerifyTaskSchema),
    handler: verify_task,
  },
  {
    name: 'list_goals',
    description: 'List persistent goals (standing objectives like "keep my inbox under control" that never finish). Shows open items, items waiting for human review, and last/next run.',
    inputSchema: zodToJsonSchema(ListGoalsSchema),
    handler: list_goals,
  },
  {
    name: 'get_goal_brief',
    description: 'Start of every goal run: returns everything you need in one call — objective, standing instructions, autonomy per action category, memory (rules, facts, preferences), human decisions since the last run (approvals, rejections with feedback), open items (approved ones to carry out first), and recent run summaries. Opens the goal. Pass the run_id you were given.',
    inputSchema: zodToJsonSchema(GetGoalBriefSchema),
    handler: get_goal_brief,
  },
  {
    name: 'add_item',
    description: 'Add a work item to the open goal. Always pass external_ref for things that come from outside (an email, an issue) so the same thing is never added twice — an existing item is returned instead. With an action: "propose" categories create an item that waits for human approval (do not act until approved), "auto" categories record an action you already took, "off" categories are refused.',
    inputSchema: zodToJsonSchema(AddItemSchema),
    handler: add_item,
  },
  {
    name: 'remember',
    description: "Save a fact, rule or preference to the goal's memory so future runs know it. Keep each one short and general.",
    inputSchema: zodToJsonSchema(RememberSchema),
    handler: remember,
  },
  {
    name: 'forget',
    description: 'Deactivate a memory an agent created that turned out wrong or stale. Human-written memories can only be changed by the human.',
    inputSchema: zodToJsonSchema(ForgetSchema),
    handler: forget,
  },
  {
    name: 'end_run',
    description: 'Finish the current goal run with a summary: what you did, what waits for the human, what you learned. Required at the end of every run; the next run reads it.',
    inputSchema: zodToJsonSchema(EndRunSchema),
    handler: end_run,
  },
  {
    name: 'run_goal',
    description: 'Queue a run of a goal now (e.g. after changing its instructions). It starts within about 30 seconds while Claude Code is open with the conductor-goals plugin.',
    inputSchema: zodToJsonSchema(RunGoalSchema),
    handler: run_goal,
  },
  {
    name: 'todo_list',
    description: "The person's to-do lists for a project (the active plans in its directory), with each to-do's id and status. Read-only. Use it when they ask what's on their list, or after a compaction when they refer to it.",
    inputSchema: zodToJsonSchema(TodoListSchema),
    handler: todo_list,
  },
  {
    name: 'todo_add',
    description: "Adds a to-do to the person's list for a project, so it survives the conversation. Add only what they ask you to, or offer first when an idea is clearly being put off for later.",
    inputSchema: zodToJsonSchema(TodoAddSchema),
    handler: todo_add,
  },
  {
    name: 'todo_set',
    description: "Ticks a to-do off (completed), puts it back (pending), or marks it under way (active) with a note. Only when the person says it's done or asks you to.",
    inputSchema: zodToJsonSchema(TodoSetSchema),
    handler: todo_set,
  },
  {
    name: 'goals_overview',
    description: 'Every goal that is not retired, with items waiting for the human, open items, recent runs, health and memory, in one call. Pass the last etag to get { changed: false } when nothing changed.',
    inputSchema: zodToJsonSchema(GoalsOverviewSchema),
    handler: goals_overview,
  },
  // Used by the conductor-goals plugin to drive runs; agents must not call these.
  ...([
    ['goals_tick', 'Runs one goal scheduler pass and claims the runs that are due.', GoalsTickSchema, goals_tick],
    ['decide_item', "Records the human's approval or rejection of a goal item.", DecideItemSchema, decide_item],
    ['cancel_run', "Cancels a goal's run in progress.", CancelRunSchema, cancel_run],
    ['set_goal_status', 'Pauses or resumes a goal.', SetGoalStatusSchema, set_goal_status],
    ['attach_agent', 'Records which subagent is doing a goal run.', AttachAgentSchema, attach_agent],
    ['fail_run', 'Marks a goal run failed or timed out.', FailRunSchema, fail_run],
    ['guard_check', "Applies a goal's autonomy to a tool call made during a run.", GuardCheckSchema, guard_check],
    ['create_goal', 'Creates a goal for the human.', CreateGoalSchema, create_goal],
    ['delete_memory', "Deletes one of a goal's memories for the human.", DeleteMemorySchema, delete_memory],
    ['set_schedule', "Sets a goal's schedule (interval, cron, or none) for the human.", SetScheduleSchema, set_schedule],
    ['update_goal', "Changes a goal's name, objective, instructions, autonomy, tool rules, memory or status, once the human has confirmed.", UpdateGoalSchema, update_goal],
    ['report_run_end', "Reports how a goal run's agent finished a turn: a usage limit skips the run and holds goal runs until the reset.", ReportRunEndSchema, report_run_end],
  ] as const).map(([name, description, schema, handler]) => ({
    name,
    description: `${description} For the conductor-goals plugin only: agents and the model must not call this.`,
    inputSchema: zodToJsonSchema(schema),
    handler: handler as (args: unknown) => Promise<unknown>,
  })),
]

/** Set by the conductor-goals plugin on calls from a goal run's subagent: the call acts on that run's goal. */
const RUN_SCOPE = {
  type: 'string',
  description: 'Set automatically for goal runs; leave it out.',
}

function withRunScopeProperty(schema: object): object {
  const s = schema as { properties?: Record<string, unknown> }
  return s.properties ? { ...s, properties: { ...s.properties, run_scope: RUN_SCOPE } } : schema
}

const server = new Server(
  { name: 'conductor', version: '1.0.0' },
  { capabilities: { tools: {}, resources: {} } },
)

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: TOOLS.map(({ name, description, inputSchema }) => ({ name, description, inputSchema: withRunScopeProperty(inputSchema) })),
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
    const { run_scope: runScope, ...args } = (request.params.arguments ?? {}) as Record<string, unknown>
    const result = typeof runScope === 'string' && runScope
      ? await withScope({ planId: getRun(runScope)?.plan_id ?? null, runId: runScope }, () => tool.handler(args))
      : await tool.handler(args)
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
