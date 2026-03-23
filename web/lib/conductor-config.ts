import Anthropic from '@anthropic-ai/sdk'
import { readFileSync, writeFileSync, mkdirSync } from 'fs'
import path from 'path'
import os from 'os'

interface ConductorConfig {
  anthropic_api_key?: string
  anthropic_auth_token?: string
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

export function getAnthropicClient(): Anthropic {
  const config = getConfig()
  const apiKey = process.env.ANTHROPIC_API_KEY || config.anthropic_api_key
  const authToken = process.env.ANTHROPIC_AUTH_TOKEN || config.anthropic_auth_token
  if (authToken) return new Anthropic({ authToken })
  if (apiKey) return new Anthropic({ apiKey })
  throw new Error('Anthropic credentials not configured. Open Settings (⚙) to add your API key or auth token.')
}
