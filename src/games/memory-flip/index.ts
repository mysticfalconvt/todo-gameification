import type { GameDefinition } from '../types'
import { MemoryFlip } from './MemoryFlip'

export const memoryFlip: GameDefinition = {
  id: 'memory-flip',
  name: 'Memory Flip',
  description: 'Match all 6 pairs before 6 mismatches. Fewer moves = more XP.',
  tokenCost: 1,
  rewardXp: (result) => {
    if (!result.won) return 0
    const moves = result.score ?? 99
    // 6 pairs → best-case 6 moves. Reward: floor from 20 down, min 5.
    return Math.max(5, 20 - Math.max(0, moves - 6))
  },
  Component: MemoryFlip,
}
