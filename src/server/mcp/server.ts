import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { WebStandardStreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js'
import { verifyApiToken } from '../services/api-tokens'
import { registerTools } from './tools'

/**
 * Handle a single MCP HTTP request.
 *
 * We run in stateless mode: each request spins up its own McpServer +
 * transport, authenticates via Bearer token, and disposes both when done.
 * This keeps per-session state in the client (Claude Desktop, etc.) and
 * avoids any need to coordinate session storage on the server.
 */
export async function handleMcpRequest(request: Request): Promise<Response> {
  const auth = request.headers.get('authorization') ?? ''
  const match = /^Bearer\s+(.+)$/i.exec(auth)
  if (!match) {
    return Response.json(
      { error: { code: 'unauthorized', message: 'Bearer token required' } },
      { status: 401 },
    )
  }
  const verified = await verifyApiToken(match[1].trim())
  if (!verified) {
    return Response.json(
      { error: { code: 'unauthorized', message: 'Invalid token' } },
      { status: 401 },
    )
  }

  const { userId } = verified

  const server = new McpServer(
    { name: 'todo-xp', version: '0.1.0' },
    { capabilities: { tools: {} } },
  )
  registerTools(server, () => userId)

  const transport = new WebStandardStreamableHTTPServerTransport({
    // Stateless: new session per request, no session storage on our side.
    sessionIdGenerator: undefined,
    enableJsonResponse: true,
  })
  await server.connect(transport)
  return transport.handleRequest(request)
}
