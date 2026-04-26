import type { GameDefinition } from '../types'
import { SlidingPuzzle } from './SlidingPuzzle'

export const slidingPuzzle: GameDefinition = {
  id: 'sliding-puzzle',
  name: 'Sliding Puzzle',
  description:
    'Slide the 8 tiles into order. Fewer moves = more XP (20 → 5).',
  tokenCost: 1,
  rewardXp: (result) => {
    if (!result.won) return 0
    const moves = result.score ?? 100
    // Random scrambles average ~22 optimal moves; most casual solves land in
    // 30–80 moves. Scale: ≤25 moves = 20 XP, every extra 5 moves drops 1 XP,
    // floor at 5.
    const penalty = Math.max(0, Math.floor((moves - 25) / 5))
    return Math.max(5, 20 - penalty)
  },
  Component: SlidingPuzzle,
}
