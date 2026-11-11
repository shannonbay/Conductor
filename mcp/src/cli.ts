#!/usr/bin/env node
import { runDoctor, formatResults } from './doctor.js'
import { runnerCommand } from './runner-session.js'

const command = process.argv[2]

if (command === 'doctor') {
  const results = await runDoctor()
  console.log(formatResults(results))
  process.exit(results.some((r) => r.level === 'fail') ? 1 : 0)
} else if (command === 'runner') {
  const { text, code } = await runnerCommand(process.argv.slice(3))
  if (text) console.log(text)
  process.exit(code)
} else {
  console.log([
    'Usage: quarterdeck <command>',
    '',
    'Commands:',
    '  doctor    Check that Quarterdeck is installed and configured correctly',
    '  runner    Run goals with no Claude Code window open (quarterdeck runner help)',
    '',
    'The MCP server itself is started by Claude Code from the quarterdeck-goals plugin (server/quarterdeck-mcp.mjs).',
  ].join('\n'))
  process.exit(command === undefined || command === 'help' || command === '--help' ? 0 : 1)
}
