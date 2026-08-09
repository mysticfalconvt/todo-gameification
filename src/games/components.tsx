// id → React component for every arcade game.
//
// Kept separate from `registry.ts` on purpose. The registry is metadata only,
// so server code (games service, arcade stats, weekly summary email) can read
// `rewardXp` / `tokenCost` / `tier` without pulling in any game UI. These
// components import server functions, so a registry that also held them closed
// the loop registry → *.tsx → server/functions → server/services → registry.
//
// Import this ONLY from client routes. Adding a game means adding an entry
// here as well as in `registry.ts`.
import type { ComponentType } from 'react'
import type { GameProps } from './types'
import { Boggle } from './boggle/Boggle'
import { MemoryFlip } from './memory-flip/MemoryFlip'
import { SlidingPuzzle } from './sliding-puzzle/SlidingPuzzle'
import { Sudoku } from './sudoku/Sudoku'
import { Two048 } from './two048/Two048'
import { WordSearch } from './word-search/WordSearch'
import { Wordle } from './wordle/Wordle'

// Keys MUST match `GameDefinition.id`, not the folder name — 2048 lives in
// `two048/` but its id is '2048'.
const GAME_COMPONENTS: Record<string, ComponentType<GameProps>> = {
  boggle: Boggle,
  'memory-flip': MemoryFlip,
  'sliding-puzzle': SlidingPuzzle,
  sudoku: Sudoku,
  '2048': Two048,
  'word-search': WordSearch,
  wordle: Wordle,
}

// Rendered when an id has no entry above — a loud, obvious placeholder rather
// than the `undefined` element type React would otherwise throw on.
function MissingGame({ id }: { id: string }) {
  return (
    <p className="text-sm font-semibold text-red-600">
      No component registered for “{id}”. Add it to <code>src/games/components.tsx</code>.
    </p>
  )
}

// Total, not nullable: callers render the result unconditionally, so a missing
// entry can't add a branch to an already-large arcade component.
export function gameComponent(id: string): ComponentType<GameProps> {
  const found = GAME_COMPONENTS[id]
  if (found) return found
  return () => <MissingGame id={id} />
}
