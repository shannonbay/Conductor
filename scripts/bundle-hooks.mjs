#!/usr/bin/env node
/**
 * Bundles a plugin's hooks into one file: `node scripts/bundle-hooks.mjs <plugin folder>`.
 *
 * Anthropic's plugin directory reads a mod's calls from its source, and reads
 * `$` only where it is used in the file that registers the hooks: a `$` passed
 * to a function in another file blocks the submission. The source keeps its
 * files; the release ships hooks/register.jsx, every function at the top level
 * of one file, not minified. release.mjs runs this on the copy it commits to
 * the release branch, never on the working tree's plugins.
 *
 * Replaces hooks/*.ts and *.tsx with hooks/register.jsx and points hooks.json at it.
 */
import { build } from 'esbuild'
import { existsSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'fs'
import { join, resolve } from 'path'
import { pathToFileURL } from 'url'

export async function bundleHooks(pluginDir) {
  const hooksDir = join(pluginDir, 'hooks')
  const manifestFile = join(hooksDir, 'hooks.json')
  const manifest = JSON.parse(readFileSync(manifestFile, 'utf8'))
  if (!Array.isArray(manifest.modules) || manifest.modules.length !== 1) throw new Error(`${manifestFile}: expected one module`)
  const entry = join(hooksDir, manifest.modules[0])
  const sources = readdirSync(hooksDir).filter((f) => /\.(ts|tsx)$/.test(f))
  if (sources.length < 2) return false // one file already: nothing to bundle
  const name = JSON.parse(readFileSync(join(pluginDir, '.claude-plugin', 'plugin.json'), 'utf8')).name
  const outfile = join(hooksDir, 'register.jsx')

  await build({
    entryPoints: [entry],
    absWorkingDir: hooksDir, // so the comment above each part names its file, not a path on this computer
    outfile,
    bundle: true,
    format: 'esm',
    target: 'es2022',
    jsx: 'preserve', // the engine compiles JSX itself
    external: ['claude-code'],
    minify: false,
    charset: 'utf8',
    legalComments: 'none',
    banner: { js: `// ${name}'s hooks in one file, built by scripts/bundle-hooks.mjs for the plugin directory, which reads a mod's calls\n// from the file that registers its hooks. Not minified. The source, with its comments and types, is in\n// plugins/${name}/hooks/ on the main branch of https://github.com/shannonbay/Quarterdeck.` },
    logLevel: 'warning',
  })

  // esbuild writes `var register = …` and exports it at the end; the engine wants the export on the declaration
  let code = readFileSync(outfile, 'utf8')
  const declared = /^var register = /m
  const exported = /\nexport \{\s*register\s*\};\s*$/
  if (!declared.test(code) || !exported.test(code)) throw new Error('the hooks bundle does not declare and export register as expected')
  code = code.replace(declared, 'export const register = ').replace(exported, '\n')
  writeFileSync(outfile, code)

  for (const f of sources) rmSync(join(hooksDir, f))
  manifest.modules = ['./register.jsx']
  writeFileSync(manifestFile, JSON.stringify(manifest) + '\n')
  if (!existsSync(outfile)) throw new Error('the hooks bundle was not written')
  return true
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  const dir = process.argv[2]
  if (!dir) { console.error('Usage: node scripts/bundle-hooks.mjs <plugin folder>'); process.exit(1) }
  const done = await bundleHooks(resolve(dir))
  console.log(done ? `bundled the hooks of ${dir} into hooks/register.jsx` : `${dir}: one hooks file already, left as it is`)
}
