import { NextRequest } from 'next/server'
import { z } from 'zod'
import { getConfig, saveConfig, getBraveSearchApiKey } from '@/lib/conductor-config'
import { ok, err, serverError } from '@/lib/api-utils'

export async function GET() {
  try {
    const braveKey = getBraveSearchApiKey()
    return ok({
      brave_search_api_key_set: !!braveKey,
      brave_search_api_key_prefix: braveKey ? braveKey.slice(0, 10) + '…' : null,
    })
  } catch (e) {
    return serverError(e)
  }
}

const SaveSchema = z.object({
  brave_search_api_key: z.string().optional(),
})

export async function POST(req: NextRequest) {
  try {
    const body = await req.json()
    const parsed = SaveSchema.safeParse(body)
    if (!parsed.success) return err(parsed.error.message)
    const { brave_search_api_key } = parsed.data
    if (!brave_search_api_key) return err('Provide at least one setting to save')
    saveConfig({ brave_search_api_key: brave_search_api_key.trim() })
    return ok({ ok: true })
  } catch (e) {
    return serverError(e)
  }
}
