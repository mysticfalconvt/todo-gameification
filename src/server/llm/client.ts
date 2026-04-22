// Generic LLM chat helper. Returns the assistant's text content on success,
// null on any failure (not configured / network / parse). All callers are
// expected to treat null as "no LLM response" and gracefully skip whatever
// feature they were building on top.
//
// Every call writes a row to `llm_call_log` (fire-and-forget) so the admin
// dashboard can show latency, usage, and the actual prompt/response for
// post-hoc debugging. Callers pass `track: { kind, userId }` to attribute
// the call.
import { db } from '../db/client'
import { llmCallLog } from '../db/schema'

export type LlmCallKind = 'score' | 'categorize' | 'coach'

export function isLlmConfigured(): boolean {
  return Boolean(process.env.LLM_BASE_URL && process.env.LLM_MODEL)
}

export interface LlmMessage {
  role: 'system' | 'user' | 'assistant'
  content: string
}

export interface LlmChatOptions {
  messages: LlmMessage[]
  temperature?: number
  /** Pass `{ type: 'json_schema', json_schema: ... }` for structured output. */
  responseFormat?: Record<string, unknown>
  timeoutMs?: number
  maxTokens?: number
  /** Required — every LLM call is attributed in the admin log. */
  track: { kind: LlmCallKind; userId?: string | null }
}

interface ChatResponseBody {
  choices?: Array<{ message?: { content?: string } }>
  usage?: {
    prompt_tokens?: number
    completion_tokens?: number
    total_tokens?: number
  }
  model?: string
}

export async function callLlmChat(
  options: LlmChatOptions,
): Promise<string | null> {
  if (!isLlmConfigured()) return null
  const baseUrl = process.env.LLM_BASE_URL!.replace(/\/$/, '')
  const model = process.env.LLM_MODEL!
  const apiKey = process.env.LLM_API_KEY || 'lm-studio'

  const controller = new AbortController()
  const timer = setTimeout(
    () => controller.abort(),
    options.timeoutMs ?? 15_000,
  )

  const startedAt = new Date()
  const t0 = performance.now()
  let content: string | null = null
  let errorMessage: string | null = null
  let body: ChatResponseBody | null = null

  try {
    const res = await fetch(`${baseUrl}/chat/completions`, {
      method: 'POST',
      signal: controller.signal,
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model,
        temperature: options.temperature ?? 0.7,
        ...(options.maxTokens ? { max_tokens: options.maxTokens } : {}),
        ...(options.responseFormat
          ? { response_format: options.responseFormat }
          : {}),
        messages: options.messages,
      }),
    })
    if (!res.ok) {
      errorMessage = `HTTP ${res.status}`
      console.error(`[llm] chat call failed: ${errorMessage}`)
    } else {
      body = (await res.json()) as ChatResponseBody
      content = body.choices?.[0]?.message?.content ?? null
      if (content === null) errorMessage = 'empty response'
    }
  } catch (err) {
    if ((err as Error)?.name === 'AbortError') {
      errorMessage = 'timeout'
      console.error('[llm] chat call timed out')
    } else {
      errorMessage =
        err instanceof Error ? err.message.slice(0, 500) : String(err).slice(0, 500)
      console.error('[llm] chat call errored:', err)
    }
  } finally {
    clearTimeout(timer)
    const durationMs = Math.max(0, Math.round(performance.now() - t0))
    void db
      .insert(llmCallLog)
      .values({
        userId: options.track.userId ?? null,
        kind: options.track.kind,
        model: body?.model ?? model,
        startedAt,
        durationMs,
        success: content !== null && errorMessage === null,
        errorMessage,
        promptTokens: body?.usage?.prompt_tokens ?? null,
        completionTokens: body?.usage?.completion_tokens ?? null,
        totalTokens: body?.usage?.total_tokens ?? null,
        messages: options.messages,
        response: content,
      })
      .catch((e) => console.error('[llm] log insert failed:', e))
  }

  return content
}
