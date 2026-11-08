/**
 * Choosing a goal's schedule. Goals lean towards running on a schedule: a
 * small model reads the goal's name and objective and suggests how often it
 * should run (or that it's a one-off), keyword rules stand in when it can't,
 * and the person picks from a short list with the suggestion first.
 */
import type { EngineInterface } from 'claude-code'

import type { GoalCard } from '../types'
import { setSchedule } from './api'
import { choiceFromAnswer, choiceOptions, parseSuggestion, SCHEDULE_CHOICES, suggestByKeywords, type ScheduleChoice, type Suggestion } from './model'

type $ = EngineInterface

const SYSTEM = `You choose how often a standing goal for an AI agent should run. Most goals are ongoing work (keeping, maintaining, monitoring, triaging, checking, tidying) and should run on a schedule; pick a one-off only when the goal is clearly a single task that is finished once done (install, set up, migrate, fix this one thing).
Answer with JSON only: {"choice": "hourly" | "6h" | "daily" | "weekly" | "one-off", "reason": "<one short sentence>"}.
Guide: inboxes, alerts and triage hourly; monitoring and watching every 6 hours; maintaining, keeping current and checking daily; reports, digests and reviews weekly.`

/** How often the goal should run, from a small model, or keyword rules when it can't answer. */
export async function suggestSchedule($: $, name: string, objective: string): Promise<Suggestion> {
  try {
    const r = await $.model.complete({ model: 'haiku', system: SYSTEM, prompt: `Goal name: ${name}\nObjective: ${objective}`, maxTokens: 120, timeoutMs: 15_000 })
    if (r.isAnswered) {
      const parsed = parseSuggestion(r.text)
      if (parsed) return parsed
    }
  } catch {
    // a blocked model or a host without one: the keyword rules below
  }
  return suggestByKeywords(name, objective)
}

/** Asks how often the goal runs, the suggestion first. A dismissed question takes the suggestion. */
export async function askSchedule($: $, goalName: string, suggestion: Suggestion): Promise<ScheduleChoice> {
  const suggested = SCHEDULE_CHOICES.find((c) => c.key === suggestion.choice)!
  let answer: string | null = null
  try {
    answer = await $.ui.ask(
      `How often should "${goalName}" run? Suggested: ${suggested.label.toLowerCase()} (${suggestion.reason}). Or type your own: every 12h, cron 0 9 * * 1-5, or off.`,
      choiceOptions(suggestion.choice),
    )
  } catch {
    answer = null
  }
  return choiceFromAnswer(answer) ?? suggested
}

/** The pane's Set schedule: suggest, ask, set. Says what was chosen. */
export async function chooseSchedule($: $, goal: GoalCard): Promise<ScheduleChoice> {
  const choice = await askSchedule($, goal.name, await suggestSchedule($, goal.name, goal.objective))
  await setSchedule($, goal.id, choice.schedule, choice.oneOff)
  return choice
}
