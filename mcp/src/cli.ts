#!/usr/bin/env node
import { runDoctor, formatResults } from './doctor.js'

const command = process.argv[2]

if (command === 'doctor') {
  const results = await runDoctor()
  console.log(formatResults(results))
  process.exit(results.some((r) => r.level === 'fail') ? 1 : 0)
} else {
  console.log([
    'Usage: quarterdeck <command>',
    '',
    'Commands:',
    '  doctor    Check that Quarterdeck is installed and configured correctly',
    '',
    'The MCP server itself is started by Claude Code from .mcp.json (mcp/dist/index.js).',
  ].join('\n'))
  process.exit(command === undefined || command === 'help' || command === '--help' ? 0 : 1)
}
