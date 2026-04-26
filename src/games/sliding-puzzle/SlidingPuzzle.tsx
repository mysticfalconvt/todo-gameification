import { useEffect, useMemo, useState } from 'react'
import type { GameProps } from '../types'

const SIZE = 3
const TOTAL = SIZE * SIZE
// 0 represents the blank cell.
const SOLVED: number[] = Array.from({ length: TOTAL }, (_, i) =>
  i === TOTAL - 1 ? 0 : i + 1,
)

function indexToRC(i: number): [number, number] {
  return [Math.floor(i / SIZE), i % SIZE]
}

function rcToIndex(r: number, c: number): number {
  return r * SIZE + c
}

function neighbors(i: number): number[] {
  const [r, c] = indexToRC(i)
  const out: number[] = []
  if (r > 0) out.push(rcToIndex(r - 1, c))
  if (r < SIZE - 1) out.push(rcToIndex(r + 1, c))
  if (c > 0) out.push(rcToIndex(r, c - 1))
  if (c < SIZE - 1) out.push(rcToIndex(r, c + 1))
  return out
}

// Generate a solvable starting state by walking back N random valid moves
// from the solved state. This avoids the unsolvable-permutation trap that
// random shuffling falls into.
function shuffle(steps = 80): number[] {
  const tiles = SOLVED.slice()
  let blank = TOTAL - 1
  let prev = -1
  for (let i = 0; i < steps; i++) {
    const opts = neighbors(blank).filter((n) => n !== prev)
    const pick = opts[Math.floor(Math.random() * opts.length)]
    ;[tiles[blank], tiles[pick]] = [tiles[pick], tiles[blank]]
    prev = blank
    blank = pick
  }
  // Don't hand the player an already-solved board.
  if (tiles.every((v, i) => v === SOLVED[i])) return shuffle(steps)
  return tiles
}

function isSolved(tiles: number[]): boolean {
  return tiles.every((v, i) => v === SOLVED[i])
}

export function SlidingPuzzle({ onFinish, onExit }: GameProps) {
  const [tiles, setTiles] = useState<number[]>(() => shuffle())
  const [moves, setMoves] = useState(0)

  const blankIdx = useMemo(() => tiles.indexOf(0), [tiles])
  const solved = useMemo(() => isSolved(tiles), [tiles])

  useEffect(() => {
    if (solved) {
      const t = setTimeout(() => onFinish({ won: true, score: moves }), 500)
      return () => clearTimeout(t)
    }
  }, [solved, moves, onFinish])

  function tryMove(idx: number) {
    if (solved) return
    if (!neighbors(blankIdx).includes(idx)) return
    setTiles((prev) => {
      const next = prev.slice()
      next[blankIdx] = next[idx]
      next[idx] = 0
      return next
    })
    setMoves((m) => m + 1)
  }

  // Keyboard: arrow keys move the tile that's adjacent to the blank in the
  // opposite direction (e.g. ArrowUp slides the tile *below* the blank up).
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.metaKey || e.ctrlKey || e.altKey) return
      const [br, bc] = indexToRC(blankIdx)
      let target: number | null = null
      if (e.key === 'ArrowUp' && br < SIZE - 1) target = rcToIndex(br + 1, bc)
      else if (e.key === 'ArrowDown' && br > 0) target = rcToIndex(br - 1, bc)
      else if (e.key === 'ArrowLeft' && bc < SIZE - 1) target = rcToIndex(br, bc + 1)
      else if (e.key === 'ArrowRight' && bc > 0) target = rcToIndex(br, bc - 1)
      if (target !== null) {
        e.preventDefault()
        tryMove(target)
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [blankIdx, solved])

  return (
    <div className="flex flex-col items-center gap-4">
      <div className="flex w-full items-center justify-between text-sm">
        <span>Moves: {moves}</span>
        <button
          type="button"
          onClick={() => {
            setTiles(shuffle())
            setMoves(0)
          }}
          className="rounded border border-[var(--btn-subtle-border)] px-2 py-1 text-xs hover:bg-[var(--btn-subtle-bg)]"
        >
          Shuffle
        </button>
        <button
          type="button"
          onClick={onExit}
          className="rounded border border-[var(--btn-subtle-border)] px-2 py-1 text-xs hover:bg-[var(--btn-subtle-bg)]"
        >
          Quit
        </button>
      </div>

      <div className="grid grid-cols-3 gap-2 rounded-lg bg-[var(--btn-subtle-border)] p-2">
        {tiles.map((value, idx) => {
          const isBlank = value === 0
          const movable = !isBlank && neighbors(blankIdx).includes(idx)
          return (
            <button
              key={idx}
              type="button"
              onClick={() => tryMove(idx)}
              disabled={isBlank || solved}
              aria-label={isBlank ? 'Blank space' : `Tile ${value}`}
              className={[
                'flex h-20 w-20 items-center justify-center rounded-md text-2xl font-bold transition sm:h-24 sm:w-24 sm:text-3xl',
                isBlank
                  ? 'bg-transparent'
                  : movable
                    ? 'border border-[var(--lagoon-deep)] bg-[var(--btn-primary-bg)] text-[var(--btn-primary-fg)] hover:brightness-110'
                    : 'border border-[var(--btn-subtle-border)] bg-[var(--btn-subtle-bg)] text-[var(--sea-ink)]',
              ].join(' ')}
            >
              {isBlank ? '' : value}
            </button>
          )
        })}
      </div>

      <p className="text-center text-xs text-[var(--sea-ink-soft)]">
        Tap a tile next to the blank — or use arrow keys. Order them 1–8.
      </p>

      {solved ? (
        <p className="text-sm font-semibold text-[var(--lagoon-deep)]">
          Solved in {moves} moves!
        </p>
      ) : null}
    </div>
  )
}
