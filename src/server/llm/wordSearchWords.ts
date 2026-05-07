// LLM-backed word generator for the Word Search arcade game. Returns a
// validated, deduped list of uppercase A–Z words within the requested length
// window. Returns null when the LLM is unconfigured, errors out, or returns
// fewer than `minCount` valid words — callers then either fall back to a
// canned word list (preset / surprise themes) or surface an error to the
// user (custom themes).
import { callLlmChat, isLlmConfigured } from './client'

export interface GenerateThemedWordsInput {
  theme: string
  count: number
  minLen: number
  maxLen: number
  userId?: string | null
}

export async function generateThemedWords(
  input: GenerateThemedWordsInput,
): Promise<string[] | null> {
  if (!isLlmConfigured()) return null
  const { theme, count, minLen, maxLen, userId } = input

  const system = 'You generate themed word lists for word-search puzzles.'

  // Ask for a few more than we need so sanitize/dedupe doesn't push us
  // under count when the model returns a couple of borderline entries.
  const target = count + 4
  const user = `Generate a list of ${target} words for the theme: "${theme.slice(0, 80)}".

Requirements:
- Every word must clearly fit the theme (an example of it, a kind of it, or a closely associated term). Stay strictly on theme.
- Each word must be ${minLen}–${maxLen} letters, ALL UPPERCASE, letters A–Z only (no spaces, hyphens, apostrophes, digits, accents).
- No duplicates. No brand or product names. No specific people's names.
- Return ${target} complete words. If only a few are obvious, include less-common examples until you have ${target}.
- Do NOT return placeholders like "...", "...more...", or ellipses. Only complete words.

Examples of how to interpret a theme (each shows only 5 words — your list must contain ${target}):
- "Music" → ["GUITAR", "PIANO", "DRUMS", "VIOLIN", "TEMPO"]
- "Nature" → ["RIVER", "FOREST", "MEADOW", "VALLEY", "STREAM"]
- "tree species" → ["OAK", "MAPLE", "BIRCH", "PINE", "CEDAR"]

If the theme is genuine gibberish you cannot interpret at all, return an empty array.

Respond with JSON only, no prose: { "words": ["WORD1", "WORD2", ...] }`

  console.log(
    `\n[word-search] ── REQUEST for theme "${theme}" (count=${count}, target=${target}, len=${minLen}-${maxLen}) ──\n` +
      `── SYSTEM ──\n${system}\n\n── USER ──\n${user}\n`,
  )

  const content = await callLlmChat({
    messages: [
      { role: 'system', content: system },
      { role: 'user', content: user },
    ],
    temperature: 0.7,
    // 60s — local models without strict-schema enforcement are slower
    // because they actually generate the full list. The setup screen
    // already shows a "Generating puzzle…" spinner so the player isn't
    // staring at a blank screen.
    timeoutMs: 60_000,
    maxTokens: 6000,
    // No json_schema response_format here. Strict-schema mode pushes many
    // local models into a degenerate "minimum-valid-output" loop where
    // they emit a placeholder and stop — exactly what was happening
    // (`"B..."`). Our parser already handles fenced and prose-wrapped JSON,
    // so plain-text JSON output is fine.
    track: { kind: 'word_search', userId: userId ?? null },
  })

  console.log(
    `\n[word-search] ── RESPONSE for theme "${theme}" ──\n${content ?? '<null>'}\n── END RESPONSE ──\n`,
  )

  if (!content) {
    console.error('[word-search] LLM returned no content for theme:', theme)
    return null
  }
  const parsed = parseWords(content)
  if (!parsed) {
    console.error(
      '[word-search] could not parse LLM response for theme:',
      theme,
      'raw:',
      content.slice(0, 500),
    )
    return null
  }
  const { kept, rejected } = sanitizeVerbose(parsed, minLen, maxLen, count)
  // Need at least 4 valid words to make a sensible puzzle. If the LLM
  // didn't deliver, let the caller surface an error instead of producing a
  // bad puzzle.
  if (kept.length < Math.min(4, count)) {
    console.error(
      `[word-search] only ${kept.length}/${count} valid words for theme "${theme}" (len ${minLen}-${maxLen}).`,
      '\n  raw response:',
      content.slice(0, 500),
      '\n  parsed words:',
      parsed,
      '\n  rejected (with reason):',
      rejected,
    )
    return null
  }
  if (kept.length < count) {
    console.warn(
      `[word-search] LLM delivered ${kept.length}/${count} for theme "${theme}".`,
      'rejected:',
      rejected,
    )
  }
  return kept
}

function parseWords(raw: string): string[] | null {
  const stripped = raw.trim().replace(/^```(?:json)?\s*|\s*```$/g, '')
  let data: { words?: unknown }
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
  if (!Array.isArray(data.words)) return null
  return data.words.filter((w): w is string => typeof w === 'string')
}

interface SanitizeReport {
  kept: string[]
  rejected: Array<{ word: string; reason: string }>
}

function sanitizeVerbose(
  words: string[],
  minLen: number,
  maxLen: number,
  count: number,
): SanitizeReport {
  const seen = new Set<string>()
  const kept: string[] = []
  const rejected: Array<{ word: string; reason: string }> = []
  for (const raw of words) {
    const cleaned = raw.toUpperCase().replace(/[^A-Z]/g, '')
    if (cleaned !== raw.toUpperCase()) {
      // Note non-letter chars; we still try the cleaned form below.
    }
    if (cleaned.length === 0) {
      rejected.push({ word: raw, reason: 'empty after stripping non-letters' })
      continue
    }
    if (cleaned.length < minLen) {
      rejected.push({
        word: raw,
        reason: `too short (${cleaned.length} < ${minLen})`,
      })
      continue
    }
    if (cleaned.length > maxLen) {
      rejected.push({
        word: raw,
        reason: `too long (${cleaned.length} > ${maxLen})`,
      })
      continue
    }
    if (seen.has(cleaned)) {
      rejected.push({ word: raw, reason: 'duplicate' })
      continue
    }
    seen.add(cleaned)
    kept.push(cleaned)
    if (kept.length >= count) break
  }
  return { kept, rejected }
}
