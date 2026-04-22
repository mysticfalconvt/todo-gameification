import type { ComponentType } from 'react'

export type GameResult = { won: boolean; score: number | null }

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
