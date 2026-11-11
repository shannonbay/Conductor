#!/usr/bin/env node
/**
 * Publishes a Quarterdeck release: `npm run release -- 0.12.0 [--push]`.
 *
 * 1. Checks main is clean, then runs every test (workspaces and both plugins).
 * 2. Sets the version in both plugin.json files and commits that on main.
 * 3. Builds, then commits the installable marketplace (marketplace.json, the
 *    plugins with the bundled server and each plugin's hooks in one file
 *    (bundle-hooks.mjs: the plugin directory reads `$` in one file only),
 *    README, LICENSE) to the `release`
 *    branch, and tags it v<version>, quarterdeck-goals--v<version> and
 *    quarterdeck-guard--v<version>.
 * 4. With --push, pushes main, release and the tags.
 *
 * People install from the release branch:
 *   claude plugin marketplace add shannonbay/Quarterdeck#release
 * Claude Code sees a new version when plugin.json's version changes.
 */
import { execFileSync, execSync } from 'child_process'
import { cpSync, existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { dirname, join, resolve } from 'path'
import { fileURLToPath } from 'url'

import { bundleHooks } from './bundle-hooks.mjs'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const PLUGINS = ['quarterdeck-goals', 'quarterdeck-guard']
const RELEASE_BRANCH = 'release'

const args = process.argv.slice(2)
const version = args.find((a) => !a.startsWith('--'))
const push = args.includes('--push')
const skipTests = args.includes('--skip-tests')

if (!version || !/^\d+\.\d+\.\d+(-[0-9A-Za-z.]+)?$/.test(version)) {
  console.error('Usage: npm run release -- <version> [--push] [--skip-tests]   e.g. npm run release -- 0.12.0')
  process.exit(1)
}

/** Runs a command, showing it. npm and claude go through the shell (they're .cmd scripts on Windows); their arguments here never need quoting. */
function run(cmd, cmdArgs) {
  console.log(`$ ${cmd} ${cmdArgs.join(' ')}`)
  if (cmd === 'git') return execFileSync(cmd, cmdArgs, { cwd: root, stdio: 'inherit' })
  return execSync([cmd, ...cmdArgs].join(' '), { cwd: root, stdio: 'inherit' })
}
const git = (...a) => execFileSync('git', a, { cwd: root, encoding: 'utf8' }).trim()
const gitIn = (cwd, ...a) => execFileSync('git', a, { cwd, encoding: 'utf8' }).trim()
const fail = (msg) => { console.error(`release: ${msg}`); process.exit(1) }

// ── 1. Checks ─────────────────────────────────────────────────────────────────
if (git('rev-parse', '--abbrev-ref', 'HEAD') !== 'main') fail('run it on main')
if (git('status', '--porcelain')) fail('main has uncommitted changes; commit or stash them first')
if (git('tag', '--list', `v${version}`)) fail(`tag v${version} already exists`)

if (!skipTests) {
  run('npm', ['test'])
  for (const p of PLUGINS) run('claude', ['plugin', 'test', `plugins/${p}`])
}

// ── 2. Version on main ────────────────────────────────────────────────────────
for (const p of PLUGINS) {
  const file = join(root, 'plugins', p, '.claude-plugin', 'plugin.json')
  const manifest = JSON.parse(readFileSync(file, 'utf8'))
  manifest.version = version
  writeFileSync(file, JSON.stringify(manifest, null, 2) + '\n')
}
run('git', ['add', ...PLUGINS.map((p) => `plugins/${p}/.claude-plugin/plugin.json`)])
run('git', ['commit', '-m', `release: v${version}`])
const source = git('rev-parse', '--short', 'HEAD')

// ── 3. Build and commit to the release branch ─────────────────────────────────
run('npm', ['run', 'build', '--prefix', 'mcp'])
if (!existsSync(join(root, 'plugins', 'quarterdeck-goals', 'server', 'quarterdeck-mcp.mjs'))) fail('the server bundle was not built')

const work = join(mkdtempSync(join(tmpdir(), 'quarterdeck-release-')), 'tree')
const hasLocal = git('branch', '--list', RELEASE_BRANCH) !== ''
const hasRemote = (() => { try { return git('ls-remote', '--heads', 'origin', RELEASE_BRANCH) !== '' } catch { return false } })()
const isAncestor = (a, b) => { try { git('merge-base', '--is-ancestor', a, b); return true } catch { return false } }
if (hasRemote) {
  // Build on what is published. A local branch left behind by a release made on
  // another computer once put v0.17.0 on top of v0.15.0, and the push was refused.
  run('git', ['fetch', 'origin', RELEASE_BRANCH])
  const remote = `origin/${RELEASE_BRANCH}`
  if (!hasLocal || isAncestor(RELEASE_BRANCH, remote)) {
    run('git', ['worktree', 'add', '-B', RELEASE_BRANCH, work, remote])
  } else if (isAncestor(remote, RELEASE_BRANCH)) {
    run('git', ['worktree', 'add', work, RELEASE_BRANCH]) // ahead: a release not pushed yet
  } else {
    fail(`local ${RELEASE_BRANCH} and ${remote} have diverged; sort that out first`)
  }
} else if (hasLocal) {
  run('git', ['worktree', 'add', work, RELEASE_BRANCH])
} else {
  // First release: an orphan branch holding only what installs
  run('git', ['worktree', 'add', '--detach', work])
  gitIn(work, 'checkout', '--orphan', RELEASE_BRANCH)
}

try {
  // Start from an empty tree, then copy in what installs
  for (const entry of readdirSync(work)) if (entry !== '.git') rmSync(join(work, entry), { recursive: true, force: true })
  cpSync(join(root, '.claude-plugin', 'marketplace.json'), join(work, '.claude-plugin', 'marketplace.json'))
  for (const p of PLUGINS) {
    const from = join(root, 'plugins', p)
    cpSync(from, join(work, 'plugins', p), {
      recursive: true,
      // Tests and dev-only files don't ship: the engine types (.claude-plugin/types, gitignored) and the tsconfig pointing at them
      filter: (src) => {
        const rel = src.slice(from.length).replace(/\\/g, '/')
        return !/^\/(tests|node_modules|tsconfig\.json)(\/|$)/.test(rel) && !/^\/\.claude-plugin\/types(\/|$)/.test(rel)
      },
    })
  }
  // The hooks in one file, then the engine's own check that it still reads them
  for (const p of PLUGINS) {
    if (await bundleHooks(join(work, 'plugins', p))) console.log(`release: bundled the hooks of ${p}`)
    execSync(`claude plugin validate "${join(work, 'plugins', p)}"`, { cwd: root, stdio: 'inherit' })
  }
  cpSync(join(root, 'README.md'), join(work, 'README.md'))
  cpSync(join(root, 'LICENSE'), join(work, 'LICENSE'))

  gitIn(work, 'add', '-A')
  gitIn(work, 'commit', '-m', `Quarterdeck v${version} (built from main ${source})`)
  for (const tag of [`v${version}`, ...PLUGINS.map((p) => `${p}--v${version}`)]) gitIn(work, 'tag', tag)
  console.log(`release: committed v${version} to ${RELEASE_BRANCH} (${gitIn(work, 'rev-parse', '--short', 'HEAD')})`)
} finally {
  run('git', ['worktree', 'remove', '--force', work])
}

// ── 4. Push ───────────────────────────────────────────────────────────────────
const tags = [`v${version}`, ...PLUGINS.map((p) => `${p}--v${version}`)]
if (push) {
  run('git', ['push', 'origin', 'main', RELEASE_BRANCH, ...tags])
  console.log(`release: v${version} published. With auto-update on, sessions get it within a few minutes; /reload-plugins applies it.`)
} else {
  console.log(`release: v${version} is ready locally. Publish with: git push origin main ${RELEASE_BRANCH} ${tags.join(' ')}`)
}
