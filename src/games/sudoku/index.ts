import type { GameDefinition } from '../types'
import { Sudoku } from './Sudoku'

export const sudoku: GameDefinition = {
  id: 'sudoku',
  name: 'Sudoku',
  description:
    'Classic 9×9 — pick easy or hard. Three mistakes ends the run. Score = seconds + 30s per mistake; lower wins.',
  tokenCost: 1,
  tier: 'member',
  rewardXp: (result) => {
    if (!result.won) return 0
    const mistakes =
      typeof result.meta?.mistakes === 'number' ? result.meta.mistakes : 0
    const hints =
      typeof result.meta?.hints === 'number' ? result.meta.hints : 0
    const hard = result.meta?.difficulty === 'hard'
    const base = hard ? 60 : 30
    const perMistake = hard ? 10 : 6
    const perHint = hard ? 10 : 6
    return Math.max(0, base - perMistake * mistakes - perHint * hints)
  },
  Component: Sudoku,
}
