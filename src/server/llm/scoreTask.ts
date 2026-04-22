import type { Difficulty } from '../../domain/events'
import { callLlmChat, isLlmConfigured } from './client'

// Each tier defines a window. The LLM picks both a tier (coarse bucket for
// grouping / stats) and a specific XP value inside that window — so two
// "medium" tasks can score 22 and 35 instead of both locking to the same
// midpoint. Windows are contiguous (no overlap), so the tier remains the
// source of truth for bucketing.
export const XP_WINDOWS = {
  tiny: { min: 3, max: 7, typical: 5 },
  small: { min: 8, max: 19, typical: 13 },
  medium: { min: 20, max: 39, typical: 28 },
  large: { min: 40, max: 79, typical: 58 },
  huge: { min: 80, max: 159, typical: 115 },
  massive: { min: 160, max: 300, typical: 220 },
} as const

export type XpTier = keyof typeof XP_WINDOWS

// Back-compat export — anything that just wants a representative XP value
// per tier can read from this.
export const XP_TIERS: Record<XpTier, number> = Object.fromEntries(
  (Object.keys(XP_WINDOWS) as XpTier[]).map((t) => [
    t,
    XP_WINDOWS[t].typical,
  ]),
) as Record<XpTier, number>

const SYSTEM_PROMPT = `You are an XP scorer for a gamified personal todo app used by people with ADHD. Your job is to assign a specific XP value that reflects the real effort of a task, using a two-step decision:

STEP 1 — Pick the coarse tier (bucket):
- **tiny** (3–7 XP): under 2 minutes, zero cognitive load. Examples: "reply to a text", "take trash to curb", "put dishes in dishwasher"
- **small** (8–19 XP): 2–10 minutes, low friction. Examples: "water plants", "make the bed", "unload one laundry basket"
- **medium** (20–39 XP): 10–30 minutes OR needs real focus. Examples: "pay bills online", "clean kitchen counters", "respond to 3 emails carefully"
- **large** (40–79 XP): 30–90 minutes OR annoyingly high friction even if short. Examples: "call insurance company", "schedule doctor appointment", "mow lawn", "grocery run with a list"
- **huge** (80–159 XP): 90+ minutes of sustained focus OR emotionally heavy. Examples: "write performance review", "deep clean the bathroom", "tax document gathering", "have a difficult conversation"
- **massive** (160–300 XP): multi-hour project OR deeply dreaded. Examples: "file taxes end-to-end", "refactor a major code module", "prepare and do a move"

STEP 2 — Pick a specific XP value inside that tier's window:
- Nudge LOW within the window when the task is short, easy, habitual, or low-stakes relative to its tier.
- Nudge MID (near the middle) for the typical version of the task.
- Nudge HIGH within the window when the task is long, dreaded, anxiety-producing, requires interacting with strangers, or is the heavy/gnarly version of its tier. Never exceed the tier maximum.
- Use the full width of the window. Avoid always returning round numbers — "brush teeth" might be 4 not 5; "respond to 3 emails carefully" might be 27 or 32, not always 25.
- Two tasks that are clearly different in effort should not get the same XP. If they're both "medium", one could be 22 and the other 36.

SCORING RULES — follow in order:
1. Classify by realistic time-for-someone-with-ADHD, not optimistic time.
2. If a task is dreaded, anxiety-producing, or requires phone calls to strangers — push toward the HIGH end of the tier (or bump up a tier if it's clearly outside the window). "Make dentist appointment" is usually large-high, not small.
3. If a task is trivially automatable or habitual — push toward the LOW end of the tier. "Brush teeth" is tiny-low.
4. The user's difficulty hint ('small'|'medium'|'large') is a weak prior. You may override it.
5. Pick exactly one tier from: tiny, small, medium, large, huge, massive. The xp value MUST fall within that tier's window.

Respond with ONLY this JSON (no prose, no markdown fence):
{"tier":"<one of tiny|small|medium|large|huge|massive>","xp":<integer inside the tier's window>,"reasoning":"<one short sentence>"}`

export interface ScoreResult {
  xp: number
  tier: XpTier
  reasoning: string
}

export interface ScoreInput {
  title: string
  notes?: string | null
  difficultyHint: Difficulty
  userId: string
  // Recently scored tasks for the same user. Shown to the model as
  // calibration examples so repeat or similar titles stay consistent with
  // what they scored before. Keep short (≤12) — these are hints, not rules.
  recentScores?: Array<{ title: string; xp: number }>
}

export { isLlmConfigured }

export async function scoreTask(
  input: ScoreInput,
  opts: { timeoutMs?: number } = {},
): Promise<ScoreResult | null> {
  if (!isLlmConfigured()) return null

  const content = await callLlmChat({
    messages: [
      { role: 'system', content: SYSTEM_PROMPT },
      { role: 'user', content: buildUserContent(input) },
    ],
    temperature: 0.1,
    timeoutMs: opts.timeoutMs ?? 10_000,
    responseFormat: {
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
            xp: {
              type: 'integer',
              minimum: XP_WINDOWS.tiny.min,
              maximum: XP_WINDOWS.massive.max,
            },
            reasoning: { type: 'string' },
          },
          required: ['tier', 'xp', 'reasoning'],
          additionalProperties: false,
        },
      },
    },
    track: { kind: 'score', userId: input.userId },
  })

  if (!content) return null
  const parsed = parseScore(content)
  if (!parsed) {
    console.error('[llm] could not parse score:', content.slice(0, 200))
    return null
  }
  return parsed
}

function buildUserContent(input: ScoreInput): string {
  const lines: string[] = [
    `Task title: "${input.title}"`,
    `Notes: "${input.notes ?? ''}"`,
    `User's difficulty hint: ${input.difficultyHint}`,
  ]
  if (input.recentScores && input.recentScores.length > 0) {
    // Examples help the model stay consistent with how this same user has
    // scored similar things before. They're a soft prior — the rubric
    // still wins when examples contradict it.
    const examples = input.recentScores
      .slice(0, 12)
      .map((r) => `- "${r.title}" → ${r.xp} XP`)
      .join('\n')
    lines.push(
      `Recent tasks scored for this same user (calibration, not rules):\n${examples}`,
    )
  }
  return lines.join('\n')
}

function parseScore(raw: string): ScoreResult | null {
  const stripped = raw.trim().replace(/^```(?:json)?\s*|\s*```$/g, '')
  let data: { tier?: unknown; xp?: unknown; reasoning?: unknown }
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
  if (!tierRaw || !(tierRaw in XP_WINDOWS)) return null
  const tier = tierRaw as XpTier
  const window = XP_WINDOWS[tier]
  // If the model returns a valid integer inside the window, use it. Clamp
  // anything outside the window back to its nearest window edge so a
  // tier/xp mismatch still gives a sane, tier-respecting number. Fall back
  // to the typical when xp is missing or non-numeric.
  let xp: number
  if (typeof data.xp === 'number' && Number.isFinite(data.xp)) {
    xp = Math.round(Math.max(window.min, Math.min(window.max, data.xp)))
  } else {
    xp = window.typical
  }
  return {
    xp,
    tier,
    reasoning: typeof data.reasoning === 'string' ? data.reasoning : '',
  }
}
