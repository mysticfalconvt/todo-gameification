// Generic LLM chat helper. Returns the assistant's text content on success,
// null on any failure (not configured / network / parse). All callers are
// expected to treat null as "no LLM response" and gracefully skip whatever
// feature they were building on top.
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
      console.error(`[llm] chat call failed: HTTP ${res.status}`)
      return null
    }
    const body = (await res.json()) as {
      choices?: Array<{ message?: { content?: string } }>
    }
    return body.choices?.[0]?.message?.content ?? null
  } catch (err) {
    if ((err as Error)?.name === 'AbortError') {
      console.error('[llm] chat call timed out')
    } else {
      console.error('[llm] chat call errored:', err)
    }
    return null
  } finally {
    clearTimeout(timer)
  }
}
