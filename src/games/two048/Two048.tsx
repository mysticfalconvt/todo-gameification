import { useCallback, useEffect, useRef, useState } from 'react'
import type { GameProps } from '../types'

const SIZE = 4
const WIN_TILE = 1024

type Board = number[][]
type Direction = 'up' | 'down' | 'left' | 'right'

function emptyBoard(): Board {
  return Array.from({ length: SIZE }, () => Array(SIZE).fill(0))
}

function cloneBoard(b: Board): Board {
  return b.map((row) => row.slice())
}

function emptyCells(b: Board): Array<[number, number]> {
  const out: Array<[number, number]> = []
  for (let r = 0; r < SIZE; r++) {
    for (let c = 0; c < SIZE; c++) {
      if (b[r][c] === 0) out.push([r, c])
    }
  }
  return out
}

function spawn(b: Board): Board {
  const cells = emptyCells(b)
  if (cells.length === 0) return b
  const [r, c] = cells[Math.floor(Math.random() * cells.length)]
  const next = cloneBoard(b)
  // Standard 2048: 90% chance of a 2, 10% chance of a 4.
  next[r][c] = Math.random() < 0.9 ? 2 : 4
  return next
}

function newGame(): Board {
  return spawn(spawn(emptyBoard()))
}

// Slide a single row to the left, merging equal adjacent pairs once each.
function slideRowLeft(row: number[]): { row: number[]; gained: number } {
  const filtered = row.filter((v) => v !== 0)
  const merged: number[] = []
  let gained = 0
  for (let i = 0; i < filtered.length; i++) {
    if (i + 1 < filtered.length && filtered[i] === filtered[i + 1]) {
      const sum = filtered[i] * 2
      merged.push(sum)
      gained += sum
      i++
    } else {
      merged.push(filtered[i])
    }
  }
  while (merged.length < SIZE) merged.push(0)
  return { row: merged, gained }
}

function move(b: Board, dir: Direction): { board: Board; gained: number; changed: boolean } {
  let working = cloneBoard(b)
  if (dir === 'right') working = working.map((r) => r.slice().reverse())
  if (dir === 'up') working = transpose(working)
  if (dir === 'down') working = transpose(working).map((r) => r.slice().reverse())

  let gained = 0
  const next = working.map((row) => {
    const res = slideRowLeft(row)
    gained += res.gained
    return res.row
  })

  let result = next
  if (dir === 'right') result = result.map((r) => r.slice().reverse())
  if (dir === 'up') result = transpose(result)
  if (dir === 'down') result = transpose(result.map((r) => r.slice().reverse()))

  const changed = !boardsEqual(b, result)
  return { board: result, gained, changed }
}

function transpose(b: Board): Board {
  const out = emptyBoard()
  for (let r = 0; r < SIZE; r++) {
    for (let c = 0; c < SIZE; c++) {
      out[c][r] = b[r][c]
    }
  }
  return out
}

function boardsEqual(a: Board, b: Board): boolean {
  for (let r = 0; r < SIZE; r++) {
    for (let c = 0; c < SIZE; c++) {
      if (a[r][c] !== b[r][c]) return false
    }
  }
  return true
}

function canMove(b: Board): boolean {
  if (emptyCells(b).length > 0) return true
  for (let r = 0; r < SIZE; r++) {
    for (let c = 0; c < SIZE; c++) {
      const v = b[r][c]
      if (r + 1 < SIZE && b[r + 1][c] === v) return true
      if (c + 1 < SIZE && b[r][c + 1] === v) return true
    }
  }
  return false
}

function maxTile(b: Board): number {
  let m = 0
  for (const row of b) for (const v of row) if (v > m) m = v
  return m
}

const TILE_COLORS: Record<number, string> = {
  0: 'bg-[var(--surface-strong)] text-transparent',
  2: 'bg-amber-50 text-amber-900',
  4: 'bg-amber-100 text-amber-900',
  8: 'bg-orange-300 text-white',
  16: 'bg-orange-400 text-white',
  32: 'bg-orange-500 text-white',
  64: 'bg-red-500 text-white',
  128: 'bg-yellow-400 text-white',
  256: 'bg-yellow-500 text-white',
  512: 'bg-yellow-600 text-white',
  1024: 'bg-emerald-500 text-white',
  2048: 'bg-emerald-600 text-white',
  4096: 'bg-purple-600 text-white',
}

function tileClass(value: number): string {
  return TILE_COLORS[value] ?? 'bg-purple-700 text-white'
}

function tileFontSize(value: number): string {
  if (value >= 1024) return 'text-base sm:text-lg'
  if (value >= 128) return 'text-lg sm:text-xl'
  return 'text-xl sm:text-2xl'
}

export function Two048({ onFinish, onExit }: GameProps) {
  const [board, setBoard] = useState<Board>(() => newGame())
  const [score, setScore] = useState(0)
  const [done, setDone] = useState(false)
  // Win is a one-shot — we only call onFinish the first time the player hits
  // the win tile, even if they keep playing afterward. Use a ref so the
  // keyboard handler always sees the latest value.
  const winLatchedRef = useRef(false)

  const finalize = useCallback(
    (b: Board) => {
      const top = maxTile(b)
      onFinish({ won: top >= WIN_TILE, score: top })
    },
    [onFinish],
  )

  const tryMove = useCallback(
    (dir: Direction) => {
      if (done) return
      const res = move(board, dir)
      if (!res.changed) return
      const next = spawn(res.board)
      setBoard(next)
      setScore((s) => s + res.gained)

      const top = maxTile(next)
      if (top >= WIN_TILE && !winLatchedRef.current) {
        winLatchedRef.current = true
        setDone(true)
        setTimeout(() => finalize(next), 600)
        return
      }
      if (!canMove(next)) {
        setDone(true)
        setTimeout(() => finalize(next), 800)
      }
    },
    [board, done, finalize],
  )

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.metaKey || e.ctrlKey || e.altKey) return
      const map: Record<string, Direction> = {
        ArrowUp: 'up',
        ArrowDown: 'down',
        ArrowLeft: 'left',
        ArrowRight: 'right',
        w: 'up',
        s: 'down',
        a: 'left',
        d: 'right',
      }
      const dir = map[e.key]
      if (!dir) return
      e.preventDefault()
      tryMove(dir)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [tryMove])

  // Touch swipe support — the on-screen buttons handle taps, but a swipe on
  // the board itself is the natural gesture on mobile.
  const touchRef = useRef<{ x: number; y: number } | null>(null)
  function onTouchStart(e: React.TouchEvent) {
    const t = e.touches[0]
    touchRef.current = { x: t.clientX, y: t.clientY }
  }
  function onTouchEnd(e: React.TouchEvent) {
    const start = touchRef.current
    touchRef.current = null
    if (!start) return
    const t = e.changedTouches[0]
    const dx = t.clientX - start.x
    const dy = t.clientY - start.y
    const ax = Math.abs(dx)
    const ay = Math.abs(dy)
    if (Math.max(ax, ay) < 24) return
    if (ax > ay) tryMove(dx > 0 ? 'right' : 'left')
    else tryMove(dy > 0 ? 'down' : 'up')
  }

  const top = maxTile(board)
  const stuck = !canMove(board)

  return (
    <div className="flex flex-col items-center gap-4">
      <div className="flex w-full items-center justify-between text-sm">
        <span>Score: {score}</span>
        <span className="text-[var(--sea-ink-soft)]">Best tile: {top}</span>
        <button
          type="button"
          onClick={onExit}
          className="rounded border border-[var(--btn-subtle-border)] px-2 py-1 text-xs hover:bg-[var(--btn-subtle-bg)]"
        >
          Quit
        </button>
      </div>

      <div
        className="grid grid-cols-4 gap-2 rounded-lg bg-[var(--line)] p-2 select-none"
        onTouchStart={onTouchStart}
        onTouchEnd={onTouchEnd}
      >
        {board.flatMap((row, r) =>
          row.map((value, c) => (
            <div
              key={`${r}-${c}`}
              className={[
                'flex h-16 w-16 items-center justify-center rounded-md border border-[var(--line)] font-bold transition sm:h-20 sm:w-20',
                tileClass(value),
                tileFontSize(value),
              ].join(' ')}
              aria-label={value === 0 ? 'Empty cell' : `Tile ${value}`}
            >
              {value === 0 ? '' : value}
            </div>
          )),
        )}
      </div>

      <div className="grid w-40 grid-cols-3 gap-1 text-lg">
        <div />
        <button
          type="button"
          onClick={() => tryMove('up')}
          aria-label="Up"
          className="rounded border border-[var(--btn-subtle-border)] py-2 hover:bg-[var(--btn-subtle-bg)]"
        >
          ↑
        </button>
        <div />
        <button
          type="button"
          onClick={() => tryMove('left')}
          aria-label="Left"
          className="rounded border border-[var(--btn-subtle-border)] py-2 hover:bg-[var(--btn-subtle-bg)]"
        >
          ←
        </button>
        <button
          type="button"
          onClick={() => tryMove('down')}
          aria-label="Down"
          className="rounded border border-[var(--btn-subtle-border)] py-2 hover:bg-[var(--btn-subtle-bg)]"
        >
          ↓
        </button>
        <button
          type="button"
          onClick={() => tryMove('right')}
          aria-label="Right"
          className="rounded border border-[var(--btn-subtle-border)] py-2 hover:bg-[var(--btn-subtle-bg)]"
        >
          →
        </button>
      </div>

      <p className="text-center text-xs text-[var(--sea-ink-soft)]">
        Arrow keys / WASD / swipe. Reach 1024 to win.
      </p>

      {top >= WIN_TILE ? (
        <p className="text-sm font-semibold text-[var(--lagoon-deep)]">
          You hit {top}!
        </p>
      ) : stuck ? (
        <p className="text-sm font-semibold text-red-600">
          No moves left. Best tile: {top}.
        </p>
      ) : null}
    </div>
  )
}
