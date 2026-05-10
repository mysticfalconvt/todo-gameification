import { createServerFn } from '@tanstack/react-start'
import { authMiddleware } from '../middleware/auth'
import { deleteAccount } from '../services/account'

// Self-serve account deletion. Auth-gated by the standard middleware,
// so the user must already be signed in. The client should also
// require a typed-confirmation gesture before calling.
export const deleteAccountFn = createServerFn({ method: 'POST' })
  .middleware([authMiddleware])
  .handler(({ context }) => deleteAccount(context.userId))
