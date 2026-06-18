import type { GameDefinition } from '../types'
import { Boggle } from './Boggle'

export const boggle: GameDefinition = {
  id: 'boggle',
  name: 'Boggle',
  description:
    'Trace adjacent letters to build words before the 3-minute clock runs out. Longer words = more points.',
  tokenCost: 1,
  tier: 'member',
  rewardXp: (result) => {
    if (!result.won) return 0
    const score = result.score ?? 0
    // No natural "win" — XP scales with points. ~3 pts → 6 XP, 15 → 10,
    // 45+ → 20. Capped at 20 to match the other games.
    return Math.min(20, 5 + Math.floor(score / 3))
  },
  Component: Boggle,
}
