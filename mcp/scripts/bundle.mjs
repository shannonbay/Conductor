#!/usr/bin/env node
/**
 * Bundles the MCP server (with @quarterdeck/core and every npm dependency) into
 * single files inside the quarterdeck-goals plugin, which starts it from its
 * .mcp.json. The plugin then needs no npm install: node:sqlite is built in.
 *
 *   plugins/quarterdeck-goals/server/quarterdeck-mcp.mjs   the server
 *   plugins/quarterdeck-goals/server/quarterdeck-cli.mjs   `doctor`
 */
import { build } from 'esbuild'
import { dirname, join, resolve } from 'path'
import { fileURLToPath } from 'url'
import { readFileSync } from 'fs'

const mcpDir = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const repoRoot = resolve(mcpDir, '..')
const outDir = join(repoRoot, 'plugins', 'quarterdeck-goals', 'server')
const version = JSON.parse(readFileSync(join(repoRoot, 'plugins', 'quarterdeck-goals', '.claude-plugin', 'plugin.json'), 'utf8')).version

await build({
  entryPoints: {
    'quarterdeck-mcp': join(mcpDir, 'src', 'index.ts'),
    'quarterdeck-cli': join(mcpDir, 'src', 'cli.ts'),
  },
  outdir: outDir,
  outExtension: { '.js': '.mjs' },
  bundle: true,
  platform: 'node',
  target: 'node22',
  format: 'esm',
  // Use core's sources, so the bundle never picks up a stale core/dist
  alias: { '@quarterdeck/core': join(repoRoot, 'core', 'src', 'index.ts') },
  // CommonJS dependencies inside an ES module still call require()
  banner: { js: `// Quarterdeck MCP server ${version}, bundled by mcp/scripts/bundle.mjs. Edit mcp/ and core/, not this file.\nimport { createRequire as __qdCreateRequire } from 'module'; const require = __qdCreateRequire(import.meta.url);` },
  logLevel: 'warning',
})

console.log(`bundled the MCP server ${version} into ${outDir}`)
