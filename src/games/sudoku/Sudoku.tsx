import { useCallback, useEffect, useMemo, useState } from 'react'
import type { GameProps } from '../types'
import { pickRandomPuzzle } from './puzzles'
import {
  boardIsComplete,
  givenMask,
  isPeer,
  parseBoard,
  solutionDigitAt,
  type Board,
} from './logic'

type Difficulty = 'easy' | 'hard'
type Phase = 'choose' | 'playing' | 'won' | 'lost'

const MISTAKE_LIMIT = 3
const HINT_LIMIT = 3
const MISTAKE_TIME_PENALTY = 30
const WIN_DISMISS_MS = 800
const LOSS_DISMISS_MS = 1400
const WRONG_FLASH_MS = 350

function pad2(n: number): string {
  return String(n).padStart(2, '0')
}

function formatTime(seconds: number): string {
  const m = Math.floor(seconds / 60)
  const s = seconds % 60
  return `${m}:${pad2(s)}`
}

export function Sudoku({ onFinish, onExit }: GameProps) {
  const [phase, setPhase] = useState<Phase>('choose')
  const [difficulty, setDifficulty] = useState<Difficulty | null>(null)
  const [solution, setSolution] = useState<string | null>(null)
  const [board, setBoard] = useState<Board>(() => parseBoard('.'.repeat(81)))
  const [given, setGiven] = useState<boolean[][]>(() =>
    Array.from({ length: 9 }, () => Array(9).fill(false)),
  )
  const [selected, setSelected] = useState<{ row: number; col: number } | null>(
    null,
  )
  const [mistakes, setMistakes] = useState(0)
  const [hintsUsed, setHintsUsed] = useState(0)
  const [startedAt, setStartedAt] = useState<number | null>(null)
  const [finishedAt, setFinishedAt] = useState<number | null>(null)
  const [tick, setTick] = useState(0)
  const [wrongFlash, setWrongFlash] = useState<{
    row: number
    col: number
  } | null>(null)

  const elapsedSec = useMemo(() => {
    if (!startedAt) return 0
    const end = finishedAt ?? startedAt + tick * 1000
    return Math.max(0, Math.floor((end - startedAt) / 1000))
  }, [startedAt, finishedAt, tick])

  // Drive the live timer at 1Hz while playing. Stops when the run finishes.
  useEffect(() => {
    if (phase !== 'playing' || startedAt === null) return
    const id = window.setInterval(() => {
      setTick(Math.floor((Date.now() - startedAt) / 1000))
    }, 250)
    return () => window.clearInterval(id)
  }, [phase, startedAt])

  // Clear the wrong-entry flash after a short delay.
  useEffect(() => {
    if (!wrongFlash) return
    const id = window.setTimeout(() => setWrongFlash(null), WRONG_FLASH_MS)
    return () => window.clearTimeout(id)
  }, [wrongFlash])

  const chooseDifficulty = useCallback((d: Difficulty) => {
    const pair = pickRandomPuzzle(d)
    setDifficulty(d)
    setSolution(pair.solution)
    setBoard(parseBoard(pair.puzzle))
    setGiven(givenMask(pair.puzzle))
    setMistakes(0)
    setHintsUsed(0)
    setStartedAt(null)
    setFinishedAt(null)
    setTick(0)
    setSelected(null)
    setPhase('playing')
  }, [])

  // Drop a digit into the selected cell. Right value commits; wrong value
  // is rejected (flashes red) and counts toward the 3-mistake limit. We do
  // not commit wrong values because the visual peer/same-digit highlight
  // assumes the board only ever holds correct entries.
  const enterDigit = useCallback(
    (digit: number) => {
      if (phase !== 'playing' || !selected || !solution) return
      const { row, col } = selected
      if (given[row][col]) return
      if (board[row][col] !== null) return
      if (startedAt === null) setStartedAt(Date.now())
      const correct = solutionDigitAt(solution, row, col)
      if (digit === correct) {
        const next = board.map((r) => r.slice())
        next[row][col] = digit
        setBoard(next)
        if (boardIsComplete(next)) {
          setFinishedAt(Date.now())
          setPhase('won')
        }
      } else {
        setWrongFlash({ row, col })
        const nextMistakes = mistakes + 1
        setMistakes(nextMistakes)
        if (nextMistakes >= MISTAKE_LIMIT) {
          setFinishedAt(Date.now())
          setPhase('lost')
        }
      }
    },
    [phase, selected, given, board, solution, startedAt, mistakes],
  )

  // Hints reveal one blank cell's correct value. They don't add to the
  // mistake counter or the composite score, but they cost XP — handled in
  // index.ts via the `hints` meta field. Capped at HINT_LIMIT per run.
  const useHint = useCallback(() => {
    if (phase !== 'playing' || !solution) return
    if (hintsUsed >= HINT_LIMIT) return
    // Prefer the currently selected cell if it's a blank non-given slot;
    // otherwise pick a random blank cell so the user doesn't have to
    // select first.
    let target: { row: number; col: number } | null = null
    if (
      selected &&
      !given[selected.row][selected.col] &&
      board[selected.row][selected.col] === null
    ) {
      target = selected
    } else {
      const blanks: { row: number; col: number }[] = []
      for (let r = 0; r < 9; r++) {
        for (let c = 0; c < 9; c++) {
          if (!given[r][c] && board[r][c] === null) blanks.push({ row: r, col: c })
        }
      }
      if (blanks.length === 0) return
      target = blanks[Math.floor(Math.random() * blanks.length)]
    }
    if (startedAt === null) setStartedAt(Date.now())
    const digit = solutionDigitAt(solution, target.row, target.col)
    const next = board.map((r) => r.slice())
    next[target.row][target.col] = digit
    setBoard(next)
    setHintsUsed(hintsUsed + 1)
    setSelected(target)
    if (boardIsComplete(next)) {
      setFinishedAt(Date.now())
      setPhase('won')
    }
  }, [phase, solution, hintsUsed, selected, given, board, startedAt])

  // Keyboard support: digit keys 1-9 enter, arrow keys move selection.
  useEffect(() => {
    if (phase !== 'playing') return
    function onKey(e: KeyboardEvent) {
      if (e.metaKey || e.ctrlKey || e.altKey) return
      if (e.key >= '1' && e.key <= '9') {
        e.preventDefault()
        enterDigit(Number(e.key))
        return
      }
      if (!selected) return
      if (e.key === 'ArrowUp') {
        e.preventDefault()
        setSelected({ row: Math.max(0, selected.row - 1), col: selected.col })
      } else if (e.key === 'ArrowDown') {
        e.preventDefault()
        setSelected({ row: Math.min(8, selected.row + 1), col: selected.col })
      } else if (e.key === 'ArrowLeft') {
        e.preventDefault()
        setSelected({ row: selected.row, col: Math.max(0, selected.col - 1) })
      } else if (e.key === 'ArrowRight') {
        e.preventDefault()
        setSelected({ row: selected.row, col: Math.min(8, selected.col + 1) })
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [phase, selected, enterDigit])

  // Hand the run back to the arcade host after a short pause so the player
  // sees the final state. Score = seconds + 30s per mistake on win; null
  // on loss so it never beats a personal best.
  useEffect(() => {
    if (!difficulty) return
    if (phase === 'won') {
      const score = elapsedSec + MISTAKE_TIME_PENALTY * mistakes
      const t = window.setTimeout(
        () =>
          onFinish({
            won: true,
            score,
            meta: {
              difficulty,
              seconds: elapsedSec,
              mistakes,
              hints: hintsUsed,
            },
          }),
        WIN_DISMISS_MS,
      )
      return () => window.clearTimeout(t)
    }
    if (phase === 'lost') {
      const t = window.setTimeout(
        () =>
          onFinish({
            won: false,
            score: null,
            meta: {
              difficulty,
              seconds: elapsedSec,
              mistakes: MISTAKE_LIMIT,
              hints: hintsUsed,
            },
          }),
        LOSS_DISMISS_MS,
      )
      return () => window.clearTimeout(t)
    }
  }, [phase, difficulty, elapsedSec, mistakes, hintsUsed, onFinish])

  if (phase === 'choose') {
    return (
      <div className="flex flex-col items-center gap-4 py-6">
        <h2 className="text-lg font-semibold text-[var(--sea-ink)]">
          Pick a difficulty
        </h2>
        <p className="max-w-sm text-center text-xs text-[var(--sea-ink-soft)]">
          Three mistakes ends the run. Score is your solve time + 30s per
          mistake; lower wins. Up to 3 hints per run — each one reduces XP.
          Easy and Hard have separate leaderboards.
        </p>
        <div className="flex w-full max-w-sm flex-col gap-3">
          <button
            type="button"
            onClick={() => chooseDifficulty('easy')}
            className="rounded-xl border border-[var(--btn-subtle-border)] bg-[var(--btn-subtle-bg)] px-4 py-3 text-left transition hover:bg-[var(--option-bg)]"
          >
            <p className="font-semibold text-[var(--sea-ink)]">Easy</p>
            <p className="text-xs text-[var(--sea-ink-soft)]">
              Lots of clues, fast warmup. Up to 30 XP (−6 per mistake or hint).
            </p>
          </button>
          <button
            type="button"
            onClick={() => chooseDifficulty('hard')}
            className="rounded-xl border border-[var(--btn-subtle-border)] bg-[var(--btn-subtle-bg)] px-4 py-3 text-left transition hover:bg-[var(--option-bg)]"
          >
            <p className="font-semibold text-[var(--sea-ink)]">Hard</p>
            <p className="text-xs text-[var(--sea-ink-soft)]">
              Sparser clues, max XP. Up to 60 XP (−10 per mistake or hint).
            </p>
          </button>
        </div>
        <button
          type="button"
          onClick={onExit}
          className="mt-2 rounded border border-[var(--btn-subtle-border)] px-3 py-1 text-xs hover:bg-[var(--btn-subtle-bg)]"
        >
          Back
        </button>
      </div>
    )
  }

  const selectedDigit =
    selected && board[selected.row][selected.col] !== null
      ? board[selected.row][selected.col]
      : null

  return (
    <div className="flex flex-col items-center gap-4">
      <div className="flex w-full max-w-md items-center justify-between text-sm">
        <div className="flex items-center gap-3">
          <span className="rounded-full bg-[var(--btn-subtle-bg)] px-2 py-0.5 text-xs font-semibold uppercase tracking-wide text-[var(--sea-ink)]">
            {difficulty}
          </span>
          <span className="tabular-nums text-[var(--sea-ink)]">
            {formatTime(elapsedSec)}
          </span>
          <span
            className={`tabular-nums ${
              mistakes >= 2 ? 'text-red-600' : 'text-[var(--sea-ink-soft)]'
            }`}
          >
            Mistakes: {mistakes}/{MISTAKE_LIMIT}
          </span>
        </div>
        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={useHint}
            disabled={phase !== 'playing' || hintsUsed >= HINT_LIMIT}
            className="rounded border border-[var(--btn-subtle-border)] px-2 py-1 text-xs text-[var(--sea-ink)] hover:bg-[var(--btn-subtle-bg)] disabled:opacity-40"
          >
            💡 Hint ({HINT_LIMIT - hintsUsed})
          </button>
          <button
            type="button"
            onClick={() =>
              onFinish({
                won: false,
                score: null,
                meta: {
                  difficulty,
                  seconds: elapsedSec,
                  mistakes,
                  hints: hintsUsed,
                },
              })
            }
            className="rounded border border-[var(--btn-subtle-border)] px-2 py-1 text-xs hover:bg-[var(--btn-subtle-bg)]"
          >
            Quit
          </button>
        </div>
      </div>

      <div className="grid grid-cols-9 overflow-hidden rounded-md border-2 border-[var(--sea-ink-soft)]">
        {Array.from({ length: 9 }, (_, row) =>
          Array.from({ length: 9 }, (_, col) => {
            const value = board[row][col]
            const isGiven = given[row][col]
            const isSelected =
              selected?.row === row && selected?.col === col
            const isHighlighted =
              selected !== null && isPeer(selected.row, selected.col, row, col)
            const sameDigit =
              selectedDigit !== null &&
              value === selectedDigit &&
              !isSelected
            const isWrongFlash =
              wrongFlash?.row === row && wrongFlash?.col === col

            // 1px between every cell, 2px between 3x3 bands. Single color
            // (--sea-ink-soft) which adapts to dark mode.
            const rightBorder =
              col === 8
                ? ''
                : col % 3 === 2
                  ? 'border-r-2'
                  : 'border-r'
            const bottomBorder =
              row === 8
                ? ''
                : row % 3 === 2
                  ? 'border-b-2'
                  : 'border-b'

            // Cell bg uses --surface-strong so it adapts to dark mode (light
            // text on a light cell was washed out before). Overlays are
            // lagoon-teal at varying alpha so they pop on both surfaces.
            let bg = 'bg-[var(--surface-strong)]'
            if (isWrongFlash) bg = 'bg-[rgba(239,68,68,0.45)]'
            else if (isSelected) bg = 'bg-[rgba(79,184,178,0.55)]'
            else if (sameDigit) bg = 'bg-[rgba(79,184,178,0.18)]'
            else if (isHighlighted) bg = 'bg-[rgba(79,184,178,0.06)]'

            const textColor = isGiven
              ? 'text-[var(--sea-ink)]'
              : 'text-[var(--lagoon-deep)] font-semibold'

            return (
              <button
                key={`${row}-${col}`}
                type="button"
                onClick={() => {
                  if (isGiven || phase !== 'playing') return
                  // Click the already-selected cell to deselect.
                  setSelected(isSelected ? null : { row, col })
                }}
                disabled={phase !== 'playing'}
                className={[
                  'flex h-9 w-9 items-center justify-center border-[var(--sea-ink-soft)] text-base tabular-nums transition sm:h-11 sm:w-11 sm:text-lg',
                  bg,
                  textColor,
                  rightBorder,
                  bottomBorder,
                ].join(' ')}
              >
                {value ?? ''}
              </button>
            )
          }),
        )}
      </div>

      <div className="flex w-full max-w-md flex-wrap justify-center gap-1.5">
        {[1, 2, 3, 4, 5, 6, 7, 8, 9].map((d) => (
          <button
            key={d}
            type="button"
            onClick={() => enterDigit(d)}
            disabled={phase !== 'playing' || !selected}
            className="flex h-12 w-12 items-center justify-center rounded-md border border-[var(--btn-subtle-border)] bg-[var(--btn-subtle-bg)] text-lg font-semibold text-[var(--sea-ink)] transition hover:bg-[var(--option-bg)] disabled:opacity-50 sm:h-14 sm:w-14 sm:text-xl"
          >
            {d}
          </button>
        ))}
      </div>

      {phase === 'won' ? (
        <p className="text-sm font-semibold text-[var(--lagoon-deep)]">
          Solved in {formatTime(elapsedSec)}
          {mistakes > 0 ? ` (+${mistakes * MISTAKE_TIME_PENALTY}s penalty)` : ''}!
        </p>
      ) : null}
      {phase === 'lost' ? (
        <p className="text-sm font-semibold text-red-600">
          3 mistakes — run over.
        </p>
      ) : null}
    </div>
  )
}
