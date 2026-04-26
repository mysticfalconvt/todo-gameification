import type { GameDefinition } from '../types'
import { Two048 } from './Two048'

export const two048: GameDefinition = {
  id: '2048',
  name: '2048',
  description:
    'Slide tiles to merge matching pairs. Reach 1024 to win — higher tiles = more XP.',
  tokenCost: 1,
  rewardXp: (result) => {
    if (!result.won) return 0
    const top = result.score ?? 1024
    // 1024 → 10, 2048 → 15, 4096 → 20. Capped at 20 to match the other games.
    const tier = Math.max(0, Math.log2(top) - 10)
    return Math.min(20, Math.round(10 + tier * 5))
  },
  Component: Two048,
}
