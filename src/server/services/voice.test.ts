import { describe, expect, it } from 'vitest'
import type { VoiceWhen } from '../../domain/voiceWhen'
import { toVoiceDraft } from './voice'

const NY = 'America/New_York'
const NOW = new Date('2026-10-08T13:00:00Z') // Thursday 09:00 EDT

const parsed = (when: VoiceWhen, over = {}) => ({
  title: 'Mow the lawn',
  notes: null,
  when,
  recurrence: null,
  ...over,
})

describe('toVoiceDraft', () => {
  it('resolves the when-clause into a due instant', () => {
    const d = toVoiceDraft(
      parsed({ kind: 'next_weekday', weekday: 2, part: 'afternoon', time: null }),
      NOW,
      NY,
    )
    expect(d.dueAtOverride).toBe('2026-10-13T16:00:00.000Z')
    expect(d.timeOfDay).toBe('12:00')
    expect(d.someday).toBe(false)
  })

  it('marks a timing-free, non-recurring task as someday', () => {
    const d = toVoiceDraft(parsed({ kind: 'none' }), NOW, NY)
    expect(d.dueAtOverride).toBeNull()
    expect(d.someday).toBe(true)
  })

  it('does not mark a recurring task someday, even with no spoken start', () => {
    // createTask's firstDueAt derives the first occurrence from the
    // recurrence, so this must stay out of the someday bucket.
    const d = toVoiceDraft(
      parsed({ kind: 'none' }, { recurrence: { type: 'weekly', daysOfWeek: [2, 4] } }),
      NOW,
      NY,
    )
    expect(d.someday).toBe(false)
    expect(d.recurrence).toEqual({ type: 'weekly', daysOfWeek: [2, 4] })
  })

  it('degrades an unresolvable when-clause instead of throwing', () => {
    // A confused model must cost the date, never the capture.
    const d = toVoiceDraft(
      parsed({ kind: 'next_weekday', weekday: 99, part: null, time: null }),
      NOW,
      NY,
    )
    expect(d.title).toBe('Mow the lawn')
    expect(d.dueAtOverride).toBeNull()
    expect(d.someday).toBe(true)
  })

  it('carries notes through', () => {
    const d = toVoiceDraft(parsed({ kind: 'none' }, { notes: 'back gate sticks' }), NOW, NY)
    expect(d.notes).toBe('back gate sticks')
  })
})
