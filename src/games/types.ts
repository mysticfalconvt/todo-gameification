import type { ComponentType } from 'react'

// `meta` is a game-specific passthrough — wordle uses it to carry the word
// that was played so it can be logged in the event and fed into the
// per-user "seen words" check.
export type GameResult = {
  won: boolean
  score: number | null
  meta?: Record<string, unknown>
}

export type GameProps = {
  onFinish: (result: GameResult) => void
  onExit: () => void
}

export type GameDefinition = {
  id: string
  name: string
  description: string
  tokenCost: number
  rewardXp: (result: GameResult) => number
  Component: ComponentType<GameProps>
}
