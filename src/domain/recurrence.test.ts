import { describe, expect, it } from 'vitest'
import {
  computeNextDue,
  expectedCompletionsPerWeek,
  firstDueAt,
} from './recurrence'
import { formatInTimeZone } from 'date-fns-tz'

const at = (iso: string) => new Date(iso)
const formatLocal = (d: Date | null, tz: string) => {
  if (!d) throw new Error('expected non-null date')
  return formatInTimeZone(d, tz, 'yyyy-MM-dd HH:mm')
}

describe('computeNextDue', () => {
  describe('daily', () => {
    it('advances by one day', () => {
      const next = computeNextDue({
        recurrence: { type: 'daily' },
        previousDueAt: at('2026-04-18T09:00:00Z'),
        completedAt: at('2026-04-18T12:00:00Z'),
      })
      expect(next.toISOString()).toBe('2026-04-19T09:00:00.000Z')
    })
  })

  describe('weekly', () => {
    it('picks the next selected day within the same week', () => {
      // previous due is a Monday (2026-04-20, UTC day=1)
      // select Wednesday (3) and Friday (5)
      const next = computeNextDue({
        recurrence: { type: 'weekly', daysOfWeek: [3, 5] },
        previousDueAt: at('2026-04-20T09:00:00Z'),
        completedAt: at('2026-04-20T10:00:00Z'),
      })
      expect(next.toISOString()).toBe('2026-04-22T09:00:00.000Z')
    })

    it('wraps into the following week when needed', () => {
      // Saturday (2026-04-25 UTC day=6) → next selected is Monday (1)
      const next = computeNextDue({
        recurrence: { type: 'weekly', daysOfWeek: [1] },
        previousDueAt: at('2026-04-25T09:00:00Z'),
        completedAt: at('2026-04-25T10:00:00Z'),
      })
      expect(next.toISOString()).toBe('2026-04-27T09:00:00.000Z')
    })

    it('throws on empty daysOfWeek', () => {
      expect(() =>
        computeNextDue({
          recurrence: { type: 'weekly', daysOfWeek: [] },
          previousDueAt: at('2026-04-20T09:00:00Z'),
          completedAt: at('2026-04-20T10:00:00Z'),
        }),
      ).toThrow()
    })
  })

  describe('interval', () => {
    it('advances by N days from the previous due date when on time', () => {
      const next = computeNextDue({
        recurrence: { type: 'interval', days: 3 },
        previousDueAt: at('2026-04-18T09:00:00Z'),
        completedAt: at('2026-04-18T10:00:00Z'),
      })
      expect(next.toISOString()).toBe('2026-04-21T09:00:00.000Z')
    })

    it('walks forward in N-day steps when the user completes late', () => {
      // previous + 3 days = Apr 21, but completedAt is Apr 22 — the
      // next due must land after the completion, so step to Apr 24.
      const next = computeNextDue({
        recurrence: { type: 'interval', days: 3 },
        previousDueAt: at('2026-04-18T09:00:00Z'),
        completedAt: at('2026-04-22T10:00:00Z'),
      })
      expect(next.toISOString()).toBe('2026-04-24T09:00:00.000Z')
    })
  })

  describe('after_completion', () => {
    it('schedules N days after the completion time, not the previous due', () => {
      const next = computeNextDue({
        recurrence: { type: 'after_completion', days: 14 },
        previousDueAt: at('2026-04-18T09:00:00Z'),
        completedAt: at('2026-04-22T10:00:00Z'),
      })
      expect(next.toISOString()).toBe('2026-05-06T10:00:00.000Z')
    })
  })

  describe('monthly_day', () => {
    it('advances to the same day-of-month next month', () => {
      const next = computeNextDue({
        recurrence: { type: 'monthly_day', dayOfMonth: 15 },
        previousDueAt: at('2026-04-15T09:00:00Z'),
        completedAt: at('2026-04-15T10:00:00Z'),
      })
      expect(next.toISOString()).toBe('2026-05-15T09:00:00.000Z')
    })

    it('clamps day to the last day of a shorter month', () => {
      // Previous due is Jan 31; next monthly_day=31 should fall on Feb 28
      // (2026 is not a leap year).
      const next = computeNextDue({
        recurrence: { type: 'monthly_day', dayOfMonth: 31 },
        previousDueAt: at('2026-01-31T09:00:00Z'),
        completedAt: at('2026-01-31T10:00:00Z'),
      })
      expect(next.toISOString()).toBe('2026-02-28T09:00:00.000Z')
    })

    it('rolls into the next year from December', () => {
      const next = computeNextDue({
        recurrence: { type: 'monthly_day', dayOfMonth: 1 },
        previousDueAt: at('2026-12-01T09:00:00Z'),
        completedAt: at('2026-12-01T09:00:00Z'),
      })
      expect(next.toISOString()).toBe('2027-01-01T09:00:00.000Z')
    })

    it('honors timezone-pinned local clock time', () => {
      // 2026-05-01 13:00 UTC = 08:00 America/Chicago (CDT, UTC-5).
      // Next month at 08:00 local = Jun 1 at 13:00 UTC.
      const next = computeNextDue({
        recurrence: { type: 'monthly_day', dayOfMonth: 1 },
        previousDueAt: at('2026-05-01T13:00:00Z'),
        completedAt: at('2026-05-01T13:00:00Z'),
        timeOfDay: '08:00',
        timeZone: 'America/Chicago',
      })
      expect(formatLocal(next, 'America/Chicago')).toBe('2026-06-01 08:00')
    })
  })

  describe('monthly_weekday', () => {
    it('returns the first Tuesday of the next month', () => {
      // Previous due 2026-05-05 (1st Tuesday of May). Next firing should be
      // the first Tuesday of June, which is 2026-06-02.
      const next = computeNextDue({
        recurrence: { type: 'monthly_weekday', week: 1, dayOfWeek: 2 },
        previousDueAt: at('2026-05-05T13:00:00Z'),
        completedAt: at('2026-05-05T13:00:00Z'),
      })
      expect(next.toISOString().slice(0, 10)).toBe('2026-06-02')
    })

    it('returns the last Friday of the next month', () => {
      // Previous due 2026-05-29 (last Friday of May). Next is last Friday
      // of June, which is 2026-06-26.
      const next = computeNextDue({
        recurrence: { type: 'monthly_weekday', week: -1, dayOfWeek: 5 },
        previousDueAt: at('2026-05-29T13:00:00Z'),
        completedAt: at('2026-05-29T13:00:00Z'),
      })
      expect(next.toISOString().slice(0, 10)).toBe('2026-06-26')
    })

    it('honors timezone-pinned local clock time', () => {
      // First Monday of June 2026 is 2026-06-01. At 09:00 America/New_York
      // (EDT = UTC-4) = 13:00 UTC.
      const next = computeNextDue({
        recurrence: { type: 'monthly_weekday', week: 1, dayOfWeek: 1 },
        previousDueAt: at('2026-05-04T13:00:00Z'),
        completedAt: at('2026-05-04T13:00:00Z'),
        timeOfDay: '09:00',
        timeZone: 'America/New_York',
      })
      expect(formatLocal(next, 'America/New_York')).toBe('2026-06-01 09:00')
    })
  })

  describe('catch-up: nextDue is always after completedAt', () => {
    it('daily: previousDueAt 7 days stale → walks forward to next future 19:00', () => {
      // Real prod scenario: user has a daily 19:00 task. previous instance
      // dueAt was a week ago; they finally check it off today after 19:00.
      // One step (the old behavior) would land on yesterday and the new
      // instance would reappear in today's list with no snooze. Catch-up
      // must walk forward until the result is after completedAt.
      const next = computeNextDue({
        recurrence: { type: 'daily' },
        previousDueAt: at('2026-05-06T23:00:00Z'), // 19:00 EDT
        completedAt: at('2026-05-13T23:27:00Z'), // 19:27 EDT
        timeOfDay: '19:00',
        timeZone: 'America/New_York',
      })
      expect(formatLocal(next, 'America/New_York')).toBe('2026-05-14 19:00')
    })

    it('daily without timeOfDay: stale previousDueAt also catches up', () => {
      const next = computeNextDue({
        recurrence: { type: 'daily' },
        previousDueAt: at('2026-05-06T09:00:00Z'),
        completedAt: at('2026-05-13T09:30:00Z'),
      })
      expect(next > at('2026-05-13T09:30:00Z')).toBe(true)
      expect(next.toISOString()).toBe('2026-05-14T09:00:00.000Z')
    })

    it('interval days: stale previous catches up by N-day steps', () => {
      // 3-day interval, last due 30 days ago — should land on the first
      // 3-day boundary after completedAt.
      const next = computeNextDue({
        recurrence: { type: 'interval', amount: 3, unit: 'days' },
        previousDueAt: at('2026-04-01T09:00:00Z'),
        completedAt: at('2026-05-13T09:30:00Z'),
      })
      expect(next > at('2026-05-13T09:30:00Z')).toBe(true)
      // 2026-04-01 + 3*15 = 2026-05-16
      expect(next.toISOString()).toBe('2026-05-16T09:00:00.000Z')
    })

    it('weekly: stale previous catches up to next matching weekday', () => {
      // Mondays-only, last due 3 weeks ago.
      const next = computeNextDue({
        recurrence: { type: 'weekly', daysOfWeek: [1] },
        previousDueAt: at('2026-04-20T09:00:00Z'), // a Monday
        completedAt: at('2026-05-13T09:30:00Z'), // a Wednesday
        timeOfDay: '09:00',
        timeZone: 'UTC',
      })
      expect(next > at('2026-05-13T09:30:00Z')).toBe(true)
      // Next Monday after May 13 = May 18
      expect(formatLocal(next, 'UTC')).toBe('2026-05-18 09:00')
    })

    it('after_completion stays anchored on completedAt even if "stale"', () => {
      // after_completion is already anchored on completedAt; catch-up
      // shouldn't shift it forward.
      const next = computeNextDue({
        recurrence: { type: 'after_completion', amount: 7, unit: 'days' },
        previousDueAt: at('2026-01-01T09:00:00Z'),
        completedAt: at('2026-05-13T09:30:00Z'),
      })
      expect(next.toISOString()).toBe('2026-05-20T09:30:00.000Z')
    })
  })

  describe('timezone-pinned daily across DST', () => {
    it('stays at 08:00 Chicago local on the day US spring-forward shifts UTC offset', () => {
      // 2026 US DST begins Sun 2026-03-08 at 02:00 local
      // Saturday 2026-03-07 at 08:00 CST (UTC-6) = 14:00 UTC
      // Sunday   2026-03-08 at 08:00 CDT (UTC-5) = 13:00 UTC
      const next = computeNextDue({
        recurrence: { type: 'daily' },
        previousDueAt: at('2026-03-07T14:00:00Z'),
        completedAt: at('2026-03-07T14:00:00Z'),
        timeOfDay: '08:00',
        timeZone: 'America/Chicago',
      })
      expect(formatLocal(next, 'America/Chicago')).toBe('2026-03-08 08:00')
      expect(next.toISOString()).toBe('2026-03-08T13:00:00.000Z')
    })
  })

  describe('anytime daily (no pinned timeOfDay) re-anchors to morning', () => {
    it('with a timezone but no quiet hours → next local start-of-day', () => {
      // Created/completed mid-afternoon Chicago time. Old behavior carried the
      // 14:15 local time forward; new behavior surfaces it at local midnight
      // the next day so it's available all day.
      const next = computeNextDue({
        recurrence: { type: 'daily' },
        previousDueAt: at('2026-04-18T19:15:00Z'), // 14:15 CDT
        completedAt: at('2026-04-18T20:00:00Z'),
        timeOfDay: null,
        timeZone: 'America/Chicago',
      })
      expect(formatLocal(next, 'America/Chicago')).toBe('2026-04-19 00:00')
    })

    it('with quiet hours → next morning at quiet-hours end', () => {
      const next = computeNextDue({
        recurrence: { type: 'daily' },
        previousDueAt: at('2026-04-18T19:15:00Z'), // 14:15 CDT
        completedAt: at('2026-04-18T20:00:00Z'),
        timeOfDay: null,
        timeZone: 'America/Chicago',
        quietHoursEnd: '07:00',
      })
      expect(formatLocal(next, 'America/Chicago')).toBe('2026-04-19 07:00')
    })

    it('catches up past a stale anytime instance, still landing in the morning', () => {
      const next = computeNextDue({
        recurrence: { type: 'daily' },
        previousDueAt: at('2026-04-10T19:15:00Z'),
        completedAt: at('2026-04-18T20:00:00Z'),
        timeOfDay: null,
        timeZone: 'America/Chicago',
        quietHoursEnd: '07:00',
      })
      expect(next > at('2026-04-18T20:00:00Z')).toBe(true)
      expect(formatLocal(next, 'America/Chicago')).toBe('2026-04-19 07:00')
    })

    it('falls back to a raw +1 day when no timezone is provided', () => {
      const next = computeNextDue({
        recurrence: { type: 'daily' },
        previousDueAt: at('2026-04-18T09:00:00Z'),
        completedAt: at('2026-04-18T12:00:00Z'),
        timeOfDay: null,
      })
      expect(next.toISOString()).toBe('2026-04-19T09:00:00.000Z')
    })

    it('ignores a malformed quietHoursEnd and uses start-of-day', () => {
      const next = computeNextDue({
        recurrence: { type: 'daily' },
        previousDueAt: at('2026-04-18T19:15:00Z'),
        completedAt: at('2026-04-18T20:00:00Z'),
        timeOfDay: null,
        timeZone: 'America/Chicago',
        quietHoursEnd: 'not-a-time',
      })
      expect(formatLocal(next, 'America/Chicago')).toBe('2026-04-19 00:00')
    })
  })

  describe('timezone-pinned weekly', () => {
    it('finds next selected local day-of-week at HH:MM', () => {
      // previousDueAt: Wed 2026-04-22 08:00 America/Chicago (CDT = UTC-5) = 13:00Z
      // daysOfWeek: [1=Mon, 3=Wed, 5=Fri] → next is Fri 2026-04-24 08:00 local = 13:00Z
      const next = computeNextDue({
        recurrence: { type: 'weekly', daysOfWeek: [1, 3, 5] },
        previousDueAt: at('2026-04-22T13:00:00Z'),
        completedAt: at('2026-04-22T13:00:00Z'),
        timeOfDay: '08:00',
        timeZone: 'America/Chicago',
      })
      expect(formatLocal(next, 'America/Chicago')).toBe('2026-04-24 08:00')
    })
  })
})

describe('firstDueAt', () => {
  it('returns null when someday is true', () => {
    const result = firstDueAt({
      now: at('2026-04-18T15:00:00Z'),
      recurrence: null,
      timeOfDay: '08:00',
      timeZone: 'UTC',
      someday: true,
    })
    expect(result).toBeNull()
  })

  it('returns now when no timeOfDay set', () => {
    const now = at('2026-04-18T15:00:00Z')
    const result = firstDueAt({
      now,
      recurrence: null,
      timeOfDay: null,
      timeZone: 'UTC',
    })
    expect(result).toEqual(now)
  })

  it('picks today at HH:MM local if still in the future', () => {
    // now = 2026-04-18T10:00Z = 05:00 CDT → 08:00 CDT is later today
    const result = firstDueAt({
      now: at('2026-04-18T10:00:00Z'),
      recurrence: null,
      timeOfDay: '08:00',
      timeZone: 'America/Chicago',
    })
    expect(formatLocal(result, 'America/Chicago')).toBe('2026-04-18 08:00')
  })

  it('one-off past-time today fires immediately (overdue, not rolled to tomorrow)', () => {
    // now = 2026-04-18T16:00Z = 11:00 CDT → 08:00 already past today.
    // For a non-recurring task this is a reminder the user wants soon,
    // not next day — surface it as overdue at 08:00 today.
    const result = firstDueAt({
      now: at('2026-04-18T16:00:00Z'),
      recurrence: null,
      timeOfDay: '08:00',
      timeZone: 'America/Chicago',
    })
    expect(formatLocal(result, 'America/Chicago')).toBe('2026-04-18 08:00')
  })

  it('recurring daily past-time today still rolls to tomorrow', () => {
    // Same setup but with a daily recurrence — the next occurrence is
    // tomorrow 08:00, which is what we want so the task doesn't
    // perpetually show as overdue for its ongoing schedule.
    const result = firstDueAt({
      now: at('2026-04-18T16:00:00Z'),
      recurrence: { type: 'daily' },
      timeOfDay: '08:00',
      timeZone: 'America/Chicago',
    })
    expect(formatLocal(result, 'America/Chicago')).toBe('2026-04-19 08:00')
  })

  it('for weekly recurrence picks the next selected local day-of-week', () => {
    // now = Saturday 2026-04-18 10:00 UTC
    // daysOfWeek = [1=Mon, 3=Wed] → next Mon = 2026-04-20
    const result = firstDueAt({
      now: at('2026-04-18T10:00:00Z'),
      recurrence: { type: 'weekly', daysOfWeek: [1, 3] },
      timeOfDay: '08:00',
      timeZone: 'America/Chicago',
    })
    expect(formatLocal(result, 'America/Chicago')).toBe('2026-04-20 08:00')
  })

  it('monthly_day picks the same-month occurrence if still in the future', () => {
    // now = 2026-05-10 10:00 UTC = 05:00 CDT. dayOfMonth=15 still ahead.
    const result = firstDueAt({
      now: at('2026-05-10T10:00:00Z'),
      recurrence: { type: 'monthly_day', dayOfMonth: 15 },
      timeOfDay: '08:00',
      timeZone: 'America/Chicago',
    })
    expect(formatLocal(result, 'America/Chicago')).toBe('2026-05-15 08:00')
  })

  it('monthly_day rolls to next month if this month already passed', () => {
    // now = May 16 already past the 15th
    const result = firstDueAt({
      now: at('2026-05-16T15:00:00Z'),
      recurrence: { type: 'monthly_day', dayOfMonth: 15 },
      timeOfDay: '08:00',
      timeZone: 'America/Chicago',
    })
    expect(formatLocal(result, 'America/Chicago')).toBe('2026-06-15 08:00')
  })

  it('monthly_weekday picks the next Nth weekday occurrence', () => {
    // now = 2026-05-04 10:00 UTC = 05:00 CDT (a Monday).
    // First Tuesday of May 2026 is May 5 — still upcoming.
    const result = firstDueAt({
      now: at('2026-05-04T10:00:00Z'),
      recurrence: { type: 'monthly_weekday', week: 1, dayOfWeek: 2 },
      timeOfDay: '08:00',
      timeZone: 'America/Chicago',
    })
    expect(formatLocal(result, 'America/Chicago')).toBe('2026-05-05 08:00')
  })
})

describe('expectedCompletionsPerWeek', () => {
  it('daily is 7', () => {
    expect(expectedCompletionsPerWeek({ type: 'daily' })).toBe(7)
  })

  it('weekly counts the selected days', () => {
    expect(
      expectedCompletionsPerWeek({ type: 'weekly', daysOfWeek: [1, 3] }),
    ).toBe(2)
  })

  it('weekly with no days is null', () => {
    expect(
      expectedCompletionsPerWeek({ type: 'weekly', daysOfWeek: [] }),
    ).toBeNull()
  })

  it('day interval scales by amount', () => {
    expect(
      expectedCompletionsPerWeek({ type: 'interval', amount: 2, unit: 'days' }),
    ).toBe(3.5)
  })

  it('hour interval scales by amount', () => {
    expect(
      expectedCompletionsPerWeek({ type: 'interval', amount: 12, unit: 'hours' }),
    ).toBe(14)
  })

  it('legacy interval days shape is honored', () => {
    expect(expectedCompletionsPerWeek({ type: 'interval', days: 7 })).toBe(1)
  })

  it('monthly is ~0.23/wk', () => {
    expect(expectedCompletionsPerWeek({ type: 'monthly_day', dayOfMonth: 1 })).toBeCloseTo(
      12 / 52,
    )
    expect(
      expectedCompletionsPerWeek({ type: 'monthly_weekday', week: 1, dayOfWeek: 2 }),
    ).toBeCloseTo(12 / 52)
  })

  it('after_completion has no fixed cadence', () => {
    expect(
      expectedCompletionsPerWeek({ type: 'after_completion', amount: 3, unit: 'days' }),
    ).toBeNull()
  })
})

describe('per-weekday times (daily)', () => {
  // Base 06:00 weekdays, 08:00 on Sat (6) and Sun (0), America/Chicago.
  const weekendMap = { '0': '08:00', '6': '08:00' }
  const tz = 'America/Chicago'

  it('computeNextDue: Fri 06:00 → Sat 08:00', () => {
    // 2026-04-17 11:00Z = Fri 06:00 CDT
    const next = computeNextDue({
      recurrence: { type: 'daily' },
      previousDueAt: at('2026-04-17T11:00:00Z'),
      completedAt: at('2026-04-17T12:00:00Z'),
      timeOfDay: '06:00',
      timeByWeekday: weekendMap,
      timeZone: tz,
    })
    expect(formatLocal(next, tz)).toBe('2026-04-18 08:00')
  })

  it('computeNextDue: Sun 08:00 → Mon 06:00', () => {
    // 2026-04-19 13:00Z = Sun 08:00 CDT
    const next = computeNextDue({
      recurrence: { type: 'daily' },
      previousDueAt: at('2026-04-19T13:00:00Z'),
      completedAt: at('2026-04-19T14:00:00Z'),
      timeOfDay: '06:00',
      timeByWeekday: weekendMap,
      timeZone: tz,
    })
    expect(formatLocal(next, tz)).toBe('2026-04-20 06:00')
  })

  it('firstDueAt: Friday afternoon → next morning is Sat 08:00', () => {
    // 2026-04-17 20:00Z = Fri 15:00 CDT (past today's 06:00)
    const due = firstDueAt({
      now: at('2026-04-17T20:00:00Z'),
      recurrence: { type: 'daily' },
      timeOfDay: '06:00',
      timeByWeekday: weekendMap,
      timeZone: tz,
    })
    expect(formatLocal(due, tz)).toBe('2026-04-18 08:00')
  })

  it('firstDueAt: weekday before the time → same day at weekday time', () => {
    // 2026-04-17 10:00Z = Fri 05:00 CDT (before today's 06:00)
    const due = firstDueAt({
      now: at('2026-04-17T10:00:00Z'),
      recurrence: { type: 'daily' },
      timeOfDay: '06:00',
      timeByWeekday: weekendMap,
      timeZone: tz,
    })
    expect(formatLocal(due, tz)).toBe('2026-04-17 06:00')
  })

  it('no map → identical to plain daily (Fri 06:00 → Sat 06:00)', () => {
    const next = computeNextDue({
      recurrence: { type: 'daily' },
      previousDueAt: at('2026-04-17T11:00:00Z'),
      completedAt: at('2026-04-17T12:00:00Z'),
      timeOfDay: '06:00',
      timeByWeekday: null,
      timeZone: tz,
    })
    expect(formatLocal(next, tz)).toBe('2026-04-18 06:00')
  })
})
