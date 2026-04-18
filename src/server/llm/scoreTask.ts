import type { Difficulty } from '../../domain/events'

export const XP_TIERS = {
  tiny: 5,
  small: 10,
  medium: 25,
  large: 50,
  huge: 100,
  massive: 200,
} as const

export type XpTier = keyof typeof XP_TIERS

const SYSTEM_PROMPT = `You are an XP scorer for a gamified personal todo app used by people with ADHD. Your ONE job is to assign CONSISTENT XP values so that the same type of task scores the same for every user.

Use this strict 6-tier rubric. Pick ONE tier — never in-between. Be decisive.

- **tiny** (5 XP): under 2 minutes, zero cognitive load. Examples: "reply to a text", "take trash to curb", "put dishes in dishwasher"
- **small** (10 XP): 2–10 minutes, low friction. Examples: "water plants", "make the bed", "unload one laundry basket"
- **medium** (25 XP): 10–30 minutes OR needs real focus. Examples: "pay bills online", "clean kitchen counters", "respond to 3 emails carefully"
- **large** (50 XP): 30–90 minutes OR annoyingly high friction even if short. Examples: "call insurance company", "schedule doctor appointment", "mow lawn", "grocery run with a list"
- **huge** (100 XP): 90+ minutes of sustained focus OR emotionally heavy. Examples: "write performance review", "deep clean the bathroom", "tax document gathering", "have a difficult conversation"
- **massive** (200 XP): multi-hour project OR deeply dreaded. Examples: "file taxes end-to-end", "refactor a major code module", "prepare and do a move"

SCORING RULES — follow in order:
1. Classify by realistic time-for-someone-with-ADHD, not optimistic time.
2. If a task is dreaded, anxiety-producing, or requires phone calls to strangers — bump UP one tier from pure-time estimate. "Make dentist appointment" is usually large, not small.
3. If a task is trivially automatable or habitual — don't bump. "Brush teeth" is tiny.
4. The user's difficulty hint ('small'|'medium'|'large') is a weak prior. You may override it based on the rubric.
5. Do NOT invent new tiers. Exactly one of: tiny, small, medium, large, huge, massive.

Respond with ONLY this JSON (no prose, no markdown fence):
{"tier":"<one of tiny|small|medium|large|huge|massive>","reasoning":"<one short sentence>"}`

export interface ScoreResult {
  xp: number
  tier: XpTier
  reasoning: string
}

export interface ScoreInput {
  title: string
  notes?: string | null
  difficultyHint: Difficulty
}

export function isLlmConfigured(): boolean {
  return Boolean(process.env.LLM_BASE_URL && process.env.LLM_MODEL)
}

function isConfigured(): boolean {
  return isLlmConfigured()
}

export async function scoreTask(
  input: ScoreInput,
  { timeoutMs = 10_000 }: { timeoutMs?: number } = {},
): Promise<ScoreResult | null> {
  if (!isConfigured()) return null

  const baseUrl = process.env.LLM_BASE_URL!.replace(/\/$/, '')
  const model = process.env.LLM_MODEL!
  const apiKey = process.env.LLM_API_KEY || 'lm-studio'

  const userContent = [
    `Task title: "${input.title}"`,
    `Notes: "${input.notes ?? ''}"`,
    `User's difficulty hint: ${input.difficultyHint}`,
  ].join('\n')

  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)

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
        temperature: 0.1,
        response_format: {
          type: 'json_schema',
          json_schema: {
            name: 'xp_score',
            strict: true,
            schema: {
              type: 'object',
              properties: {
                tier: {
                  type: 'string',
                  enum: ['tiny', 'small', 'medium', 'large', 'huge', 'massive'],
                },
                reasoning: { type: 'string' },
              },
              required: ['tier', 'reasoning'],
              additionalProperties: false,
            },
          },
        },
        messages: [
          { role: 'system', content: SYSTEM_PROMPT },
          { role: 'user', content: userContent },
        ],
      }),
    })

    if (!res.ok) {
      console.error(`[llm] score call failed: HTTP ${res.status}`)
      return null
    }

    const body = (await res.json()) as {
      choices?: Array<{ message?: { content?: string } }>
    }
    const content = body.choices?.[0]?.message?.content
    if (!content) {
      console.error('[llm] score call returned no content')
      return null
    }

    const parsed = parseScore(content)
    if (!parsed) {
      console.error('[llm] could not parse score:', content.slice(0, 200))
      return null
    }
    return parsed
  } catch (err) {
    if ((err as Error)?.name === 'AbortError') {
      console.error('[llm] score call timed out')
    } else {
      console.error('[llm] score call errored:', err)
    }
    return null
  } finally {
    clearTimeout(timer)
  }
}

function parseScore(raw: string): ScoreResult | null {
  const stripped = raw.trim().replace(/^```(?:json)?\s*|\s*```$/g, '')
  let data: { tier?: unknown; reasoning?: unknown }
  try {
    data = JSON.parse(stripped)
  } catch {
    const match = stripped.match(/\{[\s\S]*\}/)
    if (!match) return null
    try {
      data = JSON.parse(match[0])
    } catch {
      return null
    }
  }
  const tierRaw = typeof data.tier === 'string' ? data.tier.toLowerCase() : null
  if (!tierRaw || !(tierRaw in XP_TIERS)) return null
  const tier = tierRaw as XpTier
  return {
    xp: XP_TIERS[tier],
    tier,
    reasoning: typeof data.reasoning === 'string' ? data.reasoning : '',
  }
}
