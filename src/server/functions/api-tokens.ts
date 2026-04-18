import { createServerFn } from '@tanstack/react-start'
import { authMiddleware } from '../middleware/auth'
import * as service from '../services/api-tokens'

export const createApiToken = createServerFn({ method: 'POST' })
  .middleware([authMiddleware])
  .inputValidator((data: { name: string }) => data)
  .handler(({ data, context }) =>
    service.createApiToken(context.userId, data.name),
  )

export const listApiTokens = createServerFn({ method: 'GET' })
  .middleware([authMiddleware])
  .handler(({ context }) => service.listApiTokens(context.userId))

export const revokeApiToken = createServerFn({ method: 'POST' })
  .middleware([authMiddleware])
  .inputValidator((data: { tokenId: string }) => data)
  .handler(({ data, context }) =>
    service.revokeApiToken(context.userId, data.tokenId),
  )
