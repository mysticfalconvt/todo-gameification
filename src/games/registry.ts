import type { GameDefinition } from './types'
import { memoryFlip } from './memory-flip'
import { slidingPuzzle } from './sliding-puzzle'
import { two048 } from './two048'
import { wordle } from './wordle'

export const GAMES: readonly GameDefinition[] = [
  memoryFlip,
  wordle,
  two048,
  slidingPuzzle,
]

export function findGame(id: string): GameDefinition | null {
  return GAMES.find((g) => g.id === id) ?? null
}
