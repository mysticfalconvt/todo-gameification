// Helpers shared by every /api/v1/* route: token auth, JSON envelopes,
// structured error responses.
import { verifyApiToken } from '../services/api-tokens'

export type RestHandler = (ctx: {
  request: Request
  userId: string
  params: Record<string, string>
}) => Promise<Response> | Response

export function jsonOk(data: unknown, status = 200): Response {
  return Response.json({ data }, { status })
}

export function jsonError(
  code: string,
  message: string,
  status: number,
): Response {
  return Response.json({ error: { code, message } }, { status })
}

async function extractUserId(request: Request): Promise<string | null> {
  const header = request.headers.get('authorization') ?? ''
  const match = /^Bearer\s+(.+)$/i.exec(header)
  if (!match) return null
  const result = await verifyApiToken(match[1].trim())
  return result?.userId ?? null
}

/**
 * Wraps a handler with Bearer-token auth + consistent error formatting.
 * Unknown errors are surfaced as 500 with a sanitized message — service
 * functions throw Error("task not found") / ("instance not found") etc., so
 * we map those to 404 where appropriate.
 */
export function authedRoute(
  handler: (ctx: {
    request: Request
    userId: string
    params: Record<string, string>
  }) => Promise<Response> | Response,
) {
  return async ({
    request,
    params,
  }: {
    request: Request
    params?: Record<string, string>
  }): Promise<Response> => {
    const userId = await extractUserId(request)
    if (!userId) return jsonError('unauthorized', 'Invalid or missing token', 401)
    try {
      return await handler({ request, userId, params: params ?? {} })
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Unknown error'
      const status = /not found/i.test(message)
        ? 404
        : /required|invalid|must be|too long/i.test(message)
          ? 400
          : 500
      const code = status === 404 ? 'not_found' : status === 400 ? 'validation' : 'internal'
      return jsonError(code, message, status)
    }
  }
}

export async function readJson<T>(request: Request): Promise<T> {
  try {
    return (await request.json()) as T
  } catch {
    throw new Error('invalid JSON body')
  }
}
