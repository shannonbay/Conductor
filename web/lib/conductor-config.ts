import { readFileSync, writeFileSync, mkdirSync } from 'fs'
import path from 'path'
import os from 'os'

interface ConductorConfig {
  brave_search_api_key?: string
}

const CONFIG_DIR = path.join(os.homedir(), '.conductor')
const CONFIG_PATH = path.join(CONFIG_DIR, 'config.json')

export function getConfig(): ConductorConfig {
  try {
    const raw = readFileSync(CONFIG_PATH, 'utf8')
    return JSON.parse(raw) as ConductorConfig
  } catch {
    return {}
  }
}

export function saveConfig(patch: Partial<ConductorConfig>): void {
  const current = getConfig()
  const updated = { ...current, ...patch }
  mkdirSync(CONFIG_DIR, { recursive: true })
  writeFileSync(CONFIG_PATH, JSON.stringify(updated, null, 2), 'utf8')
}

export function getBraveSearchApiKey(): string | undefined {
  return process.env.BRAVE_SEARCH_API_KEY || getConfig().brave_search_api_key
}
