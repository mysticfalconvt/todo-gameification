import { describe, expect, it } from 'vitest'
import { resolveVoiceWhen } from '../../domain/voiceWhen'
import {
  narrowRecurrence,
  narrowWhen,
  type RawRecurrence,
  type RawWhen,
  reconcileWithTranscript,
  type TaskDraft,
  toDraft,
} from './parseTaskDraft'

// A fully-populated wire object, as the strict schema forces the model to
// emit it. Tests override only the fields they care about.
const raw = (over: Record<string, unknown> = {}) =>
  JSON.stringify({
    title: 'Mow the lawn',
    notes: '',
    when: {
      kind: 'none',
      dayOffset: 0,
      weekday: 0,
      date: '',
      amount: 0,
      unit: 'days',
      part: 'none',
      time: '',
    },
    recurrence: {
      type: 'none',
      daysOfWeek: [],
      amount: 0,
      unit: 'days',
      dayOfMonth: 1,
      week: 1,
      dayOfWeek: 0,
    },
    ...over,
  })

const when = (over: Record<string, unknown>) =>
  raw({
    when: {
      kind: 'none',
      dayOffset: 0,
      weekday: 0,
      date: '',
      amount: 0,
      unit: 'days',
      part: 'none',
      time: '',
      ...over,
    },
  })

const recur = (over: Record<string, unknown>) =>
  raw({
    recurrence: {
      type: 'none',
      daysOfWeek: [],
      amount: 0,
      unit: 'days',
      dayOfMonth: 1,
      week: 1,
      dayOfWeek: 0,
      ...over,
    },
  })

describe('toDraft', () => {
  describe('ignores sentinels for inapplicable fields', () => {
    it('drops the unused payload of the chosen when-kind', () => {
      // weekday/date/amount are all filled with sentinels but kind is
      // day_offset, so none of them may leak into the result.
      const d = toDraft(when({ kind: 'day_offset', dayOffset: 1, weekday: 4, date: '1999-01-01' }))
      expect(d?.when).toEqual({ kind: 'day_offset', offset: 1, part: null, time: null })
    })

    it('treats part "none" and time "" as no time spoken', () => {
      const d = toDraft(when({ kind: 'next_weekday', weekday: 2 }))
      expect(d?.when).toEqual({ kind: 'next_weekday', weekday: 2, part: null, time: null })
    })

    it('treats recurrence type "none" as not recurring', () => {
      expect(toDraft(raw())?.recurrence).toBeNull()
    })
  })

  describe('when narrowing', () => {
    it('keeps a day part', () => {
      const d = toDraft(when({ kind: 'next_weekday', weekday: 2, part: 'afternoon' }))
      expect(d?.when).toEqual({ kind: 'next_weekday', weekday: 2, part: 'afternoon', time: null })
    })

    it('keeps an explicit time', () => {
      const d = toDraft(when({ kind: 'day_offset', dayOffset: 1, time: '07:30' }))
      expect(d?.when).toEqual({ kind: 'day_offset', offset: 1, part: null, time: '07:30' })
    })

    it('discards a malformed time rather than guessing', () => {
      const d = toDraft(when({ kind: 'day_offset', dayOffset: 1, time: '7pm' }))
      expect(d?.when).toEqual({ kind: 'day_offset', offset: 1, part: null, time: null })
    })

    it('rejects the whole draft when the chosen kind has a bad payload', () => {
      expect(toDraft(when({ kind: 'next_weekday', weekday: 9 }))).toBeNull()
      expect(toDraft(when({ kind: 'absolute', date: 'next November' }))).toBeNull()
      expect(toDraft(when({ kind: 'in_duration', amount: 0, unit: 'hours' }))).toBeNull()
    })
  })

  describe('recurrence narrowing', () => {
    it('sorts and dedupes weekly days', () => {
      expect(toDraft(recur({ type: 'weekly', daysOfWeek: [5, 1, 5, 3] }))?.recurrence).toEqual({
        type: 'weekly',
        daysOfWeek: [1, 3, 5],
      })
    })

    it('falls back to not-recurring when weekly has no days', () => {
      expect(toDraft(recur({ type: 'weekly', daysOfWeek: [] }))?.recurrence).toBeNull()
    })

    it('maps interval and after_completion with units', () => {
      expect(toDraft(recur({ type: 'interval', amount: 14, unit: 'days' }))?.recurrence).toEqual({
        type: 'interval',
        amount: 14,
        unit: 'days',
      })
      expect(
        toDraft(recur({ type: 'after_completion', amount: 6, unit: 'hours' }))?.recurrence,
      ).toEqual({ type: 'after_completion', amount: 6, unit: 'hours' })
    })

    it('maps both monthly shapes', () => {
      expect(toDraft(recur({ type: 'monthly_day', dayOfMonth: 15 }))?.recurrence).toEqual({
        type: 'monthly_day',
        dayOfMonth: 15,
      })
      expect(
        toDraft(recur({ type: 'monthly_weekday', week: -1, dayOfWeek: 5 }))?.recurrence,
      ).toEqual({ type: 'monthly_weekday', week: -1, dayOfWeek: 5 })
    })

    it('drops an unusable recurrence instead of failing the whole draft', () => {
      const d = toDraft(recur({ type: 'monthly_day', dayOfMonth: 99 }))
      expect(d?.title).toBe('Mow the lawn')
      expect(d?.recurrence).toBeNull()
    })
  })

  describe('title and notes', () => {
    it('trims, and nulls empty notes', () => {
      const d = toDraft(raw({ title: '  Mow the lawn  ', notes: '   ' }))
      expect(d?.title).toBe('Mow the lawn')
      expect(d?.notes).toBeNull()
    })

    it('keeps real notes', () => {
      expect(toDraft(raw({ notes: 'the back gate sticks' }))?.notes).toBe('the back gate sticks')
    })

    it('rejects a draft with no title', () => {
      expect(toDraft(raw({ title: '   ' }))).toBeNull()
    })
  })

  describe('malformed model output', () => {
    it('tolerates code fences', () => {
      expect(toDraft(`\`\`\`json\n${raw()}\n\`\`\``)?.title).toBe('Mow the lawn')
    })

    it('tolerates leading prose', () => {
      expect(toDraft(`Sure! Here you go:\n${raw()}`)?.title).toBe('Mow the lawn')
    })

    it('returns null on junk, empty and null', () => {
      expect(toDraft('not json at all')).toBeNull()
      expect(toDraft('')).toBeNull()
      expect(toDraft(null)).toBeNull()
    })
  })

  describe('end to end with the resolver', () => {
    it('turns the motivating utterance into a concrete instant', () => {
      // "I need to mow the lawn on Tuesday afternoon", spoken Thu 2026-10-08.
      const d = toDraft(when({ kind: 'next_weekday', weekday: 2, part: 'afternoon' }))
      if (!d) throw new Error('expected a draft')
      const r = resolveVoiceWhen(d.when, new Date('2026-10-08T13:00:00Z'), 'America/New_York')
      expect(r.dueAtOverride).toBe('2026-10-13T16:00:00.000Z') // Tue 12:00 EDT
      expect(r.timeOfDay).toBe('12:00')
    })
  })
})

describe('reconcileWithTranscript', () => {
  const draft = (over: Partial<TaskDraft>): TaskDraft => ({
    title: 'Task',
    notes: null,
    when: { kind: 'none' },
    recurrence: null,
    ...over,
  })

  it('corrects a misnumbered weekday on monthly_weekday', () => {
    // The live failure: "the first Monday of every month" came back as
    // dayOfWeek 2 (Tuesday) even at temperature 0.
    const d = reconcileWithTranscript(
      draft({ recurrence: { type: 'monthly_weekday', week: 1, dayOfWeek: 2 } }),
      'pay the mortgage the first Monday of every month',
    )
    expect(d.recurrence).toEqual({ type: 'monthly_weekday', week: 1, dayOfWeek: 1 })
  })

  it('corrects a misnumbered weekday on next_weekday', () => {
    const d = reconcileWithTranscript(
      draft({ when: { kind: 'next_weekday', weekday: 2, part: 'evening', time: null } }),
      'take the bins out every Wednesday evening',
    )
    expect(d.when).toEqual({ kind: 'next_weekday', weekday: 3, part: 'evening', time: null })
  })

  it('rebuilds weekly days from the transcript', () => {
    const d = reconcileWithTranscript(
      draft({ recurrence: { type: 'weekly', daysOfWeek: [1] } }),
      'water the plants every Tuesday and Thursday',
    )
    expect(d.recurrence).toEqual({ type: 'weekly', daysOfWeek: [2, 4] })
  })

  it('scales weeks that the model emitted as days', () => {
    const d = reconcileWithTranscript(
      draft({ recurrence: { type: 'after_completion', amount: 2, unit: 'days' } }),
      'descale the coffee machine two weeks after I finish it',
    )
    expect(d.recurrence).toEqual({ type: 'after_completion', amount: 14, unit: 'days' })
  })

  it('scales months and years', () => {
    expect(
      reconcileWithTranscript(
        draft({ when: { kind: 'in_duration', amount: 3, unit: 'days' } }),
        'renew the passport in three months',
      ).when,
    ).toEqual({ kind: 'in_duration', amount: 90, unit: 'days' })
  })

  it('leaves an already-correct duration alone', () => {
    const d = reconcileWithTranscript(
      draft({ when: { kind: 'in_duration', amount: 14, unit: 'days' } }),
      'clean the gutters in two weeks',
    )
    expect(d.when).toEqual({ kind: 'in_duration', amount: 14, unit: 'days' })
  })

  it('leaves hours and minutes alone', () => {
    const d = reconcileWithTranscript(
      draft({ when: { kind: 'in_duration', amount: 2, unit: 'hours' } }),
      'move the laundry over in two hours',
    )
    expect(d.when).toEqual({ kind: 'in_duration', amount: 2, unit: 'hours' })
  })

  it('does not invent a weekday when the model chose a different shape', () => {
    // A weekday mentioned in passing must not hijack a day_offset.
    const d = reconcileWithTranscript(
      draft({ when: { kind: 'day_offset', offset: 1, part: null, time: null } }),
      'call Bob about the Friday meeting tomorrow',
    )
    expect(d.when).toEqual({ kind: 'day_offset', offset: 1, part: null, time: null })
  })

  it('leaves next_weekday alone when the transcript names several days', () => {
    const d = reconcileWithTranscript(
      draft({ when: { kind: 'next_weekday', weekday: 2, part: null, time: null } }),
      'swap the Monday and Tuesday shifts',
    )
    expect(d.when).toEqual({ kind: 'next_weekday', weekday: 2, part: null, time: null })
  })

  it('matches abbreviations but not substrings of other words', () => {
    expect(
      reconcileWithTranscript(
        draft({ when: { kind: 'next_weekday', weekday: 0, part: null, time: null } }),
        'gym on Weds',
      ).when,
    ).toEqual({ kind: 'next_weekday', weekday: 0, part: null, time: null })

    expect(
      reconcileWithTranscript(
        draft({ when: { kind: 'next_weekday', weekday: 0, part: null, time: null } }),
        'standup Thurs',
      ).when,
    ).toEqual({ kind: 'next_weekday', weekday: 4, part: null, time: null })
  })
})

describe('narrowWhen', () => {
  const w = (over: Partial<RawWhen> = {}): RawWhen => ({
    kind: 'none',
    dayOffset: 0,
    weekday: 0,
    date: '',
    amount: 0,
    unit: 'days',
    part: 'none',
    time: '',
    ...over,
  })

  it('accepts every valid kind', () => {
    expect(narrowWhen(w())).toEqual({ kind: 'none' })
    expect(narrowWhen(w({ kind: 'day_offset', dayOffset: 3 }))).toEqual({
      kind: 'day_offset',
      offset: 3,
      part: null,
      time: null,
    })
    expect(narrowWhen(w({ kind: 'in_duration', amount: 30, unit: 'minutes' }))).toEqual({
      kind: 'in_duration',
      amount: 30,
      unit: 'minutes',
    })
    expect(narrowWhen(w({ kind: 'absolute', date: '2026-11-03' }))).toEqual({
      kind: 'absolute',
      date: '2026-11-03',
      part: null,
      time: null,
    })
  })

  it('rejects out-of-range and malformed payloads', () => {
    expect(narrowWhen(w({ kind: 'next_weekday', weekday: 7 }))).toBeNull()
    expect(narrowWhen(w({ kind: 'day_offset', dayOffset: -1 }))).toBeNull()
    expect(narrowWhen(w({ kind: 'in_duration', amount: 0 }))).toBeNull()
    expect(narrowWhen(w({ kind: 'absolute', date: 'tomorrow' }))).toBeNull()
    expect(narrowWhen(w({ kind: 'nope' as 'none' }))).toBeNull()
  })

  it('defaults an unrecognised unit to days', () => {
    expect(narrowWhen(w({ kind: 'in_duration', amount: 2, unit: 'weeks' as 'days' }))).toEqual({
      kind: 'in_duration',
      amount: 2,
      unit: 'days',
    })
  })
})

describe('narrowRecurrence', () => {
  const r = (over: Partial<RawRecurrence> = {}): RawRecurrence => ({
    type: 'none',
    daysOfWeek: [],
    amount: 0,
    unit: 'days',
    dayOfMonth: 1,
    week: 1,
    dayOfWeek: 0,
    ...over,
  })

  it('maps every valid type', () => {
    expect(narrowRecurrence(r({ type: 'daily' }))).toEqual({ type: 'daily' })
    expect(narrowRecurrence(r({ type: 'weekly', daysOfWeek: [1, 3] }))).toEqual({
      type: 'weekly',
      daysOfWeek: [1, 3],
    })
    expect(narrowRecurrence(r({ type: 'monthly_day', dayOfMonth: 31 }))).toEqual({
      type: 'monthly_day',
      dayOfMonth: 31,
    })
  })

  it('accepts every valid monthly week index including last', () => {
    for (const week of [1, 2, 3, 4, -1]) {
      expect(narrowRecurrence(r({ type: 'monthly_weekday', week, dayOfWeek: 1 }))).toEqual({
        type: 'monthly_weekday',
        week,
        dayOfWeek: 1,
      })
    }
  })

  it('rejects out-of-range payloads', () => {
    expect(narrowRecurrence(r({ type: 'none' }))).toBeNull()
    expect(narrowRecurrence(r({ type: 'weekly', daysOfWeek: [9] }))).toBeNull()
    expect(narrowRecurrence(r({ type: 'monthly_day', dayOfMonth: 0 }))).toBeNull()
    expect(narrowRecurrence(r({ type: 'monthly_weekday', week: 5, dayOfWeek: 1 }))).toBeNull()
    expect(narrowRecurrence(r({ type: 'interval', amount: 0 }))).toBeNull()
  })
})
