/**
 * Choosing a goal's schedule. Goals lean towards running on a schedule: a
 * small model reads the goal's name and objective and suggests how often it
 * should run (or that it's a one-off), keyword rules stand in when it can't,
 * and the person picks from a short list with the suggestion first. The same
 * call suggests the model a new goal's runs use (no question: the creation
 * message names it, and the pane changes it).
 */
import type { EngineInterface } from 'claude-code'

import type { GoalCard, Schedule } from '../types'
import { setSchedule } from './api'
import { choiceOptions, offersWatch, readAnswer, fallbackTitle, parseSuggestion, soundsEventDriven, WATCH_FALLBACK, SCHEDULE_CHOICES, scheduleLabel, suggestByKeywords, type ScheduleChoice, type Suggestion, parseSchedule } from './model'

type Engine = EngineInterface

const SYSTEM = `You set up a standing goal for an AI agent: how often it runs, and which model its runs use.
Schedule: most goals are ongoing work (keeping, maintaining, monitoring, triaging, checking, tidying) and should run on a schedule; pick a one-off only when the goal is clearly a single task that is finished once done (install, set up, migrate, fix this one thing). Inboxes, alerts and triage hourly; monitoring and watching every 6 hours; maintaining, keeping current and checking daily; reports, digests and reviews weekly.
Watch: a goal about reacting to things that arrive or change (a new GitHub issue or pull request, a new release, a new email from someone, a new file, a feed entry, a page that changes) is better started by a watch, which starts a run soon after it happens, than by a frequent timer. Then add "watch": "<what to watch for, a few words, e.g. new issues in octo/site>"; still give the timer it would need without one. Leave "watch" out for upkeep, reports and anything that isn't about something arriving.
Model: "haiku" when a run only checks something and reports or notifies (a release watch, a price check, a status check, a simple rule applied to files). "sonnet" when it triages, sorts or classifies and proposes actions for the person to approve; this is the usual choice. "opus" when it writes something a person will read (drafts, replies, reports, a README, cover letters) or makes hard judgement calls with real consequences. A goal that runs hourly or more often runs many times a day: prefer a smaller model there unless the writing or judgement clearly needs it.
Answer with JSON only: {"choice": "hourly" | "6h" | "daily" | "weekly" | "one-off", "reason": "<one short sentence>", "model": "haiku" | "sonnet" | "opus", "model_reason": "<a few words, e.g. it only checks and reports>"}, adding "watch" as above, and "title": "<2-5 word name, Title Case>" when the goal has no name yet.`

/**
 * How often the goal should run (and, for a goal with no name, a title), from
 * a small model in one call; keyword rules and the objective's first words
 * stand in when it can't answer.
 */
export async function suggestSchedule($: Engine, name: string | null, objective: string): Promise<Suggestion> {
  let suggestion: Suggestion | null = null
  try {
    const prompt = `Goal name: ${name ?? '(none yet: suggest a title)'}\nObjective: ${objective}`
    const r = await $.model.complete({ model: 'haiku', system: SYSTEM, prompt, maxTokens: 200, timeoutMs: 15_000 })
    if (r.isAnswered) suggestion = parseSuggestion(r.text)
  } catch {
    // a blocked model or a host without one: the rules below
  }
  suggestion ??= suggestByKeywords(name ?? '', objective)
  // The person said as much ("watch for new issues"): offer it even when the model didn't
  if (!suggestion.watch && soundsEventDriven(objective)) suggestion = { ...suggestion, watch: WATCH_FALLBACK }
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

export async function readSchedule($: Engine, text: string): Promise<ReadSchedule> {
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

/**
 * Asks how often the goal runs, the suggestion first. A dismissed question takes the suggestion.
 * With `offerWatch` (a new goal), a watch is offered first when the suggestion names one.
 */
export async function askSchedule($: Engine, goalName: string, suggestion: Suggestion, offerWatch = false): Promise<ScheduleChoice> {
  const watch = offerWatch && offersWatch(suggestion)
  const suggested = SCHEDULE_CHOICES.find((c) => c.key === (watch ? 'watch' : suggestion.choice))!
  const read = await ask($, goalName, suggestion, null, watch)
  if (read && 'error' in read) $.ui.toast(`Couldn't read "${read.answer}", so it runs ${suggested.label.toLowerCase()}. ${read.error} Change it with Reschedule.`)
  return read && 'choice' in read ? read.choice : suggested
}

/** The question itself; null when it was dismissed or the answer isn't a schedule. */
async function ask($: Engine, goalName: string, suggestion: Suggestion, current: Schedule | null, watch = false): Promise<{ choice: ScheduleChoice } | { error: string; answer: string } | null> {
  const suggested = SCHEDULE_CHOICES.find((c) => c.key === suggestion.choice)!
  const now = current ? `Now: ${scheduleLabel(current)}. ` : ''
  const what = suggestion.watch && suggestion.watch !== WATCH_FALLBACK ? ` (${suggestion.watch})` : ''
  const why = watch
    ? `Suggested: when something happens${what}: Claude sets up a watch next, with a daily run as a backstop. On a timer instead: ${suggested.label.toLowerCase()} (${suggestion.reason}).`
    : `Suggested: ${suggested.label.toLowerCase()} (${suggestion.reason}).`
  let answer: string | null = null
  try {
    answer = await $.ui.ask(
      `${now}How often should "${goalName}" run? ${why} Or type your own: 12h, 30d, weekly, cron 0 9 * * 1-5, or off.`,
      choiceOptions(suggestion.choice, watch),
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
export async function rescheduleGoal($: Engine, goal: GoalCard): Promise<void> {
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
export async function chooseSchedule($: Engine, goal: GoalCard): Promise<ScheduleChoice> {
  const choice = await askSchedule($, goal.name, await suggestSchedule($, goal.name, goal.objective))
  await setSchedule($, goal.id, choice.schedule, choice.oneOff)
  return choice
}
