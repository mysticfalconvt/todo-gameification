import { formatInTimeZone } from 'date-fns-tz'
import type { Difficulty, DomainEvent } from './events'

export interface Progression {
  xp: number
  level: number
  currentStreak: number
  longestStreak: number
  tokens: number
  // Banked streak freezes. A freeze is auto-consumed when the user misses a
  // day, keeping the streak alive instead of resetting it. Earned by crossing
  // streak milestones; capped at MAX_STREAK_FREEZES.
  streakFreezes: number
  lastCompletionAt: Date | null
}

export const INITIAL_PROGRESSION: Progression = {
  xp: 0,
  level: 1,
  currentStreak: 0,
  longestStreak: 0,
  tokens: 0,
  streakFreezes: 0,
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

// Long-term streak milestones. Crossing one grants a burst of arcade tokens
// plus a streak freeze (a bankable safety net), and unlocks a collectible
// badge derived purely from longestStreak (no storage). Rewards are computed
// deterministically inside `applyEvent` on the existing `task.completed`
// event, so they survive event replay without a new event type.
export interface StreakMilestone {
  days: number
  tokens: number
  id: string
  label: string
}

export const STREAK_MILESTONES: readonly StreakMilestone[] = [
  { days: 7, tokens: 3, id: 'week', label: 'Week One' },
  { days: 14, tokens: 5, id: 'fortnight', label: 'Fortnight' },
  { days: 30, tokens: 15, id: 'monthly', label: 'Monthly' },
  { days: 60, tokens: 25, id: 'steady', label: 'Steady Sixty' },
  { days: 100, tokens: 50, id: 'centurion', label: 'Centurion' },
  { days: 180, tokens: 80, id: 'half-year', label: 'Half-Year' },
  { days: 365, tokens: 200, id: 'year', label: 'Year of Showing Up' },
] as const

// How many freezes a user can bank at once. Earning past the cap is a no-op.
export const MAX_STREAK_FREEZES = 3

// Milestones whose threshold was passed going from prevStreak to newStreak
// (prev < days <= new). Streaks only advance by 1 per streak-day so at most
// one is returned in practice, but this stays correct for any jump.
export function milestonesCrossed(
  prevStreak: number,
  newStreak: number,
): StreakMilestone[] {
  return STREAK_MILESTONES.filter(
    (m) => prevStreak < m.days && m.days <= newStreak,
  )
}

// The highest milestone a user has ever reached (their current badge), or
// null if they haven't hit the first tier yet. Derived from longestStreak.
export function badgeForStreak(longestStreak: number): StreakMilestone | null {
  let earned: StreakMilestone | null = null
  for (const m of STREAK_MILESTONES) {
    if (m.days <= longestStreak) earned = m
  }
  return earned
}

// Every milestone the user has earned, for a profile trophy row.
export function earnedBadges(longestStreak: number): StreakMilestone[] {
  return STREAK_MILESTONES.filter((m) => m.days <= longestStreak)
}

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

// Soft-target multiplier for week-target tasks. Rewards early completion,
// gently docks late completion, falls to the hard-late floor only after
// the week is over. dayDelta = (completedDay − targetDay) in user TZ,
// computed at day granularity so a midnight rollover doesn't matter.
export function weekTargetMultiplier(input: {
  dueAt: Date | null
  completedAt: Date
  timeZone: string
}): number {
  if (!input.dueAt) return 1.0
  const dayDelta = daysBetween(input.dueAt, input.completedAt, input.timeZone)
  if (dayDelta <= -3) return 1.25
  if (dayDelta === -2) return 1.2
  if (dayDelta === -1) return 1.1
  if (dayDelta === 0) return 1.0
  if (dayDelta === 1) return 0.95
  if (dayDelta === 2) return 0.85
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

      // Streak freezes bridge a lapse: missing N days needs N-1 freezes
      // (gap === 2 means exactly one missed day). If enough are banked, the
      // freezes are consumed and the streak continues; otherwise it resets.
      let currentStreak: number
      let streakFreezes = state.streakFreezes
      if (gap === null) {
        currentStreak = 1
      } else if (gap > 1) {
        const freezesNeeded = gap - 1
        if (streakFreezes >= freezesNeeded) {
          streakFreezes -= freezesNeeded
          currentStreak = state.currentStreak + 1
        } else {
          currentStreak = 1
        }
      } else if (gap === 1) {
        currentStreak = state.currentStreak + 1
      } else {
        currentStreak = Math.max(state.currentStreak, 1)
      }

      // Milestone rewards: crossing a threshold grants a token burst and a
      // banked freeze (capped). Additive on top of any kid tokens on the event.
      const crossed = milestonesCrossed(state.currentStreak, currentStreak)
      const milestoneTokens = crossed.reduce((sum, m) => sum + m.tokens, 0)
      streakFreezes = Math.min(
        MAX_STREAK_FREEZES,
        streakFreezes + crossed.length,
      )

      const punctuality =
        event.dueKind === 'week_target'
          ? weekTargetMultiplier({
              dueAt: event.dueAt,
              completedAt: event.occurredAt,
              timeZone: options.timeZone,
            })
          : punctualityMultiplier({
              dueAt: event.dueAt,
              completedAt: event.occurredAt,
              timeOfDay: event.timeOfDay,
              timeZone: options.timeZone,
            })

      // A parent-set exact value wins outright (no multipliers) so siblings
      // doing the same chore can be equalized. Streak still advances above.
      const xpGain =
        typeof event.xpFinal === 'number'
          ? event.xpFinal
          : computeXp({
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
        // Kids earn arcade tokens from completing chores; the amount is
        // resolved at write time and stored on the event (0 for adults).
        // Milestone bonuses are added deterministically on top.
        tokens: state.tokens + (event.tokensEarned ?? 0) + milestoneTokens,
        streakFreezes,
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

    case 'focus.cancelled':
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

    case 'doomscroll.started': {
      // Break timer: debit the token spent to start it and grant the flat
      // reward XP. Both values live on the event so replay is deterministic.
      const xp = state.xp + event.xpEarned
      return {
        ...state,
        xp,
        level: levelFor(xp),
        tokens: Math.max(0, state.tokens - event.tokenCost),
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

    default:
      // Events that don't affect progression (e.g. the membership.*
      // family) fall through unchanged. Their projection lives in a
      // separate reducer (`src/domain/membership.ts`).
      return state
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
