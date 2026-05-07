// Word Search arcade game service. Generates puzzles fresh on every play:
// resolve a theme (preset / custom / surprise), call the LLM for a themed
// word list, build a grid, return it. The puzzle never repeats — every play
// is a new LLM call, and Surprise me also avoids the user's recently-played
// themes.
import { sql } from 'drizzle-orm'
import { db } from '../db/client'
import { generateThemedWords } from '../llm/wordSearchWords'
import { isLlmConfigured } from '../llm/client'
import { WORD_SEARCH_THEMES } from '../../games/word-search/themes'
import { buildGrid, type Placement } from '../../games/word-search/grid'

export type SizeBucket = 'small' | 'large'

export interface SizeConfig {
  grid: number
  wordCount: number
  minLen: number
  maxLen: number
}

export const SIZE_CONFIG: Record<SizeBucket, SizeConfig> = {
  small: { grid: 8, wordCount: 8, minLen: 3, maxLen: 7 },
  large: { grid: 12, wordCount: 14, minLen: 4, maxLen: 10 },
}

const THEME_REGEX = /^[A-Za-z0-9 \-']+$/
const MAX_THEME_LEN = 40

export interface NormalizedTheme {
  display: string
  key: string
}

// Validates a user-supplied custom theme. Returns null when the input is
// outside the allowed shape — caller should reject the request.
export function normalizeCustomTheme(raw: string): NormalizedTheme | null {
  const trimmed = raw.trim()
  if (trimmed.length === 0 || trimmed.length > MAX_THEME_LEN) return null
  if (!THEME_REGEX.test(trimmed)) return null
  return { display: trimmed, key: trimmed.toLowerCase() }
}

interface ResolveThemeArgs {
  userId: string
  requested: string | null
}

interface ResolvedTheme extends NormalizedTheme {
  isCustom: boolean
}

// Resolves a theme to its normalized form. `null` triggers Surprise me:
// pick a preset theme the user hasn't played recently. Otherwise the
// caller's preset/custom string is normalized; we treat it as custom only
// when it isn't in the preset catalog.
async function resolveTheme(args: ResolveThemeArgs): Promise<ResolvedTheme> {
  const presets = WORD_SEARCH_THEMES.map((t) => t.name)
  const presetSet = new Set(presets.map((p) => p.toLowerCase()))

  if (args.requested === null) {
    const recent = await recentThemeKeys(args.userId, 10)
    const unseen = presets.filter((p) => !recent.has(p.toLowerCase()))
    const pool = unseen.length > 0 ? unseen : presets
    const pick = pool[Math.floor(Math.random() * pool.length)]
    return { display: pick, key: pick.toLowerCase(), isCustom: false }
  }

  const normalized = normalizeCustomTheme(args.requested)
  if (!normalized) throw new Error('Invalid theme')
  const isCustom = !presetSet.has(normalized.key)
  return { ...normalized, isCustom }
}

async function recentThemeKeys(
  userId: string,
  limit: number,
): Promise<Set<string>> {
  // Theme is promoted to a top-level payload field by finishGame, mirroring
  // how wordle persists the played word.
  const rows = await db.execute<{ theme: string }>(sql`
    SELECT lower(payload->>'theme') AS theme
    FROM events
    WHERE user_id = ${userId}
      AND type = 'game.played'
      AND payload->>'gameId' = 'word-search'
      AND payload->>'theme' IS NOT NULL
    ORDER BY occurred_at DESC
    LIMIT ${limit}
  `)
  return new Set(rows.map((r) => r.theme).filter((t): t is string => Boolean(t)))
}

export interface GenerateGameArgs {
  userId: string
  size: SizeBucket
  // null means "Surprise me", otherwise the theme string (preset or custom).
  theme: string | null
}

export interface GeneratedGame {
  theme: string
  isCustom: boolean
  size: SizeBucket
  grid: string[][]
  // Only the words that actually got placed on the grid. The client uses
  // this list as the target; placements drives strike-through overlays.
  words: string[]
  placements: Placement[]
}

export async function generateGame(
  args: GenerateGameArgs,
): Promise<GeneratedGame> {
  const resolved = await resolveTheme({
    userId: args.userId,
    requested: args.theme,
  })
  const cfg = SIZE_CONFIG[args.size]

  // Every theme — preset, custom, surprise — goes through the LLM. Fresh
  // word list per play; nothing is reused across calls.
  if (!isLlmConfigured()) {
    throw new Error(
      'Word generation is offline (LLM not configured). Set LLM_BASE_URL and LLM_MODEL.',
    )
  }
  const generated = await generateThemedWords({
    theme: resolved.display,
    count: cfg.wordCount,
    minLen: cfg.minLen,
    maxLen: cfg.maxLen,
    userId: args.userId,
  })
  if (!generated || generated.length === 0) {
    throw new Error(
      "Couldn't generate a puzzle for that theme — try a different theme or try again.",
    )
  }
  const words = generated

  const built = buildGrid(words, cfg.grid)
  if (built.placements.length === 0) {
    throw new Error('Could not build a puzzle for that theme')
  }
  const placedWords = built.placements.map((p) => p.word)

  return {
    theme: resolved.display,
    isCustom: resolved.isCustom,
    size: args.size,
    grid: built.grid,
    words: placedWords,
    placements: built.placements,
  }
}
