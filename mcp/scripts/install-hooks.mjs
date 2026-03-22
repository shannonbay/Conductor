#!/usr/bin/env node
/**
 * Installs Conductor Claude Code hooks into ~/.claude/settings.json.
 * Runs automatically as a postinstall script, or manually via:
 *   node scripts/install-hooks.mjs
 *
 * Set CONDUCTOR_SKIP_HOOKS=1 to skip installation (e.g. in CI).
 */

import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'fs'
import { join } from 'path'
import { homedir } from 'os'

if (process.env.CONDUCTOR_SKIP_HOOKS === '1') {
  console.log('Conductor: skipping hook installation (CONDUCTOR_SKIP_HOOKS=1)')
  process.exit(0)
}

const HOOKS_TO_ADD = {
  UserPromptSubmit: {
    hooks: [
      {
        type: 'command',
        command: `printf '{"hookSpecificOutput":{"hookEventName":"UserPromptSubmit","additionalContext":"CONDUCTOR: Use mcp__conductor__* tools for task management — not TaskCreate/TaskUpdate. At the start of any multi-step task: call mcp__conductor__list_projects first, then open or create a project and decompose work into tasks. Update progress incrementally with mcp__conductor__update_task. Archive when done with mcp__conductor__archive_project."}}'`,
        timeout: 5,
      },
    ],
  },
  Stop: {
    hooks: [
      {
        type: 'command',
        command: `printf '{"systemMessage":"Conductor: Did Claude update task progress? If a multi-step task was just completed, ask Claude to call mcp__conductor__update_task and mcp__conductor__set_status."}'`,
        timeout: 5,
      },
    ],
  },
}

const targetDir = join(homedir(), '.claude')
const targetFile = join(targetDir, 'settings.json')

// Read existing settings
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

let installed = 0
for (const [event, hookGroup] of Object.entries(HOOKS_TO_ADD)) {
  settings.hooks[event] ??= []
  const alreadyPresent = settings.hooks[event].some((group) =>
    group.hooks?.some((h) => h.command?.includes('mcp__conductor__'))
  )
  if (!alreadyPresent) {
    settings.hooks[event].push(hookGroup)
    installed++
  }
}

mkdirSync(targetDir, { recursive: true })
writeFileSync(targetFile, JSON.stringify(settings, null, 2) + '\n', 'utf8')

if (installed > 0) {
  console.log(`Conductor: installed ${installed} hook(s) into ~/.claude/settings.json`)
  console.log('  Open /hooks in Claude Code (or start a new session) to activate.')
} else {
  console.log('Conductor: hooks already present in ~/.claude/settings.json — nothing to do.')
}
