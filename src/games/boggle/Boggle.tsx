import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { GameProps } from '../types'
import {
  BOARD_SIZE,
  adjacent,
  generateBoard,
  scoreForLength,
  tileLetters,
  type Tile,
} from './board'

const ROUND_SECONDS = 180
const MIN_LETTERS = 3

// Module-level cache so re-mounting the game (or replaying) doesn't refetch
// the ~80k-word list. Resolves to an uppercase Set.
let dictPromise: Promise<Set<string>> | null = null
function loadDictionary(): Promise<Set<string>> {
  if (!dictPromise) {
    dictPromise = fetch('/boggle-words.txt')
      .then((r) => r.text())
      .then(
        (text) =>
          new Set(
            text
              .split('\n')
              .map((w) => w.trim())
              .filter(Boolean),
          ),
      )
      .catch((err) => {
        // Let a failed load retry on the next mount rather than caching a reject.
        dictPromise = null
        throw err
      })
  }
  return dictPromise
}

function classNames(...parts: Array<string | false | null | undefined>): string {
  return parts.filter(Boolean).join(' ')
}

function formatClock(total: number): string {
  const m = Math.floor(total / 60)
  const s = total % 60
  return `${m}:${String(s).padStart(2, '0')}`
}

export function Boggle({ onFinish, onExit }: GameProps) {
  const [board] = useState<Tile[]>(() => generateBoard())
  const [dict, setDict] = useState<Set<string> | null>(null)
  const [dictError, setDictError] = useState(false)
  const [path, setPath] = useState<number[]>([])
  const [found, setFound] = useState<string[]>([])
  const [score, setScore] = useState(0)
  const [timeLeft, setTimeLeft] = useState(ROUND_SECONDS)
  const [flash, setFlash] = useState<'ok' | 'bad' | 'dupe' | null>(null)

  const foundSet = useMemo(() => new Set(found), [found])
  const finishedRef = useRef(false)

  // ---- Dictionary load ----
  useEffect(() => {
    let alive = true
    loadDictionary()
      .then((d) => alive && setDict(d))
      .catch(() => alive && setDictError(true))
    return () => {
      alive = false
    }
  }, [])

  // ---- Current candidate word from the traced path ----
  const word = useMemo(
    () => path.map((i) => tileLetters(board[i])).join(''),
    [path, board],
  )

  // ---- Finish (latched: fires once) ----
  const finish = useCallback(
    (finalScore: number, words: string[]) => {
      if (finishedRef.current) return
      finishedRef.current = true
      const longest = words.reduce((max, w) => Math.max(max, w.length), 0)
      onFinish({
        won: words.length > 0,
        score: finalScore,
        meta: { words, longest },
      })
    },
    [onFinish],
  )

  // ---- Timer ----
  useEffect(() => {
    if (dict === null) return // don't start the clock until playable
    const id = window.setInterval(() => {
      setTimeLeft((t) => {
        if (t <= 1) {
          window.clearInterval(id)
          return 0
        }
        return t - 1
      })
    }, 1000)
    return () => window.clearInterval(id)
  }, [dict])

  // Fire onFinish when the clock hits 0. Reads latest score/found via state.
  useEffect(() => {
    if (timeLeft === 0) finish(score, found)
  }, [timeLeft, score, found, finish])

  // ---- Flash auto-clear ----
  useEffect(() => {
    if (!flash) return
    const t = window.setTimeout(() => setFlash(null), 600)
    return () => window.clearTimeout(t)
  }, [flash])

  const over = timeLeft === 0 || dict === null

  // ---- Tile interaction: tap to build a path ----
  const tapTile = useCallback(
    (i: number) => {
      if (over) return
      setPath((prev) => {
        const pos = prev.indexOf(i)
        if (pos !== -1) {
          // Re-tapping a tile already in the path backtracks to it.
          return prev.slice(0, pos + 1)
        }
        if (prev.length === 0) return [i]
        const last = prev[prev.length - 1]
        if (adjacent(last, i)) return [...prev, i]
        return prev // non-adjacent: ignore (use Clear to restart)
      })
    },
    [over],
  )

  const clearPath = useCallback(() => setPath([]), [])

  const submit = useCallback(() => {
    if (over || dict === null) return
    if (word.length < MIN_LETTERS) {
      setFlash('bad')
      setPath([])
      return
    }
    if (foundSet.has(word)) {
      setFlash('dupe')
      setPath([])
      return
    }
    if (!dict.has(word)) {
      setFlash('bad')
      setPath([])
      return
    }
    // Adjacency + no-reuse are guaranteed by how the path is built.
    setFound((prev) => [...prev, word])
    setScore((s) => s + scoreForLength(word.length))
    setFlash('ok')
    setPath([])
  }, [over, dict, word, foundSet])

  // ---- Keyboard: Enter submits, Backspace pops the last tile ----
  useEffect(() => {
    if (over) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Enter') {
        e.preventDefault()
        submit()
      } else if (e.key === 'Backspace') {
        e.preventDefault()
        setPath((prev) => prev.slice(0, -1))
      } else if (e.key === 'Escape') {
        e.preventDefault()
        clearPath()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [over, submit, clearPath])

  // ---- Render ----
  if (dictError) {
    return (
      <div className="flex flex-col items-center gap-4 py-12">
        <p className="text-sm text-[var(--sea-ink-soft)]">
          Couldn't load the word list. Check your connection and try again.
        </p>
        <button
          type="button"
          onClick={onExit}
          className="rounded-full border border-[var(--btn-subtle-border)] px-4 py-2 text-sm hover:bg-[var(--btn-subtle-bg)]"
        >
          Back to arcade
        </button>
      </div>
    )
  }

  if (dict === null) {
    return (
      <div className="flex flex-col items-center gap-3 py-12">
        <p className="text-sm text-[var(--sea-ink-soft)]">Loading dictionary…</p>
      </div>
    )
  }

  return (
    <div className="flex flex-col items-center gap-4">
      <div className="flex w-full max-w-md items-center justify-between text-sm">
        <span className="font-semibold text-[var(--sea-ink)]">
          🏆 {score} {score === 1 ? 'pt' : 'pts'}
        </span>
        <span
          className={classNames(
            'font-mono font-semibold tabular-nums',
            timeLeft <= 10
              ? 'text-red-600'
              : 'text-[var(--sea-ink)]',
          )}
          aria-label={`${timeLeft} seconds left`}
        >
          ⏱ {formatClock(timeLeft)}
        </span>
        <button
          type="button"
          onClick={() => finish(score, found)}
          className="rounded border border-[var(--btn-subtle-border)] px-2 py-1 text-xs hover:bg-[var(--btn-subtle-bg)]"
        >
          {over ? 'Done' : 'End'}
        </button>
      </div>

      {/* Current word / status line */}
      <div
        className={classNames(
          'flex h-9 w-full max-w-md items-center justify-center rounded-md border px-3 text-lg font-bold uppercase tracking-[0.2em] transition',
          flash === 'ok'
            ? 'border-green-700 bg-green-600 text-white'
            : flash === 'bad'
              ? 'border-red-600 bg-red-500 text-white'
              : flash === 'dupe'
                ? 'border-amber-500 bg-amber-400 text-[var(--sea-ink)]'
                : 'border-[var(--btn-subtle-border)] bg-[var(--option-bg)] text-[var(--sea-ink)]',
        )}
        aria-live="polite"
      >
        {flash === 'dupe'
          ? 'Already found'
          : word || (over ? "Time's up!" : '')}
      </div>

      <div
        className="grid w-full max-w-md select-none gap-2"
        style={{ gridTemplateColumns: `repeat(${BOARD_SIZE}, minmax(0, 1fr))` }}
      >
        {board.map((tile, i) => {
          const order = path.indexOf(i)
          const inPath = order !== -1
          const isLast = inPath && order === path.length - 1
          return (
            <button
              key={i}
              type="button"
              disabled={over}
              onClick={() => tapTile(i)}
              aria-label={`${tile.face}${inPath ? `, selected position ${order + 1}` : ''}`}
              className={classNames(
                'flex aspect-square items-center justify-center rounded-lg border text-xl font-bold uppercase transition sm:text-2xl',
                isLast
                  ? 'border-[var(--lagoon-deep)] bg-[var(--lagoon-deep)] text-white ring-2 ring-[var(--lagoon-deep)]'
                  : inPath
                    ? 'border-[var(--lagoon-deep)] bg-[rgba(79,184,178,0.25)] text-[var(--sea-ink)]'
                    : 'border-[var(--btn-subtle-border)] bg-[var(--btn-subtle-bg)] text-[var(--sea-ink)]',
              )}
            >
              {tile.face}
            </button>
          )
        })}
      </div>

      <div className="flex w-full max-w-md gap-2">
        <button
          type="button"
          disabled={over || path.length === 0}
          onClick={submit}
          className="flex-1 rounded-full bg-[var(--btn-primary-bg)] px-4 py-2 text-sm font-semibold text-[var(--btn-primary-fg)] disabled:opacity-50"
        >
          Submit
        </button>
        <button
          type="button"
          disabled={over || path.length === 0}
          onClick={clearPath}
          className="rounded-full border border-[var(--btn-subtle-border)] px-4 py-2 text-sm font-semibold text-[var(--sea-ink)] hover:bg-[var(--btn-subtle-bg)] disabled:opacity-50"
        >
          Clear
        </button>
      </div>

      <div className="w-full max-w-md">
        <p className="mb-1 text-xs text-[var(--sea-ink-soft)]">
          {found.length} {found.length === 1 ? 'word' : 'words'} found
        </p>
        {found.length > 0 ? (
          <ul className="flex flex-wrap gap-1.5 text-xs">
            {[...found].reverse().map((w) => (
              <li
                key={w}
                className="rounded border border-[var(--btn-subtle-border)] px-2 py-0.5 font-semibold uppercase tracking-wide text-[var(--sea-ink)]"
              >
                {w}
                <span className="ml-1 text-[var(--sea-ink-soft)]">
                  +{scoreForLength(w.length)}
                </span>
              </li>
            ))}
          </ul>
        ) : (
          <p className="text-xs text-[var(--sea-ink-soft)]">
            Tap adjacent letters (3+) to trace a word, then Submit. “Qu” counts
            as two letters.
          </p>
        )}
      </div>
    </div>
  )
}
