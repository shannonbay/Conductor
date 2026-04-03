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
import { execSync } from 'child_process'

if (process.env.CONDUCTOR_SKIP_HOOKS === '1') {
  console.log('Conductor: skipping hook installation (CONDUCTOR_SKIP_HOOKS=1)')
  process.exit(0)
}

// ── Decompose-on-activate hook script ────────────────────────────────────────
// Intercepts mcp__conductor__set_status(status="active") and blocks activation
// unless the task already has children or is explicitly marked state.atomic=true.
// This forces recursive decomposition: Claude must break tasks into sub-tasks
// before working on them, recursively, until atomic leaf tasks are reached.
const DECOMPOSE_SCRIPT = `#!/usr/bin/env python3
"""
Conductor decompose-on-activate hook.

Intercepts mcp__conductor__set_status calls with status="active" and blocks
activation unless the task already has children (previously decomposed) or is
explicitly marked atomic via state.atomic=true.

This forces recursive decomposition: Claude must break a task into sub-tasks
before activating it, then activate the first child (which triggers this hook
again), repeating until leaf tasks are reached.

Atomic bypass: for tasks that are genuinely a single tool call, Claude should
call mcp__conductor__update_task with state_patch: {"atomic": true} first,
then retry set_status.

Fails open (exit 0) on any error so it never blocks legitimate work.
"""
import sys
import json
import os
import sqlite3

try:
    data = json.load(sys.stdin)
except Exception:
    sys.exit(0)

# Only intercept set_status calls
if data.get('tool_name') != 'mcp__conductor__set_status':
    sys.exit(0)

tool_input = data.get('tool_input', {})
if tool_input.get('status') != 'active':
    sys.exit(0)

task_id = tool_input.get('task_id', '')
if not task_id:
    sys.exit(0)

db_path = os.environ.get(
    'CONDUCTOR_DB',
    os.path.join(os.path.expanduser('~'), '.conductor', 'tasks.db')
)

try:
    conn = sqlite3.connect(f'file:{db_path}?mode=ro', uri=True)

    # Allow if task already has children (already decomposed)
    child_count = conn.execute(
        'SELECT COUNT(*) FROM tasks WHERE id LIKE ?',
        (f'{task_id}.%',)
    ).fetchone()[0]
    if child_count > 0:
        conn.close()
        sys.exit(0)

    # Allow if task is explicitly marked atomic
    row = conn.execute(
        'SELECT state FROM tasks WHERE id = ? LIMIT 1',
        (task_id,)
    ).fetchone()
    conn.close()
    if row and row[0]:
        try:
            state = json.loads(row[0])
            if state.get('atomic'):
                sys.exit(0)
        except Exception:
            pass

    # Block and instruct Claude to decompose or mark atomic
    print(json.dumps({
        'hookSpecificOutput': {
            'hookEventName': 'PreToolUse',
            'permissionDecision': 'deny',
            'permissionDecisionReason': (
                'CONDUCTOR DECOMPOSE: This task has no sub-tasks yet. '
                'Read the task goal and choose one path:\\n'
                '1. Multi-step work: call mcp__conductor__provision_tasks to create child tasks, '
                'then set the first child to active (leave this parent pending). '
                'The hook will fire again on each child, recursively decomposing until leaf tasks.\\n'
                '2. Single atomic operation (one specific tool call): call '
                'mcp__conductor__update_task with state_patch: {"atomic": true}, '
                'then retry mcp__conductor__set_status.'
            )
        }
    }))

except Exception:
    sys.exit(0)  # Fail open on any DB or parse error
`

// ── Detect Python executable ──────────────────────────────────────────────────
// `python3` is standard on Mac/Linux; Windows typically uses `python`.
function detectPython() {
  for (const cmd of ['python3', 'python']) {
    try {
      const out = execSync(`${cmd} --version`, { stdio: ['ignore', 'pipe', 'ignore'] })
        .toString().trim()
      if (out.startsWith('Python 3')) return cmd
    } catch {
      // not found, try next
    }
  }
  return null
}

const pythonCmd = detectPython()

// ── Hook entries in ~/.claude/settings.json ───────────────────────────────────
// Each entry: { event, detect, hookGroup }
//   detect  — substring to check for duplicate presence in existing hook commands
//   hookGroup — the object pushed into settings.hooks[event]
const HOOKS_TO_ADD = [
  {
    event: 'UserPromptSubmit',
    detect: 'mcp__conductor__',
    hookGroup: {
      hooks: [
        {
          type: 'command',
          command: `printf '{"hookSpecificOutput":{"hookEventName":"UserPromptSubmit","additionalContext":"CONDUCTOR: Use mcp__conductor__* tools for task management — not TaskCreate/TaskUpdate. At the start of any multi-step task: call mcp__conductor__list_projects first, then open or create a project and decompose work into tasks. Update progress incrementally with mcp__conductor__update_task. Archive when done with mcp__conductor__archive_project."}}'`,
          timeout: 5,
        },
      ],
    },
  },
  {
    event: 'Stop',
    detect: 'mcp__conductor__',
    hookGroup: {
      hooks: [
        {
          type: 'command',
          command: `printf '{"systemMessage":"Conductor: Did Claude update task progress? If a multi-step task was just completed, ask Claude to call mcp__conductor__update_task and mcp__conductor__set_status."}'`,
          timeout: 5,
        },
      ],
    },
  },
  ...(pythonCmd ? [{
    event: 'PreToolUse',
    detect: 'conductor-decompose',
    hookGroup: {
      hooks: [
        {
          type: 'command',
          command: `${pythonCmd} "$HOME/.claude/hooks/conductor-decompose.py"`,
          timeout: 10,
        },
      ],
    },
  }] : []),
]

// ── Install hook script file ───────────────────────────────────────────────────
const hooksScriptDir = join(homedir(), '.claude', 'hooks')
const hooksScriptFile = join(hooksScriptDir, 'conductor-decompose.py')

mkdirSync(hooksScriptDir, { recursive: true })
writeFileSync(hooksScriptFile, DECOMPOSE_SCRIPT, 'utf8')

if (!pythonCmd) {
  console.warn('Conductor: Python 3 not found — decompose-on-activate hook will not be registered.')
  console.warn('  Install Python 3 and re-run: node scripts/install-hooks.mjs')
}

// ── Install settings.json entries ─────────────────────────────────────────────
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
for (const { event, detect, hookGroup } of HOOKS_TO_ADD) {
  settings.hooks[event] ??= []
  const alreadyPresent = settings.hooks[event].some((group) =>
    group.hooks?.some((h) => h.command?.includes(detect))
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
