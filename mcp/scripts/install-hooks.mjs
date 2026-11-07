#!/usr/bin/env node
/**
 * Installs Conductor reminder hooks into ~/.claude/settings.json.
 * Runs automatically as a postinstall script, or manually via:
 *   node scripts/install-hooks.mjs
 *
 * Set CONDUCTOR_SKIP_HOOKS=1 to skip installation (e.g. in CI).
 *
 * Forced task decomposition is no longer a hook: it is enforced by the MCP
 * server's set_status when CONDUCTOR_REQUIRE_DECOMPOSE=1. This script removes
 * the old decompose PreToolUse hook if an earlier version installed it.
 */

import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'fs'
import { join } from 'path'
import { homedir } from 'os'
import { fileURLToPath } from 'url'

if (process.env.CONDUCTOR_SKIP_HOOKS === '1') {
  console.log('Conductor: skipping hook installation (CONDUCTOR_SKIP_HOOKS=1)')
  process.exit(0)
}

// Each entry: { event, detect, hook }
//   detect — substring identifying an existing Conductor hook for this event
//   hook   — the current hook definition; an existing match is replaced with it
const HOOKS = [
  {
    event: 'UserPromptSubmit',
    detect: 'mcp__conductor__',
    hook: {
      type: 'command',
      command: `printf '{"hookSpecificOutput":{"hookEventName":"UserPromptSubmit","additionalContext":"CONDUCTOR: Use mcp__conductor__* tools for task management — not TaskCreate/TaskUpdate. At the start of any multi-step task: call mcp__conductor__list_plans first, then open or create a plan and decompose work into tasks. Update progress incrementally with mcp__conductor__update_task. Archive when done with mcp__conductor__archive_plan."}}'`,
      timeout: 5,
    },
  },
  {
    event: 'Stop',
    detect: 'mcp__conductor__',
    hook: {
      type: 'command',
      command: `printf '{"systemMessage":"Conductor: Did Claude update task progress? If a multi-step task was just completed, ask Claude to call mcp__conductor__update_task and mcp__conductor__set_status."}'`,
      timeout: 5,
    },
  },
]

// Hooks from earlier versions of this script that should be removed.
const OBSOLETE = [{ event: 'PreToolUse', detect: 'conductor-decompose' }]

const targetDir = join(homedir(), '.claude')
const targetFile = join(targetDir, 'settings.json')

let settings = {}
if (existsSync(targetFile)) {
  try {
    settings = JSON.parse(readFileSync(targetFile, 'utf8'))
  } catch {
    console.warn('Conductor: ~/.claude/settings.json exists but is not valid JSON — skipping hook installation.')
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
    changes.push(`removed obsolete ${event} hook`)
    if (kept.length > 0) settings.hooks[event] = kept
    else delete settings.hooks[event]
  }
}

for (const { event, detect, hook } of HOOKS) {
  settings.hooks[event] ??= []
  const existing = settings.hooks[event]
    .flatMap((g) => g.hooks ?? [])
    .find((h) => h.command?.includes(detect))
  if (!existing) {
    settings.hooks[event].push({ hooks: [hook] })
    changes.push(`installed ${event} hook`)
  } else if (existing.command !== hook.command) {
    Object.assign(existing, hook)
    changes.push(`updated ${event} hook`)
  }
}

// Goal guard (opt-in): a PreToolUse hook that enforces persistent-goal autonomy on
// other tools during goal runs. Opt-in because it runs on every tool call.
//   --guard     install or update it      --no-guard  remove it
//   (neither)   keep an installed guard's path current
const guardScript = fileURLToPath(new URL('../dist/goal-guard.js', import.meta.url))
const guardHook = { type: 'command', command: `node "${guardScript}"`, timeout: 10 }
const wantGuard = process.argv.includes('--guard')
const removeGuard = process.argv.includes('--no-guard')
settings.hooks.PreToolUse ??= []
const guardGroup = settings.hooks.PreToolUse.find((g) => g.hooks?.some((h) => h.command?.includes('goal-guard')))
if (removeGuard && guardGroup) {
  settings.hooks.PreToolUse = settings.hooks.PreToolUse.filter((g) => g !== guardGroup)
  changes.push('removed goal-guard hook')
} else if (guardGroup) {
  const h = guardGroup.hooks.find((x) => x.command?.includes('goal-guard'))
  if (h.command !== guardHook.command) { Object.assign(h, guardHook); changes.push('updated goal-guard hook') }
} else if (wantGuard) {
  if (!existsSync(guardScript)) {
    console.warn(`Conductor: ${guardScript} not found — run \`npm run build --prefix mcp\` first, then rerun with --guard.`)
  } else {
    settings.hooks.PreToolUse.push({ hooks: [guardHook] })
    changes.push('installed goal-guard hook')
  }
}
if (settings.hooks.PreToolUse.length === 0) delete settings.hooks.PreToolUse

if (changes.length === 0) {
  console.log('Conductor: hooks in ~/.claude/settings.json are up to date — nothing to do.')
  process.exit(0)
}

mkdirSync(targetDir, { recursive: true })
writeFileSync(targetFile, JSON.stringify(settings, null, 2) + '\n', 'utf8')
console.log(`Conductor: ${changes.join(', ')} in ~/.claude/settings.json`)
console.log('  Open /hooks in Claude Code (or start a new session) to activate.')
