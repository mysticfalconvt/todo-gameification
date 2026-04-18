import { formatInTimeZone } from 'date-fns-tz'
import type { Difficulty, DomainEvent } from './events'

export interface Progression {
  xp: number
  level: number
  currentStreak: number
  longestStreak: number
  lastCompletionAt: Date | null
}

export const INITIAL_PROGRESSION: Progression = {
  xp: 0,
  level: 1,
  currentStreak: 0,
  longestStreak: 0,
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
        lastCompletionAt: event.occurredAt,
      }
    }

    case 'task.skipped':
      return state
  }
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
