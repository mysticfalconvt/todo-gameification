import { describe, expect, it } from 'vitest'
import { describeRepeat, joinLocal, splitLocal } from './VoiceReviewSheet'

describe('describeRepeat', () => {
  it('returns null for a one-off task', () => {
    expect(describeRepeat(null)).toBeNull()
  })

  it('describes each recurrence shape', () => {
    expect(describeRepeat({ type: 'daily' })).toBe('Every day')
    expect(describeRepeat({ type: 'monthly_day', dayOfMonth: 15 })).toBe('Monthly on the 15th')
    expect(describeRepeat({ type: 'monthly_day', dayOfMonth: 1 })).toBe('Monthly on the 1st')
    expect(describeRepeat({ type: 'monthly_day', dayOfMonth: 22 })).toBe('Monthly on the 22nd')
    expect(describeRepeat({ type: 'monthly_day', dayOfMonth: 3 })).toBe('Monthly on the 3rd')
    expect(describeRepeat({ type: 'monthly_weekday', week: 1, dayOfWeek: 1 })).toBe(
      'Monthly — 1st Monday',
    )
    expect(describeRepeat({ type: 'monthly_weekday', week: -1, dayOfWeek: 5 })).toBe(
      'Monthly — last Friday',
    )
  })

  it('singularises a duration of one', () => {
    expect(describeRepeat({ type: 'interval', amount: 1, unit: 'days' })).toBe('Every 1 day')
    expect(describeRepeat({ type: 'interval', amount: 14, unit: 'days' })).toBe('Every 14 days')
    expect(describeRepeat({ type: 'after_completion', amount: 1, unit: 'hours' })).toBe(
      '1 hour after done',
    )
  })

  it('handles the 11/12/13 ordinal exceptions', () => {
    expect(describeRepeat({ type: 'monthly_day', dayOfMonth: 11 })).toBe('Monthly on the 11th')
    expect(describeRepeat({ type: 'monthly_day', dayOfMonth: 12 })).toBe('Monthly on the 12th')
    expect(describeRepeat({ type: 'monthly_day', dayOfMonth: 13 })).toBe('Monthly on the 13th')
  })
})

describe('splitLocal / joinLocal', () => {
  it('round-trips an instant through the two inputs', () => {
    // Timezone-independent: whatever the runner's zone, split then join
    // must land back on the same instant.
    const iso = '2026-10-13T16:00:00.000Z'
    const { date, time } = splitLocal(iso)
    expect(date).toMatch(/^\d{4}-\d{2}-\d{2}$/)
    expect(time).toMatch(/^\d{2}:\d{2}$/)
    expect(joinLocal(date, time)).toBe(iso)
  })

  it('treats a blank time as end of the local day', () => {
    const joined = joinLocal('2026-10-13', '')
    expect(joined).not.toBeNull()
    expect(splitLocal(joined).time).toBe('23:59')
    expect(splitLocal(joined).date).toBe('2026-10-13')
  })

  it('returns empty strings for no instant', () => {
    expect(splitLocal(null)).toEqual({ date: '', time: '' })
    expect(splitLocal('not a date')).toEqual({ date: '', time: '' })
  })

  it('returns null when there is no date', () => {
    expect(joinLocal('', '09:00')).toBeNull()
    expect(joinLocal('nonsense', '09:00')).toBeNull()
  })
})
