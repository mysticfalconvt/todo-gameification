import { createMiddleware } from '@tanstack/react-start'
import { getRequest } from '@tanstack/react-start/server'
import { auth } from '../auth'
import { isAdminEmail } from '../services/admin'

// Gate for /admin server fns. Looks up the session email, checks against
// the ADMIN_EMAILS env allowlist (case-insensitive, trimmed). Rejects with
// 401 for unauthenticated and 403 for non-admin — so the client can tell
// them apart if it ever needs to.
export const adminMiddleware = createMiddleware({ type: 'function' }).server(
  async ({ next }) => {
    const request = getRequest()
    const session = await auth.api.getSession({ headers: request.headers })
    if (!session) {
      throw new Response('Unauthorized', { status: 401 })
    }
    if (!isAdminEmail(session.user.email)) {
      throw new Response('Forbidden', { status: 403 })
    }
    return next({ context: { userId: session.user.id } })
  },
)
