import type { GameDefinition } from './types'
import { memoryFlip } from './memory-flip'
import { wordle } from './wordle'

export const GAMES: readonly GameDefinition[] = [memoryFlip, wordle]

export function findGame(id: string): GameDefinition | null {
  return GAMES.find((g) => g.id === id) ?? null
}
