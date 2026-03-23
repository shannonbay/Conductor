import { NextRequest } from 'next/server'
import { z } from 'zod'
import { getConfig, saveConfig, getBraveSearchApiKey } from '@/lib/conductor-config'
import { ok, err, serverError } from '@/lib/api-utils'

export async function GET() {
  try {
    const config = getConfig()
    const apiKey = process.env.ANTHROPIC_API_KEY || config.anthropic_api_key
    const authToken = process.env.ANTHROPIC_AUTH_TOKEN || config.anthropic_auth_token
    const braveKey = getBraveSearchApiKey()
    return ok({
      anthropic_api_key_set: !!apiKey,
      anthropic_api_key_prefix: apiKey ? apiKey.slice(0, 10) + '…' : null,
      anthropic_auth_token_set: !!authToken,
      anthropic_auth_token_prefix: authToken ? authToken.slice(0, 10) + '…' : null,
      brave_search_api_key_set: !!braveKey,
      brave_search_api_key_prefix: braveKey ? braveKey.slice(0, 10) + '…' : null,
    })
  } catch (e) {
    return serverError(e)
  }
}

const SaveSchema = z.object({
  anthropic_api_key: z.string().optional(),
  anthropic_auth_token: z.string().optional(),
  brave_search_api_key: z.string().optional(),
})

export async function POST(req: NextRequest) {
  try {
    const body = await req.json()
    const parsed = SaveSchema.safeParse(body)
    if (!parsed.success) return err(parsed.error.message)
    const { anthropic_api_key, anthropic_auth_token, brave_search_api_key } = parsed.data
    if (!anthropic_api_key && !anthropic_auth_token && !brave_search_api_key) {
      return err('Provide at least one setting to save')
    }
    const patch: Record<string, string> = {}
    if (anthropic_api_key) patch.anthropic_api_key = anthropic_api_key.trim()
    if (anthropic_auth_token) patch.anthropic_auth_token = anthropic_auth_token.trim()
    if (brave_search_api_key) patch.brave_search_api_key = brave_search_api_key.trim()
    saveConfig(patch)
    return ok({ ok: true })
  } catch (e) {
    return serverError(e)
  }
}
