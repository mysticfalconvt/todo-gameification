import { describe, expect, it } from 'vitest'
import {
  INITIAL_PROGRESSION,
  applyEvent,
  computeXp,
  isNewDay,
  levelFor,
  punctualityMultiplier,
  replay,
  weekTargetMultiplier,
} from './gamification'
import type { DomainEvent } from './events'

const UTC = 'UTC'
const at = (iso: string) => new Date(iso)

function completed(
  iso: string,
  overrides: Partial<Extract<DomainEvent, { type: 'task.completed' }>> = {},
): DomainEvent {
  return {
    type: 'task.completed',
    taskId: 't',
    instanceId: 'i',
    difficulty: 'medium',
    xpOverride: null,
    dueAt: at(iso),
    timeOfDay: null,
    occurredAt: at(iso),
    ...overrides,
  }
}

describe('computeXp', () => {
  it('uses difficulty base when no override, no streak, full punctuality', () => {
    expect(
      computeXp({
        difficulty: 'small',
        xpOverride: null,
        currentStreak: 0,
        punctuality: 1,
      }),
    ).toBe(10)
    expect(
      computeXp({
        difficulty: 'medium',
        xpOverride: null,
        currentStreak: 0,
        punctuality: 1,
      }),
    ).toBe(25)
    expect(
      computeXp({
        difficulty: 'large',
        xpOverride: null,
        currentStreak: 0,
        punctuality: 1,
      }),
    ).toBe(60)
  })

  it('applies override and streak multiplier capped at 30 days', () => {
    expect(
      computeXp({
        difficulty: 'medium',
        xpOverride: null,
        currentStreak: 30,
        punctuality: 1,
      }),
    ).toBe(40)
    expect(
      computeXp({
        difficulty: 'medium',
        xpOverride: null,
        currentStreak: 100,
        punctuality: 1,
      }),
    ).toBe(40)
  })

  it('applies punctuality multiplier to final score', () => {
    // base 25 * streak 1.0 * punctuality 0.5 = 12.5 → 13
    expect(
      computeXp({
        difficulty: 'medium',
        xpOverride: null,
        currentStreak: 0,
        punctuality: 0.5,
      }),
    ).toBe(13)
  })
})

describe('levelFor', () => {
  it('follows floor(sqrt(xp/50))+1', () => {
    expect(levelFor(0)).toBe(1)
    expect(levelFor(49)).toBe(1)
    expect(levelFor(50)).toBe(2)
    expect(levelFor(200)).toBe(3)
    expect(levelFor(4500)).toBe(10)
  })
})

describe('punctualityMultiplier', () => {
  it('is 1.0 for full-day tasks (no timeOfDay), regardless of lateness', () => {
    expect(
      punctualityMultiplier({
        dueAt: at('2026-04-18T08:00:00Z'),
        completedAt: at('2026-04-20T12:00:00Z'),
        timeOfDay: null,
        timeZone: UTC,
      }),
    ).toBe(1.0)
  })

  it('is 1.0 within 60-minute grace period', () => {
    expect(
      punctualityMultiplier({
        dueAt: at('2026-04-18T08:00:00Z'),
        completedAt: at('2026-04-18T08:45:00Z'),
        timeOfDay: '08:00',
        timeZone: UTC,
      }),
    ).toBe(1.0)
  })

  it('is 0.8 when done later the same local day', () => {
    expect(
      punctualityMultiplier({
        dueAt: at('2026-04-18T08:00:00Z'),
        completedAt: at('2026-04-18T20:00:00Z'),
        timeOfDay: '08:00',
        timeZone: UTC,
      }),
    ).toBe(0.8)
  })

  it('is 0.5 once the local day has rolled over', () => {
    expect(
      punctualityMultiplier({
        dueAt: at('2026-04-18T08:00:00Z'),
        completedAt: at('2026-04-19T09:00:00Z'),
        timeOfDay: '08:00',
        timeZone: UTC,
      }),
    ).toBe(0.5)
  })

  it('uses user timezone to determine "same local day"', () => {
    // Due 23:00 Chicago local on 2026-04-18 (CDT UTC-5) = 2026-04-19T04:00Z
    // Completed 02:00 Chicago local on 2026-04-19 = 2026-04-19T07:00Z
    // That's 3 hours late, but crosses the local midnight → 0.5
    expect(
      punctualityMultiplier({
        dueAt: at('2026-04-19T04:00:00Z'),
        completedAt: at('2026-04-19T07:00:00Z'),
        timeOfDay: '23:00',
        timeZone: 'America/Chicago',
      }),
    ).toBe(0.5)
  })
})

describe('weekTargetMultiplier', () => {
  // Friday target at 09:00 local for these cases.
  const target = at('2026-05-08T13:00:00Z') // Fri 9am Chicago

  it('is 1.0 when completed on the target day', () => {
    expect(
      weekTargetMultiplier({
        dueAt: target,
        completedAt: at('2026-05-08T18:00:00Z'),
        timeZone: 'America/Chicago',
      }),
    ).toBe(1.0)
  })

  it('is 1.10x one day early', () => {
    expect(
      weekTargetMultiplier({
        dueAt: target,
        completedAt: at('2026-05-07T18:00:00Z'), // Thu
        timeZone: 'America/Chicago',
      }),
    ).toBe(1.1)
  })

  it('is 1.20x two days early', () => {
    expect(
      weekTargetMultiplier({
        dueAt: target,
        completedAt: at('2026-05-06T18:00:00Z'), // Wed
        timeZone: 'America/Chicago',
      }),
    ).toBe(1.2)
  })

  it('caps the early bonus at 1.25x for 3+ days early', () => {
    expect(
      weekTargetMultiplier({
        dueAt: target,
        completedAt: at('2026-05-05T18:00:00Z'), // Tue (-3)
        timeZone: 'America/Chicago',
      }),
    ).toBe(1.25)
    expect(
      weekTargetMultiplier({
        dueAt: target,
        completedAt: at('2026-05-04T18:00:00Z'), // Mon (-4)
        timeZone: 'America/Chicago',
      }),
    ).toBe(1.25)
  })

  it('is 0.95x one day late', () => {
    expect(
      weekTargetMultiplier({
        dueAt: target,
        completedAt: at('2026-05-09T15:00:00Z'), // Sat
        timeZone: 'America/Chicago',
      }),
    ).toBe(0.95)
  })

  it('is 0.85x two days late', () => {
    expect(
      weekTargetMultiplier({
        dueAt: target,
        completedAt: at('2026-05-10T15:00:00Z'), // Sun
        timeZone: 'America/Chicago',
      }),
    ).toBe(0.85)
  })

  it('drops to 0.5x after the surrounding week (3+ days late)', () => {
    expect(
      weekTargetMultiplier({
        dueAt: target,
        completedAt: at('2026-05-11T15:00:00Z'), // Mon (+3)
        timeZone: 'America/Chicago',
      }),
    ).toBe(0.5)
    expect(
      weekTargetMultiplier({
        dueAt: target,
        completedAt: at('2026-05-15T15:00:00Z'), // Fri (+7)
        timeZone: 'America/Chicago',
      }),
    ).toBe(0.5)
  })

  it('returns 1.0 when dueAt is null (defensive)', () => {
    expect(
      weekTargetMultiplier({
        dueAt: null,
        completedAt: at('2026-05-08T18:00:00Z'),
        timeZone: 'UTC',
      }),
    ).toBe(1.0)
  })
})

describe('applyEvent picks weekTargetMultiplier when dueKind is week_target', () => {
  it('applies the soft curve, not the strict timed curve, regardless of timeOfDay', () => {
    // No streak, no override → base = 25 (medium). Completed 1 day early
    // → 1.10x → 28 (rounded).
    const dueAt = at('2026-05-08T13:00:00Z') // Fri
    const completedAt = at('2026-05-07T18:00:00Z') // Thu
    const next = applyEvent(
      INITIAL_PROGRESSION,
      {
        type: 'task.completed',
        taskId: 't',
        instanceId: 'i',
        difficulty: 'medium',
        xpOverride: null,
        dueAt,
        timeOfDay: null,
        dueKind: 'week_target',
        occurredAt: completedAt,
      },
      { timeZone: 'America/Chicago' },
    )
    expect(next.xp).toBe(28)
  })
})

describe('isNewDay', () => {
  it('returns true when previous is null', () => {
    expect(isNewDay(null, at('2026-04-18T00:00:00Z'), UTC)).toBe(true)
  })

  it('returns false within the same UTC day', () => {
    expect(
      isNewDay(at('2026-04-18T01:00:00Z'), at('2026-04-18T22:00:00Z'), UTC),
    ).toBe(false)
  })

  it('respects timezone when deciding day boundaries', () => {
    const prev = at('2026-04-18T04:00:00Z')
    const curr = at('2026-04-18T06:00:00Z')
    expect(isNewDay(prev, curr, 'America/Chicago')).toBe(true)
    expect(isNewDay(prev, curr, UTC)).toBe(false)
  })
})

describe('applyEvent', () => {
  it('completing a medium full-day task from zero adds streak-1 XP', () => {
    const result = applyEvent(INITIAL_PROGRESSION, completed('2026-04-18T12:00:00Z'), {
      timeZone: UTC,
    })
    expect(result.currentStreak).toBe(1)
    // base 25 * (1 + 1*0.02) * 1.0 = 25.5 → round → 26
    expect(result.xp).toBe(26)
    expect(result.level).toBe(1)
    expect(result.longestStreak).toBe(1)
    expect(result.lastCompletionAt).toEqual(at('2026-04-18T12:00:00Z'))
  })

  it('late time-of-day completion earns less XP than on-time', () => {
    const onTime = applyEvent(
      INITIAL_PROGRESSION,
      completed('2026-04-18T08:00:00Z', {
        dueAt: at('2026-04-18T08:00:00Z'),
        timeOfDay: '08:00',
      }),
      { timeZone: UTC },
    )
    const sameDayLate = applyEvent(
      INITIAL_PROGRESSION,
      completed('2026-04-18T20:00:00Z', {
        dueAt: at('2026-04-18T08:00:00Z'),
        timeOfDay: '08:00',
      }),
      { timeZone: UTC },
    )
    const nextDay = applyEvent(
      INITIAL_PROGRESSION,
      completed('2026-04-19T09:00:00Z', {
        dueAt: at('2026-04-18T08:00:00Z'),
        timeOfDay: '08:00',
      }),
      { timeZone: UTC },
    )
    expect(onTime.xp).toBeGreaterThan(sameDayLate.xp)
    expect(sameDayLate.xp).toBeGreaterThan(nextDay.xp)
  })

  it('consecutive days increment streak', () => {
    let state = applyEvent(INITIAL_PROGRESSION, completed('2026-04-18T12:00:00Z'), {
      timeZone: UTC,
    })
    state = applyEvent(state, completed('2026-04-19T09:00:00Z'), { timeZone: UTC })
    expect(state.currentStreak).toBe(2)
    expect(state.longestStreak).toBe(2)
  })

  it('two completions on same day do not advance streak', () => {
    let state = applyEvent(INITIAL_PROGRESSION, completed('2026-04-18T09:00:00Z'), {
      timeZone: UTC,
    })
    const before = state.currentStreak
    state = applyEvent(state, completed('2026-04-18T22:00:00Z'), { timeZone: UTC })
    expect(state.currentStreak).toBe(before)
  })

  it('gap > 1 day resets streak to 1', () => {
    let state = applyEvent(INITIAL_PROGRESSION, completed('2026-04-18T12:00:00Z'), {
      timeZone: UTC,
    })
    state = applyEvent(state, completed('2026-04-19T12:00:00Z'), { timeZone: UTC })
    expect(state.currentStreak).toBe(2)
    state = applyEvent(state, completed('2026-04-21T12:00:00Z'), { timeZone: UTC })
    expect(state.currentStreak).toBe(1)
    expect(state.longestStreak).toBe(2)
  })

  it('skipped events do not change state', () => {
    const skipped: DomainEvent = {
      type: 'task.skipped',
      taskId: 't',
      instanceId: 'i',
      occurredAt: at('2026-04-18T12:00:00Z'),
    }
    expect(applyEvent(INITIAL_PROGRESSION, skipped, { timeZone: UTC })).toEqual(
      INITIAL_PROGRESSION,
    )
  })
})

describe('replay', () => {
  it('produces the same state as incremental application', () => {
    const events: DomainEvent[] = [
      completed('2026-04-18T12:00:00Z', { difficulty: 'small' }),
      completed('2026-04-19T12:00:00Z', { difficulty: 'large' }),
      completed('2026-04-20T12:00:00Z'),
    ]
    const fromReplay = replay(events, { timeZone: UTC })
    const fromSteps = events.reduce(
      (s, e) => applyEvent(s, e, { timeZone: UTC }),
      INITIAL_PROGRESSION,
    )
    expect(fromReplay).toEqual(fromSteps)
  })
})
