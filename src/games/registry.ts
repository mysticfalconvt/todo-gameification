import type { GameDefinition } from './types'
import { memoryFlip } from './memory-flip'

export const GAMES: readonly GameDefinition[] = [memoryFlip]

export function findGame(id: string): GameDefinition | null {
  return GAMES.find((g) => g.id === id) ?? null
}
