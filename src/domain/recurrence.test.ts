import { describe, expect, it } from 'vitest'
import { computeNextDue, firstDueAt } from './recurrence'
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
    it('advances strictly by N days from the previous due date', () => {
      const next = computeNextDue({
        recurrence: { type: 'interval', days: 3 },
        previousDueAt: at('2026-04-18T09:00:00Z'),
        completedAt: at('2026-04-22T10:00:00Z'), // late completion should not matter
      })
      expect(next.toISOString()).toBe('2026-04-21T09:00:00.000Z')
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
})
