import { describe, expect, it } from 'vitest'
import {
  FOCUS_REWARDS_POCKET,
  FOCUS_REWARDS_VISIBLE,
  focusRewardsFor,
} from './events'

describe('focus rewards', () => {
  it('pocket and visible are identical at the short tiers (5m, 10m)', () => {
    expect(FOCUS_REWARDS_POCKET[5]).toEqual(FOCUS_REWARDS_VISIBLE[5])
    expect(FOCUS_REWARDS_POCKET[10]).toEqual(FOCUS_REWARDS_VISIBLE[10])
  })

  it('visible earns +1 token at 15/25/50 versus pocket', () => {
    expect(FOCUS_REWARDS_VISIBLE[15].tokens).toBe(
      FOCUS_REWARDS_POCKET[15].tokens + 1,
    )
    expect(FOCUS_REWARDS_VISIBLE[25].tokens).toBe(
      FOCUS_REWARDS_POCKET[25].tokens + 1,
    )
    expect(FOCUS_REWARDS_VISIBLE[50].tokens).toBe(
      FOCUS_REWARDS_POCKET[50].tokens + 1,
    )
  })

  it('XP is identical across modes at every tier', () => {
    for (const d of [5, 10, 15, 25, 50] as const) {
      expect(FOCUS_REWARDS_VISIBLE[d].xp).toBe(FOCUS_REWARDS_POCKET[d].xp)
    }
  })

  it('focusRewardsFor returns the right table for each mode', () => {
    expect(focusRewardsFor('pocket')).toBe(FOCUS_REWARDS_POCKET)
    expect(focusRewardsFor('visible')).toBe(FOCUS_REWARDS_VISIBLE)
  })
})
