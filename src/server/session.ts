import { createServerFn } from '@tanstack/react-start'
import { getRequest } from '@tanstack/react-start/server'
import { auth } from './auth'

export const getCurrentSession = createServerFn({ method: 'GET' }).handler(async () => {
  const request = getRequest()
  // This server-function response cannot forward Better Auth's Set-Cookie
  // header. Keep this lookup read-only so the browser's /api/auth session
  // request remains responsible for rolling refreshes.
  return auth.api.getSession({ headers: request.headers, query: { disableRefresh: true } })
})
