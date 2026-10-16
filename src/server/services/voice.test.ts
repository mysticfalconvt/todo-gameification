import { describe, expect, it } from 'vitest'
import type { VoiceWhen } from '../../domain/voiceWhen'
import { resolveAssignment, resolveMemberName, toVoiceDraft } from './voice'

const NY = 'America/New_York'
const NOW = new Date('2026-10-08T13:00:00Z') // Thursday 09:00 EDT

const parsed = (when: VoiceWhen, over = {}) => ({
  title: 'Mow the lawn',
  notes: null,
  when,
  recurrence: null,
  assignee: { kind: 'default' } as const,
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

const members = [
  { userId: 'u-rob', name: 'Rob Boskind', handle: 'rob', role: 'admin' as const },
  { userId: 'u-sarah', name: 'Sarah Boskind', handle: 'sarah', role: 'member' as const },
  { userId: 'u-kid', name: 'Milo Boskind', handle: 'milo', role: 'kid' as const },
  { userId: 'u-kid2', name: 'Milo Jones', handle: 'mj', role: 'kid' as const },
]

const household = (role = 'admin') =>
  ({
    household: { id: 'hh-1', name: 'Home', createdByUserId: 'u-rob', createdAt: new Date() },
    role,
    viewerUserId: 'u-rob',
    members,
    // biome-ignore lint/suspicious/noExplicitAny: test fixture for MyHousehold
  }) as any

describe('resolveMemberName', () => {
  it('matches a first name, full name or handle', () => {
    expect(resolveMemberName('Sarah', members)).toBe('u-sarah')
    expect(resolveMemberName('sarah boskind', members)).toBe('u-sarah')
    expect(resolveMemberName('  SARAH  ', members)).toBe('u-sarah')
    expect(resolveMemberName('rob', members)).toBe('u-rob')
  })

  it('refuses an ambiguous first name rather than guessing', () => {
    // Two Milos: assigning a chore to the wrong child is worse than
    // falling back to the speaker and letting them fix it.
    expect(resolveMemberName('Milo', members)).toBeNull()
    expect(resolveMemberName('Milo Jones', members)).toBe('u-kid2')
  })

  it('returns null for an unknown or empty name', () => {
    expect(resolveMemberName('Dave', members)).toBeNull()
    expect(resolveMemberName('', members)).toBeNull()
    expect(resolveMemberName('  ', members)).toBeNull()
  })
})

describe('resolveAssignment', () => {
  it('defaults to a household chore assigned to the speaker', () => {
    expect(resolveAssignment({ kind: 'default' }, household())).toEqual({
      householdId: 'hh-1',
      assignedToUserId: 'u-rob',
      assigneeGroup: null,
    })
  })

  it('stays personal with no household', () => {
    expect(resolveAssignment({ kind: 'default' }, null)).toEqual({
      householdId: null,
      assignedToUserId: null,
      assigneeGroup: null,
    })
  })

  it('stays personal for a non-adult', () => {
    // Kids cannot own chores; createTask would reject it anyway.
    expect(resolveAssignment({ kind: 'default' }, household('kid')).householdId).toBeNull()
    expect(resolveAssignment({ kind: 'default' }, household('kiosk')).householdId).toBeNull()
  })

  it('maps a group to assigneeGroup with no specific assignee', () => {
    // createTask rejects a group combined with an assignee, so these must
    // be mutually exclusive here too.
    expect(resolveAssignment({ kind: 'group', group: 'kids' }, household())).toEqual({
      householdId: 'hh-1',
      assignedToUserId: null,
      assigneeGroup: 'kids',
    })
  })

  it('resolves a named person to their user id', () => {
    expect(resolveAssignment({ kind: 'person', name: 'Sarah' }, household())).toEqual({
      householdId: 'hh-1',
      assignedToUserId: 'u-sarah',
      assigneeGroup: null,
    })
  })

  it('falls back to the speaker when a name cannot be matched', () => {
    // "call Dave about the car" must not assign the chore to anyone else.
    expect(resolveAssignment({ kind: 'person', name: 'Dave' }, household())).toEqual({
      householdId: 'hh-1',
      assignedToUserId: 'u-rob',
      assigneeGroup: null,
    })
    expect(resolveAssignment({ kind: 'person', name: 'Milo' }, household()).assignedToUserId).toBe(
      'u-rob',
    )
  })

  it('ignores a group when the speaker has no household', () => {
    expect(resolveAssignment({ kind: 'group', group: 'adults' }, null).assigneeGroup).toBeNull()
  })
})
