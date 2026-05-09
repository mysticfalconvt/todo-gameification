import type { GameDefinition } from '../types'
import { WordSearch } from './WordSearch'

const SMALL_CAP = 12
const LARGE_CAP = 24

export const wordSearch: GameDefinition = {
  id: 'word-search',
  name: 'Word Search',
  description:
    'Pick a theme (or write your own) and tap two ends of each hidden word. Find them all for full XP.',
  tokenCost: 1,
  tier: 'member',
  rewardXp: (result) => {
    const total =
      typeof result.meta?.total === 'number' && result.meta.total > 0
        ? result.meta.total
        : 1
    const found = result.score ?? 0
    const ratio = Math.min(1, Math.max(0, found / total))
    const cap = result.meta?.size === 'large' ? LARGE_CAP : SMALL_CAP
    return Math.round(cap * ratio)
  },
  Component: WordSearch,
}
