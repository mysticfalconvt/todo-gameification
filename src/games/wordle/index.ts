import type { GameDefinition } from '../types'
import { Wordle } from './Wordle'

export const wordle: GameDefinition = {
  id: 'wordle',
  name: 'Wordle',
  description:
    'Guess the 5-letter word in 6 tries. Fewer guesses = more XP (20 → 5).',
  tokenCost: 1,
  rewardXp: (result) => {
    if (!result.won) return 0
    const guesses = result.score ?? MAX_GUESSES
    // 1 guess → 20 XP, 2 → 17, 3 → 14, 4 → 11, 5 → 8, 6 → 5.
    return Math.max(5, 23 - guesses * 3)
  },
  Component: Wordle,
}

const MAX_GUESSES = 6
