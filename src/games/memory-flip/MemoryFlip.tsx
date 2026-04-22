import { useEffect, useMemo, useState } from 'react'
import type { GameProps } from '../types'

const SYMBOLS = ['🌊', '🐚', '🐠', '⭐', '🌴', '⚓']
const MAX_MISTAKES = 6

type Card = {
  id: number
  symbol: string
  matched: boolean
}

function shuffle<T>(arr: T[]): T[] {
  const out = arr.slice()
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1))
    ;[out[i], out[j]] = [out[j], out[i]]
  }
  return out
}

function buildDeck(): Card[] {
  const pairs = SYMBOLS.flatMap((s) => [s, s])
  return shuffle(pairs).map((symbol, id) => ({ id, symbol, matched: false }))
}

export function MemoryFlip({ onFinish, onExit }: GameProps) {
  const [cards, setCards] = useState<Card[]>(() => buildDeck())
  const [flipped, setFlipped] = useState<number[]>([])
  const [moves, setMoves] = useState(0)
  const [mistakes, setMistakes] = useState(0)
  const [locked, setLocked] = useState(false)

  const allMatched = useMemo(
    () => cards.length > 0 && cards.every((c) => c.matched),
    [cards],
  )
  const lost = mistakes >= MAX_MISTAKES

  useEffect(() => {
    if (allMatched) {
      const t = setTimeout(() => onFinish({ won: true, score: moves }), 400)
      return () => clearTimeout(t)
    }
    if (lost) {
      const t = setTimeout(() => onFinish({ won: false, score: moves }), 800)
      return () => clearTimeout(t)
    }
  }, [allMatched, lost, moves, onFinish])

  function onCardClick(idx: number) {
    if (locked || lost || allMatched) return
    if (flipped.includes(idx)) return
    if (cards[idx].matched) return

    const nextFlipped = [...flipped, idx]
    setFlipped(nextFlipped)

    if (nextFlipped.length === 2) {
      setMoves((m) => m + 1)
      const [a, b] = nextFlipped
      if (cards[a].symbol === cards[b].symbol) {
        setCards((prev) =>
          prev.map((c, i) => (i === a || i === b ? { ...c, matched: true } : c)),
        )
        setFlipped([])
      } else {
        setMistakes((m) => m + 1)
        setLocked(true)
        setTimeout(() => {
          setFlipped([])
          setLocked(false)
        }, 800)
      }
    }
  }

  const mistakesLeft = Math.max(0, MAX_MISTAKES - mistakes)

  return (
    <div className="flex flex-col items-center gap-4">
      <div className="flex w-full items-center justify-between text-sm">
        <span>Moves: {moves}</span>
        <span
          className={
            mistakesLeft <= 1
              ? 'font-semibold text-red-600'
              : 'text-[var(--sea-ink-soft)]'
          }
          aria-live="polite"
        >
          Mistakes: {mistakes}/{MAX_MISTAKES}
        </span>
        <button
          type="button"
          onClick={onExit}
          className="rounded border border-[var(--btn-subtle-border)] px-2 py-1 text-xs hover:bg-[var(--btn-subtle-bg)]"
        >
          Quit
        </button>
      </div>
      <div className="grid grid-cols-4 gap-2 sm:gap-3">
        {cards.map((card, i) => {
          const isOpen = flipped.includes(i) || card.matched
          return (
            <button
              key={card.id}
              type="button"
              onClick={() => onCardClick(i)}
              disabled={card.matched || lost}
              className={[
                'h-16 w-16 rounded-lg border text-2xl transition sm:h-20 sm:w-20 sm:text-3xl',
                isOpen
                  ? 'border-[var(--lagoon-deep)] bg-[var(--btn-primary-bg)]'
                  : 'border-[var(--btn-subtle-border)] bg-[var(--btn-subtle-bg)] hover:border-[var(--lagoon-deep)]',
                card.matched ? 'opacity-60' : '',
              ].join(' ')}
              aria-label={isOpen ? `Card showing ${card.symbol}` : 'Hidden card'}
            >
              {isOpen ? card.symbol : ''}
            </button>
          )
        })}
      </div>
      {lost ? (
        <p className="text-sm font-semibold text-red-600">
          Out of mistakes. Better luck next session.
        </p>
      ) : null}
    </div>
  )
}
