// LLM-assigned category. Intentionally separate from scoreTask — one value
// per call, strictly constrained to the user's current taxonomy.
import { callLlmChat, isLlmConfigured } from './client'

const SYSTEM_PROMPT = `You are a task categorizer for a personal todo app. Given a task title (and optional notes), pick EXACTLY ONE category from the user's provided list.

Rules:
- You MUST pick a slug that appears in the provided list. No inventing new ones.
- Pick the closest conceptual match. Use "other" (if present) as the last resort.
- Be decisive. One slug. No tied picks.
- Output ONLY the structured JSON. No prose outside it.

Respond with this exact JSON shape:
{"slug":"<one of the provided slugs>","reasoning":"<one short sentence>"}`

export interface CategorizeInput {
  title: string
  notes?: string | null
  categories: Array<{
    slug: string
    label: string
    description?: string | null
  }>
  userId: string
}

export interface CategorizeResult {
  slug: string
  reasoning: string
}

export { isLlmConfigured }

export async function categorizeTask(
  input: CategorizeInput,
): Promise<CategorizeResult | null> {
  if (!isLlmConfigured()) return null
  if (input.categories.length === 0) return null
  const slugs = input.categories.map((c) => c.slug)
  const userContent = [
    'Available categories:',
    ...input.categories.map((c) => {
      const desc = c.description?.trim()
      return desc
        ? `- ${c.slug} (${c.label}): ${desc}`
        : `- ${c.slug} (${c.label})`
    }),
    '',
    `Task title: "${input.title}"`,
    `Notes: "${input.notes ?? ''}"`,
  ].join('\n')

  const raw = await callLlmChat({
    messages: [
      { role: 'system', content: SYSTEM_PROMPT },
      { role: 'user', content: userContent },
    ],
    temperature: 0.1,
    maxTokens: 120,
    timeoutMs: 10_000,
    responseFormat: {
      type: 'json_schema',
      json_schema: {
        name: 'category_pick',
        strict: true,
        schema: {
          type: 'object',
          properties: {
            slug: { type: 'string', enum: slugs },
            reasoning: { type: 'string' },
          },
          required: ['slug', 'reasoning'],
          additionalProperties: false,
        },
      },
    },
    track: { kind: 'categorize', userId: input.userId },
  })

  const parsed = parseResult(raw)
  if (!parsed) return null
  // Belt + suspenders: enforce the enum client-side in case the model cheats.
  if (!slugs.includes(parsed.slug)) return null
  return parsed
}

function parseResult(raw: string | null): CategorizeResult | null {
  if (!raw) return null
  const stripped = raw.trim().replace(/^```(?:json)?\s*|\s*```$/g, '')
  let data: { slug?: unknown; reasoning?: unknown }
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
  if (typeof data.slug !== 'string') return null
  return {
    slug: data.slug,
    reasoning: typeof data.reasoning === 'string' ? data.reasoning : '',
  }
}
