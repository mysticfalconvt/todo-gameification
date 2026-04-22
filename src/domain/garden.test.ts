import { describe, expect, it } from 'vitest'
import {
  INITIAL_GARDEN,
  UNCATEGORIZED_KEY,
  applyGardenEvent,
  growthStage,
  milestoneDecorations,
  mood,
  replayGarden,
} from './garden'

const TZ = 'America/New_York'

function completion(iso: string, slug: string | null) {
  return {
    type: 'task.completed' as const,
    occurredAt: new Date(iso),
    categorySlug: slug,
  }
}

describe('garden reducer', () => {
  it('creates a new plant on first completion', () => {
    const s = applyGardenEvent(
      INITIAL_GARDEN,
      completion('2026-01-01T12:00:00Z', 'health'),
      { timeZone: TZ },
    )
    expect(s.plants['health']).toMatchObject({
      waterings: 1,
      currentStreak: 1,
      longestStreak: 1,
    })
  })

  it('same-day completions do not bump streak but do bump waterings', () => {
    const s = replayGarden(
      [
        completion('2026-01-01T09:00:00Z', 'health'),
        completion('2026-01-01T18:00:00Z', 'health'),
      ],
      { timeZone: TZ },
    )
    expect(s.plants['health'].waterings).toBe(2)
    expect(s.plants['health'].currentStreak).toBe(1)
  })

  it('consecutive-day completions extend streak', () => {
    const s = replayGarden(
      [
        completion('2026-01-01T12:00:00-05:00', 'health'),
        completion('2026-01-02T12:00:00-05:00', 'health'),
        completion('2026-01-03T12:00:00-05:00', 'health'),
      ],
      { timeZone: TZ },
    )
    expect(s.plants['health'].currentStreak).toBe(3)
    expect(s.plants['health'].longestStreak).toBe(3)
  })

  it('a skipped day resets current streak but not longest', () => {
    const s = replayGarden(
      [
        completion('2026-01-01T12:00:00-05:00', 'health'),
        completion('2026-01-02T12:00:00-05:00', 'health'),
        // skip jan 3
        completion('2026-01-04T12:00:00-05:00', 'health'),
      ],
      { timeZone: TZ },
    )
    expect(s.plants['health'].currentStreak).toBe(1)
    expect(s.plants['health'].longestStreak).toBe(2)
  })

  it('each category maintains its own plant + streak', () => {
    const s = replayGarden(
      [
        completion('2026-01-01T12:00:00-05:00', 'health'),
        completion('2026-01-01T13:00:00-05:00', 'work'),
        completion('2026-01-02T12:00:00-05:00', 'health'),
      ],
      { timeZone: TZ },
    )
    expect(s.plants['health'].currentStreak).toBe(2)
    expect(s.plants['work'].currentStreak).toBe(1)
  })

  it('null category goes to the uncategorized bucket', () => {
    const s = applyGardenEvent(
      INITIAL_GARDEN,
      completion('2026-01-01T12:00:00Z', null),
      { timeZone: TZ },
    )
    expect(s.plants[UNCATEGORIZED_KEY]).toBeTruthy()
    expect(s.plants[UNCATEGORIZED_KEY].categorySlug).toBeNull()
  })

  it('growthStage hits every tier at sensible thresholds', () => {
    expect(growthStage(0)).toBe('seed')
    expect(growthStage(1)).toBe('sprout')
    expect(growthStage(2)).toBe('sprout')
    expect(growthStage(3)).toBe('young')
    expect(growthStage(10)).toBe('mature')
    expect(growthStage(30)).toBe('blooming')
    expect(growthStage(100)).toBe('lush')
    expect(growthStage(249)).toBe('lush')
    expect(growthStage(250)).toBe('ancient')
    expect(growthStage(499)).toBe('ancient')
    expect(growthStage(500)).toBe('grove')
    expect(growthStage(9999)).toBe('grove')
  })

  it('milestone decorations accumulate at the right watering counts', () => {
    expect(milestoneDecorations(0)).toEqual([])
    expect(milestoneDecorations(49)).toEqual([])
    expect(milestoneDecorations(50)).toEqual(['butterfly'])
    expect(milestoneDecorations(149)).toEqual(['butterfly'])
    expect(milestoneDecorations(150)).toEqual(['butterfly', 'bee'])
    expect(milestoneDecorations(300)).toEqual(['butterfly', 'bee', 'bird'])
    expect(milestoneDecorations(500)).toEqual([
      'butterfly',
      'bee',
      'bird',
      'sparkle',
    ])
  })

  it('mood tracks recency across seven levels', () => {
    const now = new Date('2026-01-20T12:00:00Z')
    expect(mood(null, now)).toBe('dormant')
    // 6h ago → thriving
    expect(mood(new Date('2026-01-20T06:00:00Z'), now)).toBe('thriving')
    // 24h ago → perky (12–36h)
    expect(mood(new Date('2026-01-19T12:00:00Z'), now)).toBe('perky')
    // 48h ago → content (36–96h)
    expect(mood(new Date('2026-01-18T12:00:00Z'), now)).toBe('content')
    // 5 days ago → thirsty (96–168h)
    expect(mood(new Date('2026-01-15T12:00:00Z'), now)).toBe('thirsty')
    // 10 days ago → wilting (168–336h)
    expect(mood(new Date('2026-01-10T12:00:00Z'), now)).toBe('wilting')
    // 20 days ago → parched (>336h)
    expect(mood(new Date('2025-12-31T12:00:00Z'), now)).toBe('parched')
  })
})
