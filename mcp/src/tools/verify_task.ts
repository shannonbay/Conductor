import { getPlan, getTask, runChecks } from '../db.js'
import { getOpenPlan } from '../session.js'
import { VerifyTaskSchema } from '../schema.js'
import { record } from '../history.js'

/** Runs a task's verify command now, without completing it, and reports its gates. */
export async function verify_task(args: unknown) {
  const input = VerifyTaskSchema.parse(args)

  const planId = getOpenPlan()
  if (!planId) throw new Error('No plan is open. Use open_plan or create_plan first.')
  const task = getTask(planId, input.task_id)
  if (!task) throw new Error(`Task ${input.task_id} not found.`)

  const { result, gates } = await runChecks(getPlan(planId)!, task)
  if (result) {
    record(planId, task.id, 'verification_run', { passed: result.passed, exit_code: result.exit_code })
  }

  return {
    task_id: task.id,
    gates,
    check: result && {
      command: task.verify_command,
      passed: result.passed,
      exit_code: result.exit_code,
      timed_out: result.timed_out,
      duration_ms: result.duration_ms,
      output: result.output,
    },
    message: !gates
      ? 'This task has no verification gates; it can be completed normally.'
      : !result
      ? 'No verify_command on this task. Acceptance criteria and approval are checked when you complete it.'
      : result.passed
      ? 'Verify command passed. When completing, give evidence for each acceptance criterion (if any).'
      : 'Verify command failed — fix the problem before completing.',
  }
}
