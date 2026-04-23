import { useCallback, useEffect, useMemo, useState } from 'react'
import { startWordleGame } from '../../server/functions/wordle'
import type { GameProps } from '../types'

const WORD_LENGTH = 5
const MAX_GUESSES = 6

type LetterState = 'correct' | 'present' | 'absent'

function scoreGuess(guess: string, answer: string): LetterState[] {
  const states: LetterState[] = Array(WORD_LENGTH).fill('absent')
  const answerChars = answer.split('')
  const consumed = Array(WORD_LENGTH).fill(false)
  for (let i = 0; i < WORD_LENGTH; i++) {
    if (guess[i] === answerChars[i]) {
      states[i] = 'correct'
      consumed[i] = true
    }
  }
  for (let i = 0; i < WORD_LENGTH; i++) {
    if (states[i] === 'correct') continue
    for (let j = 0; j < WORD_LENGTH; j++) {
      if (!consumed[j] && guess[i] === answerChars[j]) {
        states[i] = 'present'
        consumed[j] = true
        break
      }
    }
  }
  return states
}

const STATE_RANK: Record<LetterState, number> = {
  absent: 1,
  present: 2,
  correct: 3,
}

const KEYBOARD_ROWS: string[][] = [
  ['Q', 'W', 'E', 'R', 'T', 'Y', 'U', 'I', 'O', 'P'],
  ['A', 'S', 'D', 'F', 'G', 'H', 'J', 'K', 'L'],
  ['ENTER', 'Z', 'X', 'C', 'V', 'B', 'N', 'M', 'BACK'],
]

function stateClasses(state: LetterState | undefined, hasLetter: boolean): string {
  if (state === 'correct') return 'border-green-600 bg-green-600 text-white'
  if (state === 'present') return 'border-amber-500 bg-amber-500 text-white'
  if (state === 'absent') return 'border-neutral-500 bg-neutral-500 text-white'
  if (hasLetter)
    return 'border-[var(--lagoon-deep)] bg-[var(--btn-subtle-bg)] text-[var(--sea-ink)]'
  return 'border-[var(--btn-subtle-border)] text-[var(--sea-ink)]'
}

export function Wordle({ onFinish, onExit }: GameProps) {
  // Fetch a fresh unseen word per mount — arcade re-mounts the component
  // for each play, so react-query caching would (incorrectly) serve the
  // same word twice in a row.
  const [answer, setAnswer] = useState<string | null>(null)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    let cancelled = false
    setLoading(true)
    startWordleGame()
      .then((res) => {
        if (cancelled) return
        setAnswer(res.word)
        setLoading(false)
      })
      .catch((err) => {
        if (cancelled) return
        setLoadError(
          err instanceof Error ? err.message : 'Could not start game',
        )
        setLoading(false)
      })
    return () => {
      cancelled = true
    }
  }, [])

  const [guesses, setGuesses] = useState<string[]>([])
  const [current, setCurrent] = useState('')
  const [shake, setShake] = useState(false)

  const won = answer !== null && guesses[guesses.length - 1] === answer
  const finished = won || guesses.length >= MAX_GUESSES

  const letterStates = useMemo(() => {
    if (!answer) return {} as Record<string, LetterState>
    const map: Record<string, LetterState> = {}
    for (const g of guesses) {
      const states = scoreGuess(g, answer)
      for (let i = 0; i < WORD_LENGTH; i++) {
        const prev = map[g[i]]
        const next = states[i]
        if (!prev || STATE_RANK[next] > STATE_RANK[prev]) map[g[i]] = next
      }
    }
    return map
  }, [guesses, answer])

  const press = useCallback(
    (key: string) => {
      if (!answer || finished) return
      if (key === 'ENTER') {
        if (current.length !== WORD_LENGTH) {
          setShake(true)
          window.setTimeout(() => setShake(false), 350)
          return
        }
        setGuesses((prev) => [...prev, current])
        setCurrent('')
        return
      }
      if (key === 'BACK') {
        setCurrent((s) => s.slice(0, -1))
        return
      }
      if (/^[A-Z]$/.test(key) && current.length < WORD_LENGTH) {
        setCurrent((s) => s + key)
      }
    },
    [answer, current, finished],
  )

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.metaKey || e.ctrlKey || e.altKey) return
      if (e.key === 'Enter') {
        e.preventDefault()
        press('ENTER')
        return
      }
      if (e.key === 'Backspace') {
        e.preventDefault()
        press('BACK')
        return
      }
      const k = e.key.toUpperCase()
      if (k.length === 1 && k >= 'A' && k <= 'Z') {
        e.preventDefault()
        press(k)
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [press])

  useEffect(() => {
    if (!answer) return
    if (won) {
      const t = window.setTimeout(
        () =>
          onFinish({
            won: true,
            score: guesses.length,
            meta: { word: answer },
          }),
        700,
      )
      return () => window.clearTimeout(t)
    }
    if (finished) {
      const t = window.setTimeout(
        () =>
          onFinish({
            won: false,
            score: guesses.length,
            meta: { word: answer },
          }),
        1600,
      )
      return () => window.clearTimeout(t)
    }
  }, [won, finished, guesses.length, answer, onFinish])

  if (loading) {
    return (
      <div className="flex flex-col items-center gap-3 py-8">
        <p className="text-sm text-[var(--sea-ink-soft)]">Loading word…</p>
      </div>
    )
  }
  if (loadError || !answer) {
    return (
      <div className="flex flex-col items-center gap-3 py-8">
        <p className="text-sm font-semibold text-red-600">
          {loadError ?? 'Could not start game'}
        </p>
        <button
          type="button"
          onClick={onExit}
          className="rounded border border-[var(--btn-subtle-border)] px-3 py-1 text-xs hover:bg-[var(--btn-subtle-bg)]"
        >
          Back
        </button>
      </div>
    )
  }

  const rows = Array.from({ length: MAX_GUESSES }, (_, r) => r)

  return (
    <div className="flex flex-col items-center gap-4">
      <div className="flex w-full items-center justify-between text-sm">
        <span>
          Guess {Math.min(guesses.length + 1, MAX_GUESSES)}/{MAX_GUESSES}
        </span>
        <button
          type="button"
          onClick={() =>
            // Marks the word as seen even on quit so the player can't
            // re-roll the same word repeatedly to dodge hard ones.
            onFinish({ won: false, score: null, meta: { word: answer } })
          }
          className="rounded border border-[var(--btn-subtle-border)] px-2 py-1 text-xs hover:bg-[var(--btn-subtle-bg)]"
        >
          Quit
        </button>
      </div>

      <div className="flex flex-col gap-1.5">
        {rows.map((r) => {
          const isCurrentRow = r === guesses.length
          const rowText = guesses[r] ?? (isCurrentRow ? current : '')
          const states = guesses[r] ? scoreGuess(guesses[r], answer) : null
          const shakeCls = isCurrentRow && shake ? 'animate-pulse' : ''
          return (
            <div key={r} className={`flex gap-1.5 ${shakeCls}`}>
              {Array.from({ length: WORD_LENGTH }, (_, i) => {
                const ch = rowText[i] ?? ''
                const state = states?.[i]
                return (
                  <div
                    key={i}
                    aria-label={ch ? `Letter ${ch}` : 'Empty slot'}
                    className={[
                      'flex h-12 w-12 items-center justify-center rounded-md border text-xl font-bold uppercase transition sm:h-14 sm:w-14 sm:text-2xl',
                      stateClasses(state, Boolean(ch)),
                    ].join(' ')}
                  >
                    {ch}
                  </div>
                )
              })}
            </div>
          )
        })}
      </div>

      <div className="flex w-full max-w-md flex-col gap-1.5">
        {KEYBOARD_ROWS.map((row, rowIdx) => (
          <div key={rowIdx} className="flex justify-center gap-1">
            {row.map((key) => {
              const state = letterStates[key]
              const wide = key === 'ENTER' || key === 'BACK'
              return (
                <button
                  key={key}
                  type="button"
                  onClick={() => press(key)}
                  disabled={finished}
                  className={[
                    'rounded-md py-3 font-semibold uppercase transition disabled:opacity-50',
                    wide ? 'px-3 text-[10px] flex-[1.5]' : 'flex-1 text-xs',
                    stateClasses(state, true),
                  ].join(' ')}
                >
                  {key === 'BACK' ? '⌫' : key}
                </button>
              )
            })}
          </div>
        ))}
      </div>

      {finished && !won ? (
        <p className="text-sm font-semibold text-red-600">
          Out of guesses. Answer: <span className="uppercase">{answer}</span>
        </p>
      ) : null}
      {won ? (
        <p className="text-sm font-semibold text-[var(--lagoon-deep)]">
          Solved in {guesses.length}!
        </p>
      ) : null}
    </div>
  )
}
