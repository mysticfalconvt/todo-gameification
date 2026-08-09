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

// Membership gating for the arcade. 'free' games are always playable; the
// arcade page renders 'member' games with a lock + upsell overlay for
// non-members, and the server gates startGame/finishGame so a direct API
// call can't bypass the UI.
export type GameTier = 'free' | 'member'

// Metadata only — deliberately no React component.
//
// The server needs `rewardXp`, `tokenCost` and `tier` (games service, arcade
// stats, weekly summary email). If the definition also carried `Component`,
// importing the registry server-side would pull in every game's UI, and those
// components import server functions — which is exactly the cycle
// registry → *.tsx → server/functions → server/services → registry.
//
// The id → component map lives in `games/components.tsx` and is imported only
// by the arcade route.
export type GameDefinition = {
  id: string
  name: string
  description: string
  tokenCost: number
  tier: GameTier
  rewardXp: (result: GameResult) => number
}
