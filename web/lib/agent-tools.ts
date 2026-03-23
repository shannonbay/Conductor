import { readdir, readFile, writeFile, mkdir, stat } from 'fs/promises'
import { exec } from 'child_process'
import { promisify } from 'util'
import path from 'path'

const execAsync = promisify(exec)

const MAX_READ_BYTES = 50 * 1024   // 50KB per file read
const MAX_OUTPUT_BYTES = 20 * 1024 // 20KB per command output stream
const MAX_GLOB_RESULTS = 200
const MAX_SEARCH_RESULTS = 50

// ─── Path safety ──────────────────────────────────────────────────────────────

export function safeResolvePath(workingDir: string, inputPath: string): string | null {
  const base = path.resolve(workingDir)
  const resolved = path.resolve(workingDir, inputPath)
  if (!resolved.startsWith(base + path.sep) && resolved !== base) return null
  return resolved
}

// ─── list_dir ─────────────────────────────────────────────────────────────────

export async function toolListDir(workingDir: string, inputPath: string): Promise<string> {
  const resolved = safeResolvePath(workingDir, inputPath)
  if (!resolved) return JSON.stringify({ error: 'Path is outside the working directory' })
  try {
    const entries = await readdir(resolved, { withFileTypes: true })
    const result = entries.map(e => ({ name: e.name, type: e.isDirectory() ? 'dir' : 'file' }))
    return JSON.stringify({ path: resolved, entries: result })
  } catch (e) {
    return JSON.stringify({ error: String(e) })
  }
}

// ─── read_file ────────────────────────────────────────────────────────────────

export async function toolReadFile(workingDir: string, inputPath: string): Promise<string> {
  const resolved = safeResolvePath(workingDir, inputPath)
  if (!resolved) return JSON.stringify({ error: 'Path is outside the working directory' })
  try {
    const info = await stat(resolved)
    if (info.isDirectory()) return JSON.stringify({ error: 'Path is a directory, not a file' })
    const buf = await readFile(resolved)
    const truncated = buf.length > MAX_READ_BYTES
    const content = buf.slice(0, MAX_READ_BYTES).toString('utf8')
    return JSON.stringify({ path: resolved, content, truncated, size: buf.length })
  } catch (e) {
    return JSON.stringify({ error: String(e) })
  }
}

// ─── write_file ───────────────────────────────────────────────────────────────

export async function toolWriteFile(workingDir: string, inputPath: string, content: string): Promise<string> {
  const resolved = safeResolvePath(workingDir, inputPath)
  if (!resolved) return JSON.stringify({ error: 'Path is outside the working directory' })
  try {
    await mkdir(path.dirname(resolved), { recursive: true })
    await writeFile(resolved, content, 'utf8')
    return JSON.stringify({ written: resolved, bytes: Buffer.byteLength(content, 'utf8') })
  } catch (e) {
    return JSON.stringify({ error: String(e) })
  }
}

// ─── edit_file ────────────────────────────────────────────────────────────────

export async function toolEditFile(
  workingDir: string,
  inputPath: string,
  oldString: string,
  newString: string,
): Promise<string> {
  const resolved = safeResolvePath(workingDir, inputPath)
  if (!resolved) return JSON.stringify({ error: 'Path is outside the working directory' })
  try {
    const buf = await readFile(resolved)
    const content = buf.toString('utf8')
    if (!content.includes(oldString)) {
      return JSON.stringify({ error: 'old_string not found in file — check for exact whitespace and indentation' })
    }
    const count = content.split(oldString).length - 1
    if (count > 1) {
      return JSON.stringify({ error: `old_string appears ${count} times — provide more context to make it unique` })
    }
    const updated = content.replace(oldString, newString)
    await writeFile(resolved, updated, 'utf8')
    return JSON.stringify({ edited: resolved, replacements: 1 })
  } catch (e) {
    return JSON.stringify({ error: String(e) })
  }
}

// ─── glob_files ───────────────────────────────────────────────────────────────

function globToRegex(pattern: string): RegExp {
  const escaped = pattern
    .replace(/[.+^${}()|[\]\\]/g, '\\$&')
    .replace(/\*\*/g, '\x00')   // placeholder for **
    .replace(/\*/g, '[^/]*')    // * matches within a segment
    .replace(/\x00/g, '.*')     // ** matches across segments
    .replace(/\?/g, '[^/]')
  return new RegExp(`^${escaped}$`)
}

async function walkDir(dir: string, results: string[], limit: number): Promise<void> {
  if (results.length >= limit) return
  try {
    const entries = await readdir(dir, { withFileTypes: true })
    for (const entry of entries) {
      if (results.length >= limit) return
      const full = path.join(dir, entry.name)
      if (entry.isDirectory()) {
        if (!entry.name.startsWith('.')) await walkDir(full, results, limit)
      } else {
        results.push(full)
      }
    }
  } catch { /* skip unreadable dirs */ }
}

export async function toolGlobFiles(workingDir: string, pattern: string, searchPath = '.'): Promise<string> {
  const resolved = safeResolvePath(workingDir, searchPath)
  if (!resolved) return JSON.stringify({ error: 'Path is outside the working directory' })
  try {
    const allFiles: string[] = []
    await walkDir(resolved, allFiles, MAX_GLOB_RESULTS)
    const regex = globToRegex(pattern)
    const matches = allFiles
      .filter(f => {
        const rel = path.relative(resolved, f).replace(/\\/g, '/')
        const name = path.basename(f)
        return regex.test(rel) || regex.test(name)
      })
      .map(f => path.relative(workingDir, f).replace(/\\/g, '/'))
    return JSON.stringify({ matches, total: matches.length, truncated: allFiles.length >= MAX_GLOB_RESULTS })
  } catch (e) {
    return JSON.stringify({ error: String(e) })
  }
}

// ─── search_files ─────────────────────────────────────────────────────────────

export async function toolSearchFiles(
  workingDir: string,
  pattern: string,
  searchPath = '.',
  fileGlob?: string,
): Promise<string> {
  const resolved = safeResolvePath(workingDir, searchPath)
  if (!resolved) return JSON.stringify({ error: 'Path is outside the working directory' })

  // Try ripgrep first, fall back to grep
  const globFlag = fileGlob ? `--glob "${fileGlob}"` : ''
  const rgCmd = `rg --json -n ${globFlag} ${JSON.stringify(pattern)} ${JSON.stringify(resolved)}`
  const grepCmd = `grep -rn ${fileGlob ? `--include="${fileGlob}"` : ''} -e ${JSON.stringify(pattern)} ${JSON.stringify(resolved)}`

  try {
    const { stdout } = await execAsync(rgCmd, { cwd: workingDir, timeout: 15_000 })
    const lines = stdout.split('\n').filter(Boolean)
    const matches: Array<{ file: string; line: number; text: string }> = []
    for (const line of lines) {
      try {
        const obj = JSON.parse(line)
        if (obj.type === 'match') {
          matches.push({
            file: path.relative(workingDir, obj.data.path.text).replace(/\\/g, '/'),
            line: obj.data.line_number,
            text: obj.data.lines.text.trimEnd(),
          })
          if (matches.length >= MAX_SEARCH_RESULTS) break
        }
      } catch { /* skip malformed lines */ }
    }
    return JSON.stringify({ matches, total: matches.length })
  } catch {
    // Fall back to grep
    try {
      const { stdout } = await execAsync(grepCmd, { cwd: workingDir, timeout: 15_000 })
      const lines = stdout.split('\n').filter(Boolean).slice(0, MAX_SEARCH_RESULTS)
      const matches = lines.map(l => {
        const [fileLine, ...rest] = l.split(':')
        const [file, lineNum] = fileLine.split('\x00').length > 1
          ? fileLine.split('\x00')
          : [fileLine, '?']
        return { file: path.relative(workingDir, file).replace(/\\/g, '/'), line: lineNum, text: rest.join(':').trim() }
      })
      return JSON.stringify({ matches, total: matches.length })
    } catch (e2) {
      return JSON.stringify({ error: `Search failed: ${String(e2)}` })
    }
  }
}

// ─── run_command ──────────────────────────────────────────────────────────────

export async function toolRunCommand(
  workingDir: string,
  command: string,
  timeoutMs = 30_000,
): Promise<string> {
  const clampedTimeout = Math.min(timeoutMs, 120_000)
  try {
    const { stdout, stderr } = await execAsync(command, {
      cwd: workingDir,
      timeout: clampedTimeout,
      maxBuffer: 10 * 1024 * 1024, // 10MB buffer
    })
    const truncStdout = stdout.length > MAX_OUTPUT_BYTES
    const truncStderr = stderr.length > MAX_OUTPUT_BYTES
    return JSON.stringify({
      stdout: stdout.slice(0, MAX_OUTPUT_BYTES) + (truncStdout ? '\n[truncated]' : ''),
      stderr: stderr.slice(0, MAX_OUTPUT_BYTES) + (truncStderr ? '\n[truncated]' : ''),
      exit_code: 0,
    })
  } catch (e: unknown) {
    const err = e as { stdout?: string; stderr?: string; code?: number; killed?: boolean; signal?: string }
    return JSON.stringify({
      stdout: (err.stdout ?? '').slice(0, MAX_OUTPUT_BYTES),
      stderr: (err.stderr ?? '').slice(0, MAX_OUTPUT_BYTES),
      exit_code: err.code ?? 1,
      killed: err.killed,
      signal: err.signal,
    })
  }
}

// ─── web_search ───────────────────────────────────────────────────────────────

interface BraveWebResult {
  title: string
  url: string
  description: string
}

interface BraveResponse {
  web?: { results?: BraveWebResult[] }
}

export async function toolWebSearch(query: string, apiKey: string): Promise<string> {
  if (!apiKey) {
    return JSON.stringify({ error: 'Web search not configured. Add BRAVE_SEARCH_API_KEY in Settings (⚙).' })
  }
  try {
    const url = `https://api.search.brave.com/res/v1/web/search?q=${encodeURIComponent(query)}&count=5`
    const res = await fetch(url, {
      headers: { 'X-Subscription-Token': apiKey, 'Accept': 'application/json' },
    })
    if (!res.ok) return JSON.stringify({ error: `Brave Search API error: ${res.status} ${res.statusText}` })
    const data = await res.json() as BraveResponse
    const results = (data.web?.results ?? []).map((r) => ({
      title: r.title,
      url: r.url,
      description: r.description,
    }))
    return JSON.stringify({ results })
  } catch (e) {
    return JSON.stringify({ error: String(e) })
  }
}
