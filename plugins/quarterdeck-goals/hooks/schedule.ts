/**
 * Choosing a goal's schedule. Goals lean towards running on a schedule: a
 * small model reads the goal's name and objective and suggests how often it
 * should run (or that it's a one-off), keyword rules stand in when it can't,
 * and the person picks from a short list with the suggestion first.
 */
import type { EngineInterface } from 'claude-code'

import type { GoalCard, Schedule } from '../types'
import { setSchedule } from './api'
import { choiceOptions, readAnswer, fallbackTitle, parseSuggestion, SCHEDULE_CHOICES, scheduleLabel, suggestByKeywords, type ScheduleChoice, type Suggestion, parseSchedule } from './model'

type $ = EngineInterface

const SYSTEM = `You choose how often a standing goal for an AI agent should run. Most goals are ongoing work (keeping, maintaining, monitoring, triaging, checking, tidying) and should run on a schedule; pick a one-off only when the goal is clearly a single task that is finished once done (install, set up, migrate, fix this one thing).
Answer with JSON only: {"choice": "hourly" | "6h" | "daily" | "weekly" | "one-off", "reason": "<one short sentence>"}, adding "title": "<2-5 word name, Title Case>" when the goal has no name yet.
Guide: inboxes, alerts and triage hourly; monitoring and watching every 6 hours; maintaining, keeping current and checking daily; reports, digests and reviews weekly.`

/**
 * How often the goal should run (and, for a goal with no name, a title), from
 * a small model in one call; keyword rules and the objective's first words
 * stand in when it can't answer.
 */
export async function suggestSchedule($: $, name: string | null, objective: string): Promise<Suggestion> {
  let suggestion: Suggestion | null = null
  try {
    const prompt = `Goal name: ${name ?? '(none yet: suggest a title)'}\nObjective: ${objective}`
    const r = await $.model.complete({ model: 'haiku', system: SYSTEM, prompt, maxTokens: 120, timeoutMs: 15_000 })
    if (r.isAnswered) suggestion = parseSuggestion(r.text)
  } catch {
    // a blocked model or a host without one: the rules below
  }
  suggestion ??= suggestByKeywords(name ?? '', objective)
  return name ? suggestion : { ...suggestion, title: suggestion.title ?? fallbackTitle(objective) }
}

const READ_SYSTEM = `Turn the person's words about how often a recurring task should run into exactly one line of this syntax, and nothing else:
every <N><m|h|d|w>   (optionally followed by " between HH:MM-HH:MM")
cron <minute> <hour> <day of month> <month> <day of week>   (local time)
off
one-off
Examples: "every other week" -> every 2w; "twice a day" -> every 12h; "weekdays at 9" -> cron 0 9 * * 1-5; "first of the month" -> cron 0 9 1 * *; "never" -> off.
If the words don't describe a schedule, answer: unclear`

/** A typed schedule, read strictly, else by a small model whose answer must pass the same parser. */
export type ReadSchedule = { schedule: Schedule | null; oneOff?: boolean; interpreted?: string } | { error: string }

export async function readSchedule($: $, text: string): Promise<ReadSchedule> {
  const strict = parseSchedule(text)
  if (!('error' in strict) || !text.trim()) return strict
  try {
    const r = await $.model.complete({ model: 'haiku', system: READ_SYSTEM, prompt: text.trim(), maxTokens: 30, timeoutMs: 15_000 })
    if (r.isAnswered) {
      const line = r.text.trim().split('\n')[0]!.replace(/^["'`]|["'`]$/g, '').trim()
      const read = parseSchedule(line)
      if (!('error' in read)) return { ...read, interpreted: line }
    }
  } catch {
    // no model: the strict reading's error stands
  }
  return strict
}

/** Asks how often the goal runs, the suggestion first. A dismissed question takes the suggestion. */
export async function askSchedule($: $, goalName: string, suggestion: Suggestion): Promise<ScheduleChoice> {
  const suggested = SCHEDULE_CHOICES.find((c) => c.key === suggestion.choice)!
  const read = await ask($, goalName, suggestion, null)
  if (read && 'error' in read) $.ui.toast(`Couldn't read "${read.answer}", so it runs ${suggested.label.toLowerCase()}. ${read.error} Change it with Reschedule.`)
  return read && 'choice' in read ? read.choice : suggested
}

/** The question itself; null when it was dismissed or the answer isn't a schedule. */
async function ask($: $, goalName: string, suggestion: Suggestion, current: Schedule | null): Promise<{ choice: ScheduleChoice } | { error: string; answer: string } | null> {
  const suggested = SCHEDULE_CHOICES.find((c) => c.key === suggestion.choice)!
  const now = current ? `Now: ${scheduleLabel(current)}. ` : ''
  let answer: string | null = null
  try {
    answer = await $.ui.ask(
      `${now}How often should "${goalName}" run? Suggested: ${suggested.label.toLowerCase()} (${suggestion.reason}). Or type your own: 12h, 30d, weekly, cron 0 9 * * 1-5, or off.`,
      choiceOptions(suggestion.choice),
    )
  } catch {
    answer = null
  }
  const read = readAnswer(answer)
  if (!read || !('error' in read)) return read
  // Not the strict syntax: let the small model read it, then check its reading
  const typed = await readSchedule($, answer!)
  if ('error' in typed) return { ...read, answer: answer! }
  return { choice: { key: 'custom', label: typed.oneOff ? 'one-off' : scheduleLabel(typed.schedule), schedule: typed.schedule, oneOff: typed.oneOff ?? false, read: `"${answer}" as ${typed.interpreted}` } }
}

/**
 * The pane's Reschedule, for a goal that has a schedule: the same choices,
 * with the current schedule shown. A dismissed question changes nothing.
 */
export async function rescheduleGoal($: $, goal: GoalCard): Promise<void> {
  const read = await ask($, goal.name, await suggestSchedule($, goal.name, goal.objective), goal.schedule)
  if (!read || 'error' in read) {
    $.ui.toast(read ? `Couldn't read "${read.answer}": ${read.error} The schedule is unchanged.` : `${goal.name}: schedule unchanged.`)
    return
  }
  const choice = read.choice
  await setSchedule($, goal.id, choice.schedule, choice.oneOff)
  $.ui.toast(`${goal.name} now runs ${choice.oneOff ? 'once' : scheduleLabel(choice.schedule)}${choice.read ? ` (read ${choice.read})` : ''}.`)
}

/** The pane's Set schedule: suggest, ask, set. Says what was chosen. */
export async function chooseSchedule($: $, goal: GoalCard): Promise<ScheduleChoice> {
  const choice = await askSchedule($, goal.name, await suggestSchedule($, goal.name, goal.objective))
  await setSchedule($, goal.id, choice.schedule, choice.oneOff)
  return choice
}
