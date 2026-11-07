/** MCP tools for persistent goals (specs/persistent-goals.md). */
import {
  listGoals, getGoal, buildBrief, addItem, insertMemory, getMemory, updateMemory, getRun, endRun, queueRun, countItems, touchPlan,
} from '../db.js'
import { getOpenPlan, setOpenPlan, getOpenRun, setOpenRun } from '../session.js'
import {
  ListGoalsSchema, GetGoalBriefSchema, AddItemSchema, RememberSchema, ForgetSchema, EndRunSchema, RunGoalSchema,
} from '../schema.js'
import { record } from '../history.js'

function requireOpenGoal(): string {
  const planId = getOpenPlan()
  if (!planId || !getGoal(planId)) {
    throw new Error('No goal is open. Call get_goal_brief with the goal_id first.')
  }
  return planId
}

export async function list_goals(args: unknown) {
  const input = ListGoalsSchema.parse(args)
  const goals = listGoals(input.status === 'all' ? undefined : input.status)
  return {
    goals: goals.map(({ plan, goal }) => {
      const counts = countItems(plan.id)
      return {
        id: plan.id,
        name: plan.name,
        objective: goal.objective,
        status: goal.status,
        open_items: counts.open ?? 0,
        awaiting_review: counts.awaiting_review ?? 0,
        last_run_at: goal.last_run_at,
        next_run_at: goal.next_run_at,
      }
    }),
  }
}

export async function get_goal_brief(args: unknown) {
  const input = GetGoalBriefSchema.parse(args)
  if (!getGoal(input.goal_id)) throw new Error(`Goal ${input.goal_id} not found. Use list_goals.`)
  const brief = buildBrief(input.goal_id, input.run_id)
  setOpenPlan(input.goal_id)
  if (input.run_id) setOpenRun(input.run_id)
  return {
    ...brief,
    how_to_work: [
      'First carry out items with approved_to_execute (their action was approved), then complete them with set_status.',
      'Revise items rejected in decisions_since_last_run using the feedback: update the proposal with update_task state_patch {"action": {category, summary, params}} so the human sees the new version, then set_status completed to send it for review again — or abandon it with a reason.',
      'Look for new work; add each piece with add_item (use external_ref so it is never duplicated).',
      'Respect autonomy: "auto" categories you may do and then record with add_item; "propose" categories go through add_item and wait for approval; "off" categories you must not do.',
      'Save anything worth knowing next time with remember. Finish with end_run and a short summary.',
    ],
  }
}

export async function add_item(args: unknown) {
  const input = AddItemSchema.parse(args)
  const planId = requireOpenGoal()
  const result = addItem(planId, getOpenRun(), input)
  if (!result.existing) {
    touchPlan(planId)
    record(planId, result.task.id, 'task_created', {
      goal: result.task.goal,
      status: result.task.status,
      ...(input.external_ref && { external_ref: input.external_ref }),
      ...(input.action && { action: input.action, mode: result.mode }),
    })
    if (result.mode === 'propose') record(planId, result.task.id, 'approval_requested', { action: input.action })
  }
  return {
    item: {
      id: result.task.id,
      goal: result.task.goal,
      status: result.task.status,
      external_ref: result.task.external_ref,
      awaiting_review: result.task.review_requested_at !== null,
    },
    existing: result.existing,
    ...(result.mode && { mode: result.mode }),
    message: result.existing
      ? 'An item for this external_ref already exists; nothing was created. Update it instead if needed.'
      : result.mode === 'propose'
      ? 'Proposed: waits for the human to approve. Do not carry out the action until it shows approved_to_execute.'
      : result.mode === 'auto'
      ? 'Recorded as done.'
      : 'Item created.',
  }
}

export async function remember(args: unknown) {
  const input = RememberSchema.parse(args)
  const planId = requireOpenGoal()
  const m = insertMemory({ plan_id: planId, kind: input.kind, text: input.text, source: 'agent', source_ref: input.source_ref ?? getOpenRun() })
  record(planId, planId, 'memory_added', { memory_id: m.id, kind: m.kind, text: m.text })
  return { memory: { id: m.id, kind: m.kind, text: m.text } }
}

export async function forget(args: unknown) {
  const input = ForgetSchema.parse(args)
  const planId = requireOpenGoal()
  const m = getMemory(input.memory_id)
  if (!m || m.plan_id !== planId) throw new Error(`Memory ${input.memory_id} not found in this goal.`)
  if (m.source !== 'agent') {
    throw new Error('You can only forget memories an agent created. Human-written and feedback memories are edited by the human in the web UI.')
  }
  updateMemory(m.id, { active: false })
  record(planId, planId, 'memory_forgotten', { memory_id: m.id, text: m.text })
  return { forgotten: m.id }
}

export async function end_run(args: unknown) {
  const input = EndRunSchema.parse(args)
  const planId = requireOpenGoal()
  const runId = input.run_id ?? getOpenRun()
  if (!runId) throw new Error('No run to end: you were not started for a run (get_goal_brief had no run_id).')
  const run = getRun(runId)
  if (!run || run.plan_id !== planId) throw new Error(`Run ${runId} not found in this goal.`)
  const ended = endRun(runId, input.summary)
  setOpenRun(null)
  record(planId, planId, 'run_completed', { run_id: runId, summary: ended.summary, items_created: ended.items_created, items_resolved: ended.items_resolved })
  return {
    run: { id: ended.id, status: ended.status, items_created: ended.items_created, items_resolved: ended.items_resolved },
    message: 'Run ended. If you were started through the Conductor channel, call agent_done now.',
  }
}

export async function run_goal(args: unknown) {
  const input = RunGoalSchema.parse(args)
  if (!getGoal(input.goal_id)) throw new Error(`Goal ${input.goal_id} not found.`)
  const run = queueRun(input.goal_id)
  return {
    run: { id: run.id, status: run.status },
    message: run.status === 'queued'
      ? 'Queued. The Conductor web app starts queued runs within about 30 seconds while it and a channel-connected Claude Code session are running.'
      : 'This goal already has a run in progress.',
  }
}
