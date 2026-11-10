#!/usr/bin/env node
/**
 * Keeps Quarterdeck's Claude Code hooks in ~/.claude/settings.json current.
 * Runs automatically as a postinstall script, or manually via:
 *   node scripts/install-hooks.mjs
 *
 * Set QUARTERDECK_SKIP_HOOKS=1 (or the older CONDUCTOR_SKIP_HOOKS=1) to skip it (e.g. in CI).
 *
 * Goals are Quarterdeck's product now, so it no longer installs the old plan
 * reminder hooks (a UserPromptSubmit "use mcp__conductor__* to track work"
 * note and a Stop "did Claude update task progress?" message); it removes
 * them, along with the obsolete decompose hook and the old goal-guard hook
 * (the quarterdeck-guard plugin guards goal runs now). Quarterdeck needs no
 * hooks; this script only cleans up after earlier versions.
 */

import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'fs'
import { join } from 'path'
import { homedir } from 'os'

if ((process.env.QUARTERDECK_SKIP_HOOKS ?? process.env.CONDUCTOR_SKIP_HOOKS) === '1') {
  console.log('Quarterdeck: skipping hook installation (QUARTERDECK_SKIP_HOOKS=1)')
  process.exit(0)
}

// Hooks from earlier versions of this script that should be removed.
//   detect — substring identifying the hook for this event (they date from
//   when Quarterdeck was called Conductor, so they use the old name)
const OBSOLETE = [
  { event: 'PreToolUse', detect: 'conductor-decompose' },
  // The plan reminders (retired: goals don't need them, and they cost tokens every turn)
  { event: 'UserPromptSubmit', detect: 'mcp__conductor__' },
  { event: 'Stop', detect: 'mcp__conductor__' },
  // The goal guard for web-started runs (retired with the channel; the guard plugin does it now)
  { event: 'PreToolUse', detect: 'goal-guard' },
]

const targetDir = join(homedir(), '.claude')
const targetFile = join(targetDir, 'settings.json')

let settings = {}
if (existsSync(targetFile)) {
  try {
    settings = JSON.parse(readFileSync(targetFile, 'utf8'))
  } catch {
    console.warn('Quarterdeck: ~/.claude/settings.json exists but is not valid JSON — skipping hook installation.')
    console.warn('Fix the file manually and re-run: node scripts/install-hooks.mjs')
    process.exit(0)
  }
}

settings.hooks ??= {}
const changes = []

for (const { event, detect } of OBSOLETE) {
  const groups = settings.hooks[event]
  if (!groups) continue
  const kept = groups.filter((g) => !g.hooks?.some((h) => h.command?.includes(detect)))
  if (kept.length !== groups.length) {
    changes.push(`removed the old ${event} hook`)
    if (kept.length > 0) settings.hooks[event] = kept
    else delete settings.hooks[event]
  }
}

if (changes.length === 0) {
  console.log('Quarterdeck: no old Quarterdeck hooks in ~/.claude/settings.json — nothing to do.')
  process.exit(0)
}

mkdirSync(targetDir, { recursive: true })
writeFileSync(targetFile, JSON.stringify(settings, null, 2) + '\n', 'utf8')
console.log(`Quarterdeck: ${changes.join(', ')} in ~/.claude/settings.json`)
console.log('  Start a new Claude Code session (or open /hooks) for it to take effect.')
