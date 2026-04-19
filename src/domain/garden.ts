// Garden progression — alternative UI over the same event log.
//
// Each task.completed event "waters" the plant associated with that
// task's category. The reducer is pure so tests + SSR can replay the
// garden state deterministically from events. Species/emoji decoration
// lives in the UI layer; this file is just counts + timing.

import { formatInTimeZone } from 'date-fns-tz'

// Matches the categorySlug convention: null == uncategorized.
export type PlantKey = string

export const UNCATEGORIZED_KEY: PlantKey = '_none_'

export interface PlantState {
  key: PlantKey
  categorySlug: string | null
  waterings: number
  lastWateredAt: Date | null
  // Consecutive days (in the user's timezone) with at least one
  // completion in this category. Rolls over cleanly across day
  // boundaries; skips reset to 1 on the next water.
  currentStreak: number
  longestStreak: number
}

export interface GardenState {
  plants: Record<PlantKey, PlantState>
}

export const INITIAL_GARDEN: GardenState = { plants: {} }

function emptyPlant(
  key: PlantKey,
  categorySlug: string | null,
): PlantState {
  return {
    key,
    categorySlug,
    waterings: 0,
    lastWateredAt: null,
    currentStreak: 0,
    longestStreak: 0,
  }
}

// Narrow event shape so this module doesn't depend on domain/events.
// Only task.completed matters to the garden; other events are ignored.
export interface GardenCompletionEvent {
  type: 'task.completed'
  occurredAt: Date
  categorySlug: string | null
}

function dayKey(date: Date, timeZone: string): string {
  return formatInTimeZone(date, timeZone, 'yyyy-MM-dd')
}

function daysBetween(a: string, b: string): number {
  // Both are YYYY-MM-DD in the same tz; subtract as epoch days.
  const parse = (s: string) => {
    const [y, m, d] = s.split('-').map(Number)
    return Date.UTC(y, m - 1, d) / 86_400_000
  }
  return parse(b) - parse(a)
}

export interface ApplyGardenOptions {
  timeZone: string
}

export function applyGardenEvent(
  state: GardenState,
  event: GardenCompletionEvent,
  options: ApplyGardenOptions,
): GardenState {
  if (event.type !== 'task.completed') return state
  const key = event.categorySlug ?? UNCATEGORIZED_KEY
  const prev = state.plants[key] ?? emptyPlant(key, event.categorySlug)

  const prevDay = prev.lastWateredAt
    ? dayKey(prev.lastWateredAt, options.timeZone)
    : null
  const thisDay = dayKey(event.occurredAt, options.timeZone)

  let currentStreak: number
  if (!prevDay) {
    currentStreak = 1
  } else {
    const gap = daysBetween(prevDay, thisDay)
    if (gap === 0) currentStreak = prev.currentStreak
    else if (gap === 1) currentStreak = prev.currentStreak + 1
    else currentStreak = 1
  }

  const next: PlantState = {
    key,
    categorySlug: event.categorySlug,
    waterings: prev.waterings + 1,
    lastWateredAt: event.occurredAt,
    currentStreak,
    longestStreak: Math.max(prev.longestStreak, currentStreak),
  }

  return { plants: { ...state.plants, [key]: next } }
}

export function replayGarden(
  events: readonly GardenCompletionEvent[],
  options: ApplyGardenOptions,
): GardenState {
  return events.reduce(
    (acc, e) => applyGardenEvent(acc, e, options),
    INITIAL_GARDEN,
  )
}

// Eight growth stages keyed by total waterings. Early thresholds are
// tight so new plants change quickly; late thresholds space out so
// long-term users still have something unlocking months in. Calibrated
// against a daily habit: blooming ≈ 1 month, lush ≈ 3 months, ancient
// ≈ 8 months, grove ≈ 1.5 years.
export type GrowthStage =
  | 'seed'
  | 'sprout'
  | 'young'
  | 'mature'
  | 'blooming'
  | 'lush'
  | 'ancient'
  | 'grove'

export function growthStage(waterings: number): GrowthStage {
  if (waterings <= 0) return 'seed'
  if (waterings < 3) return 'sprout'
  if (waterings < 10) return 'young'
  if (waterings < 30) return 'mature'
  if (waterings < 100) return 'blooming'
  if (waterings < 250) return 'lush'
  if (waterings < 500) return 'ancient'
  return 'grove'
}

// Milestone flair that accumulates independently of growth stage —
// these keep late-game plants visually interesting once the base stage
// plateaus. Each threshold unlocks a different critter; earlier flair
// stays as the plant matures.
export type Decoration = 'butterfly' | 'bee' | 'bird' | 'sparkle'

export function milestoneDecorations(waterings: number): Decoration[] {
  const out: Decoration[] = []
  if (waterings >= 50) out.push('butterfly')
  if (waterings >= 150) out.push('bee')
  if (waterings >= 300) out.push('bird')
  if (waterings >= 500) out.push('sparkle')
  return out
}

// Derived mood purely from recency. Never terminal — next watering
// resets straight back to `perky`. This is the anti-guilt lever.
export type Mood = 'perky' | 'thirsty' | 'wilting' | 'dormant'

export function mood(lastWateredAt: Date | null, now = new Date()): Mood {
  if (!lastWateredAt) return 'dormant'
  const hours =
    (now.getTime() - lastWateredAt.getTime()) / (60 * 60 * 1000)
  if (hours < 30) return 'perky'
  if (hours < 72) return 'thirsty'
  return 'wilting'
}
