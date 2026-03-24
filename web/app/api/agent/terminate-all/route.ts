import { getAllActiveSessions } from '@/lib/db'
import { cancelAgent } from '@/lib/agent-runner'
import { ok, serverError } from '@/lib/api-utils'

export async function POST() {
  try {
    const sessions = getAllActiveSessions()
    let terminated = 0
    for (const s of sessions) {
      try {
        cancelAgent(s.plan_id)
        terminated++
      } catch {
        // Session may have ended between query and cancel — ignore
      }
    }
    return ok({ terminated })
  } catch (e) {
    return serverError(e)
  }
}
