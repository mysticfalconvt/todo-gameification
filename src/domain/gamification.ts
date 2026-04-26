import { formatInTimeZone } from 'date-fns-tz'
import type { Difficulty, DomainEvent } from './events'

export interface Progression {
  xp: number
  level: number
  currentStreak: number
  longestStreak: number
  tokens: number
  lastCompletionAt: Date | null
}

export const INITIAL_PROGRESSION: Progression = {
  xp: 0,
  level: 1,
  currentStreak: 0,
  longestStreak: 0,
  tokens: 0,
  lastCompletionAt: null,
}

const BASE_XP: Record<Difficulty, number> = {
  small: 10,
  medium: 25,
  large: 60,
}

const STREAK_CAP = 30
const STREAK_STEP = 0.02
const GRACE_MINUTES = 60

export function punctualityMultiplier(input: {
  dueAt: Date | null
  completedAt: Date
  timeOfDay: string | null
  timeZone: string
}): number {
  if (!input.timeOfDay || !input.dueAt) return 1.0
  const minutesLate =
    (input.completedAt.getTime() - input.dueAt.getTime()) / 60_000
  if (minutesLate <= GRACE_MINUTES) return 1.0

  const dueDay = formatInTimeZone(input.dueAt, input.timeZone, 'yyyy-MM-dd')
  const completedDay = formatInTimeZone(
    input.completedAt,
    input.timeZone,
    'yyyy-MM-dd',
  )
  if (dueDay === completedDay) return 0.8
  return 0.5
}

export function computeXp(input: {
  difficulty: Difficulty
  xpOverride: number | null
  currentStreak: number
  punctuality: number
}): number {
  const base = input.xpOverride ?? BASE_XP[input.difficulty]
  const streakMult =
    1 + Math.min(input.currentStreak, STREAK_CAP) * STREAK_STEP
  return Math.round(base * streakMult * input.punctuality)
}

export function levelFor(xp: number): number {
  return Math.floor(Math.sqrt(Math.max(0, xp) / 50)) + 1
}

function localDayKey(date: Date, timeZone: string): string {
  return formatInTimeZone(date, timeZone, 'yyyy-MM-dd')
}

export function isNewDay(
  previous: Date | null,
  current: Date,
  timeZone: string,
): boolean {
  if (!previous) return true
  return localDayKey(previous, timeZone) !== localDayKey(current, timeZone)
}

function daysBetween(a: Date, b: Date, timeZone: string): number {
  const keyA = localDayKey(a, timeZone)
  const keyB = localDayKey(b, timeZone)
  if (keyA === keyB) return 0
  const dayA = Date.UTC(
    Number(keyA.slice(0, 4)),
    Number(keyA.slice(5, 7)) - 1,
    Number(keyA.slice(8, 10)),
  )
  const dayB = Date.UTC(
    Number(keyB.slice(0, 4)),
    Number(keyB.slice(5, 7)) - 1,
    Number(keyB.slice(8, 10)),
  )
  return Math.round((dayB - dayA) / 86_400_000)
}

export interface ApplyEventOptions {
  timeZone: string
}

export function applyEvent(
  state: Progression,
  event: DomainEvent,
  options: ApplyEventOptions,
): Progression {
  switch (event.type) {
    case 'task.completed': {
      const gap = state.lastCompletionAt
        ? daysBetween(
            state.lastCompletionAt,
            event.occurredAt,
            options.timeZone,
          )
        : null

      let currentStreak: number
      if (gap === null || gap > 1) {
        currentStreak = 1
      } else if (gap === 1) {
        currentStreak = state.currentStreak + 1
      } else {
        currentStreak = Math.max(state.currentStreak, 1)
      }

      const punctuality = punctualityMultiplier({
        dueAt: event.dueAt,
        completedAt: event.occurredAt,
        timeOfDay: event.timeOfDay,
        timeZone: options.timeZone,
      })

      const xpGain = computeXp({
        difficulty: event.difficulty,
        xpOverride: event.xpOverride,
        currentStreak,
        punctuality,
      })
      const xp = state.xp + xpGain

      return {
        xp,
        level: levelFor(xp),
        currentStreak,
        longestStreak: Math.max(state.longestStreak, currentStreak),
        tokens: state.tokens,
        lastCompletionAt: event.occurredAt,
      }
    }

    case 'task.skipped':
      return state

    case 'task.cheered': {
      // Flat XP bonus; cheers don't extend streaks.
      const xp = state.xp + event.xp
      return {
        ...state,
        xp,
        level: levelFor(xp),
      }
    }

    case 'friend.added': {
      // One-time flat XP for connecting. Doesn't affect streak.
      const xp = state.xp + event.xp
      return {
        ...state,
        xp,
        level: levelFor(xp),
      }
    }

    case 'focus.started':
      return state

    case 'focus.completed': {
      const xp = state.xp + event.xpEarned
      return {
        ...state,
        xp,
        level: levelFor(xp),
        tokens: state.tokens + event.tokensEarned,
      }
    }

    case 'game.played': {
      const xp = state.xp + event.xpReward
      return {
        ...state,
        xp,
        level: levelFor(xp),
        tokens: Math.max(0, state.tokens - event.tokenCost),
      }
    }

    case 'tokens.granted': {
      return {
        ...state,
        tokens: Math.max(0, state.tokens + event.amount),
      }
    }

    case 'task.step.completed': {
      const xp = state.xp + event.xpEarned
      return { ...state, xp, level: levelFor(xp) }
    }

    case 'task.step.uncompleted': {
      const xp = Math.max(0, state.xp - event.xpRefunded)
      return { ...state, xp, level: levelFor(xp) }
    }
  }
}

// Step XP allocation: 75% of the parent's base XP is split across all
// current steps; the parent itself grants the remaining 25% as a
// completion bonus. So total XP for a fully checklist'd parent task
// matches a normal completion (within rounding).
const STEP_SHARE = 0.75
const PARENT_BONUS = 0.25

const STEP_BASE_FALLBACK = 1

export function computeStepXp(input: {
  parentBaseXp: number
  totalSteps: number
  currentStreak: number
  punctuality: number
}): number {
  if (input.totalSteps <= 0) return STEP_BASE_FALLBACK
  const perStep = Math.floor((input.parentBaseXp * STEP_SHARE) / input.totalSteps)
  const base = Math.max(STEP_BASE_FALLBACK, perStep)
  const streakMult =
    1 + Math.min(input.currentStreak, STREAK_CAP) * STREAK_STEP
  return Math.round(base * streakMult * input.punctuality)
}

export function parentBonusBaseXp(parentBaseXp: number): number {
  return Math.max(1, Math.floor(parentBaseXp * PARENT_BONUS))
}

export function baseXpForDifficulty(
  difficulty: Difficulty,
  xpOverride: number | null,
): number {
  return xpOverride ?? BASE_XP[difficulty]
}

export function replay(
  events: readonly DomainEvent[],
  options: ApplyEventOptions,
): Progression {
  return events.reduce(
    (state, event) => applyEvent(state, event, options),
    INITIAL_PROGRESSION,
  )
}
