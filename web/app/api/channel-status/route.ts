import { getChannelStatus } from '@/lib/channel-client'
import { ok, serverError } from '@/lib/api-utils'

export async function GET() {
  try {
    const status = await getChannelStatus()
    return ok(status)
  } catch (e) {
    return serverError(e)
  }
}
