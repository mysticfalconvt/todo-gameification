import type { GameDefinition } from './types'
import { memoryFlip } from './memory-flip'
import { slidingPuzzle } from './sliding-puzzle'
import { sudoku } from './sudoku'
import { two048 } from './two048'
import { wordle } from './wordle'
import { wordSearch } from './word-search'

export const GAMES: readonly GameDefinition[] = [
  memoryFlip,
  wordle,
  two048,
  slidingPuzzle,
  wordSearch,
  sudoku,
]

export function findGame(id: string): GameDefinition | null {
  return GAMES.find((g) => g.id === id) ?? null
}
