import { formatInTimeZone } from 'date-fns-tz'
import { describe, expect, it } from 'vitest'
import { partForTimeOfDay, TIMED_DAY_PARTS } from './dayParts'
import { DAY_PART_TIME, resolveVoiceWhen, type VoiceWhen } from './voiceWhen'

const NY = 'America/New_York'
const at = (iso: string) => new Date(iso)

// 2026-10-08 is a Thursday; 2026-10-06 and 2026-10-13 are Tuesdays.
const THURSDAY_9AM = at('2026-10-08T13:00:00Z') // 09:00 EDT
const TUESDAY_9AM = at('2026-10-06T13:00:00Z') // 09:00 EDT
const TUESDAY_6PM = at('2026-10-06T22:00:00Z') // 18:00 EDT

const localOf = (r: { dueAtOverride: string | null }, tz = NY) => {
  if (!r.dueAtOverride) throw new Error('expected a due instant')
  return formatInTimeZone(new Date(r.dueAtOverride), tz, 'yyyy-MM-dd HH:mm')
}

describe('resolveVoiceWhen', () => {
  describe('day parts agree with the /today buckets', () => {
    it.each(TIMED_DAY_PARTS)('%s round-trips through partForTimeOfDay', (part) => {
      expect(partForTimeOfDay(DAY_PART_TIME[part as 'morning'])).toBe(part)
    })
  })

  describe('next_weekday', () => {
    it('resolves "Tuesday afternoon" to the coming Tuesday at noon', () => {
      // The motivating example: spoken on a Thursday.
      const r = resolveVoiceWhen(
        { kind: 'next_weekday', weekday: 2, part: 'afternoon' },
        THURSDAY_9AM,
        NY,
      )
      expect(localOf(r)).toBe('2026-10-13 12:00')
      expect(r.timeOfDay).toBe('12:00')
    })

    it('keeps today when today is that weekday and the time is still ahead', () => {
      const r = resolveVoiceWhen(
        { kind: 'next_weekday', weekday: 2, part: 'afternoon' },
        TUESDAY_9AM,
        NY,
      )
      expect(localOf(r)).toBe('2026-10-06 12:00')
    })

    it('rolls to next week when today is that weekday but the time has passed', () => {
      const r = resolveVoiceWhen(
        { kind: 'next_weekday', weekday: 2, part: 'afternoon' },
        TUESDAY_6PM,
        NY,
      )
      expect(localOf(r)).toBe('2026-10-13 12:00')
    })

    it('treats a bare weekday as due by end of that day', () => {
      const r = resolveVoiceWhen({ kind: 'next_weekday', weekday: 2 }, THURSDAY_9AM, NY)
      expect(localOf(r)).toBe('2026-10-13 23:59')
      expect(r.timeOfDay).toBeNull()
    })

    it('honours an explicit time over the day part', () => {
      const r = resolveVoiceWhen(
        { kind: 'next_weekday', weekday: 2, part: 'morning', time: '15:30' },
        THURSDAY_9AM,
        NY,
      )
      expect(localOf(r)).toBe('2026-10-13 15:30')
      expect(r.timeOfDay).toBe('15:30')
    })
  })

  describe('day_offset', () => {
    it('resolves tomorrow morning', () => {
      const r = resolveVoiceWhen(
        { kind: 'day_offset', offset: 1, part: 'morning' },
        THURSDAY_9AM,
        NY,
      )
      expect(localOf(r)).toBe('2026-10-09 09:00')
    })

    it('resolves "tonight" spoken at 11pm to the same local day', () => {
      // 23:00 EDT on the 8th — still the 8th locally, though already the
      // 9th in UTC. The naive UTC-date approach gets this wrong.
      const lateNight = at('2026-10-09T03:00:00Z')
      const r = resolveVoiceWhen({ kind: 'day_offset', offset: 0, part: 'night' }, lateNight, NY)
      expect(localOf(r)).toBe('2026-10-08 22:00')
    })

    it('resolves today with no time to end of the local day', () => {
      const r = resolveVoiceWhen({ kind: 'day_offset', offset: 0 }, THURSDAY_9AM, NY)
      expect(localOf(r)).toBe('2026-10-08 23:59')
      expect(r.timeOfDay).toBeNull()
    })
  })

  describe('DST boundaries', () => {
    it('keeps the wall-clock time when the clocks fall back', () => {
      // Spoken Sat Oct 31; DST ends Sun Nov 1. "Tomorrow at 9am" must be
      // 09:00 local, which is 25 real hours away, not 24.
      const satMorning = at('2026-10-31T13:00:00Z') // 09:00 EDT
      const r = resolveVoiceWhen({ kind: 'day_offset', offset: 1, time: '09:00' }, satMorning, NY)
      expect(localOf(r)).toBe('2026-11-01 09:00')
      expect(r.dueAtOverride).toBe('2026-11-01T14:00:00.000Z')
    })

    it('keeps the wall-clock time when the clocks spring forward', () => {
      const satMorning = at('2026-03-07T14:00:00Z') // 09:00 EST
      const r = resolveVoiceWhen({ kind: 'day_offset', offset: 1, time: '09:00' }, satMorning, NY)
      expect(localOf(r)).toBe('2026-03-08 09:00')
      expect(r.dueAtOverride).toBe('2026-03-08T13:00:00.000Z')
    })
  })

  describe('in_duration', () => {
    it('offsets from now and pins no wall-clock time', () => {
      const r = resolveVoiceWhen(
        { kind: 'in_duration', amount: 2, unit: 'hours' },
        THURSDAY_9AM,
        NY,
      )
      expect(r.dueAtOverride).toBe('2026-10-08T15:00:00.000Z')
      expect(r.timeOfDay).toBeNull()
    })

    it('handles minutes', () => {
      const r = resolveVoiceWhen(
        { kind: 'in_duration', amount: 20, unit: 'minutes' },
        THURSDAY_9AM,
        NY,
      )
      expect(r.dueAtOverride).toBe('2026-10-08T13:20:00.000Z')
    })
  })

  describe('absolute + none', () => {
    it('pins a spoken calendar date in the user timezone', () => {
      const r = resolveVoiceWhen(
        { kind: 'absolute', date: '2026-11-03', part: 'evening' },
        THURSDAY_9AM,
        NY,
      )
      expect(localOf(r)).toBe('2026-11-03 18:00')
    })

    it('returns no due date for "none"', () => {
      expect(resolveVoiceWhen({ kind: 'none' }, THURSDAY_9AM, NY)).toEqual({
        dueAtOverride: null,
        timeOfDay: null,
      })
    })
  })

  describe('timezones', () => {
    it('resolves against the user timezone, not the server one', () => {
      // 02:00 UTC on the 9th is still the 8th in Los Angeles (19:00 PDT).
      const now = at('2026-10-09T02:00:00Z')
      const r = resolveVoiceWhen(
        { kind: 'day_offset', offset: 1, part: 'morning' },
        now,
        'America/Los_Angeles',
      )
      expect(localOf(r, 'America/Los_Angeles')).toBe('2026-10-09 09:00')
    })
  })

  describe('rejects malformed input', () => {
    const bad: VoiceWhen[] = [
      { kind: 'next_weekday', weekday: 7 },
      { kind: 'next_weekday', weekday: -1 },
      { kind: 'day_offset', offset: -1 },
      { kind: 'day_offset', offset: 1.5 },
      { kind: 'absolute', date: '11/03/2026' },
      { kind: 'absolute', date: '2026-13-01' },
      { kind: 'in_duration', amount: 0, unit: 'hours' },
      { kind: 'day_offset', offset: 0, time: '25:00' },
      { kind: 'day_offset', offset: 0, part: 'anytime' as 'morning' },
    ]
    it.each(bad)('throws on %j', (when) => {
      expect(() => resolveVoiceWhen(when, THURSDAY_9AM, NY)).toThrow()
    })
  })
})
