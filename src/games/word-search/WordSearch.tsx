import { useCallback, useEffect, useMemo, useState } from 'react'
import { startWordSearchGame } from '../../server/functions/word-search'
import type { GameProps } from '../types'
import {
  popularThemes,
  moreThemes,
  type WordSearchTheme,
} from './themes'

type Size = 'small' | 'large'

type ThemeChoice =
  | { kind: 'preset'; name: string }
  | { kind: 'surprise' }
  | { kind: 'custom'; value: string }

type Phase =
  | { name: 'setup' }
  | { name: 'loading' }
  | {
      name: 'playing'
      grid: string[][]
      words: string[]
      theme: string
      size: Size
    }

const CUSTOM_THEME_REGEX = /^[A-Za-z0-9 \-']*$/

interface FoundLine {
  word: string
  cells: Array<{ row: number; col: number }>
}

function classNames(...parts: Array<string | false | null | undefined>): string {
  return parts.filter(Boolean).join(' ')
}

export function WordSearch({ onFinish }: GameProps) {
  const [phase, setPhase] = useState<Phase>({ name: 'setup' })
  const [size, setSize] = useState<Size | null>('small')
  const [themeChoice, setThemeChoice] = useState<ThemeChoice | null>({
    kind: 'surprise',
  })
  const [customInput, setCustomInput] = useState('')
  const [showMore, setShowMore] = useState(false)
  const [setupError, setSetupError] = useState<string | null>(null)

  // ---- Game-phase state. Reset whenever a new puzzle loads. ----
  const [start, setStart] = useState<{ row: number; col: number } | null>(null)
  const [foundLines, setFoundLines] = useState<FoundLine[]>([])

  const foundWords = useMemo(
    () => new Set(foundLines.map((l) => l.word)),
    [foundLines],
  )
  const foundCellSet = useMemo(() => {
    const s = new Set<string>()
    for (const l of foundLines) {
      for (const c of l.cells) s.add(`${c.row},${c.col}`)
    }
    return s
  }, [foundLines])

  // ---- Setup helpers ----
  const canStart = useMemo(() => {
    if (!size || !themeChoice) return false
    if (themeChoice.kind === 'custom') return themeChoice.value.trim().length > 0
    return true
  }, [size, themeChoice])

  const handleStart = useCallback(async () => {
    if (!size || !themeChoice) return
    let theme: string | null
    if (themeChoice.kind === 'preset') theme = themeChoice.name
    else if (themeChoice.kind === 'custom') theme = themeChoice.value.trim()
    else theme = null
    setSetupError(null)
    setPhase({ name: 'loading' })
    setStart(null)
    setFoundLines([])
    try {
      const res = await startWordSearchGame({ data: { size, theme } })
      setPhase({
        name: 'playing',
        grid: res.grid,
        words: res.words,
        theme: res.theme,
        size: res.size,
      })
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Could not start game'
      setSetupError(msg)
      setPhase({ name: 'setup' })
    }
  }, [size, themeChoice])

  // ---- Cell tap handling ----
  const handleCellTap = useCallback(
    (row: number, col: number) => {
      if (phase.name !== 'playing') return
      if (start === null) {
        setStart({ row, col })
        return
      }
      if (start.row === row && start.col === col) {
        setStart(null)
        return
      }
      const line = resolveLine(start, { row, col })
      if (!line) {
        // Not a valid 8-direction straight line — restart selection from
        // this cell so a stray tap doesn't strand the user.
        setStart({ row, col })
        return
      }
      const text = line.map((c) => phase.grid[c.row][c.col]).join('')
      const reversed = text.split('').reverse().join('')
      const target = phase.words.find(
        (w) => !foundWords.has(w) && (w === text || w === reversed),
      )
      if (target) {
        setFoundLines((prev) => [...prev, { word: target, cells: line }])
      }
      setStart(null)
    },
    [phase, start, foundWords],
  )

  // ---- Finish detection ----
  const allFound =
    phase.name === 'playing' && foundWords.size === phase.words.length

  const handleGiveUp = useCallback(() => {
    if (phase.name !== 'playing') return
    onFinish({
      won: false,
      score: foundWords.size,
      meta: {
        size: phase.size,
        theme: phase.theme,
        total: phase.words.length,
      },
    })
  }, [phase, foundWords, onFinish])

  const handleAllFound = useCallback(() => {
    if (phase.name !== 'playing') return
    onFinish({
      won: true,
      score: foundWords.size,
      meta: {
        size: phase.size,
        theme: phase.theme,
        total: phase.words.length,
      },
    })
  }, [phase, foundWords, onFinish])

  // Auto-finish on completion. Small delay so the player sees the final
  // strike before the toast fires.
  useEffect(() => {
    if (!allFound) return
    const t = window.setTimeout(handleAllFound, 600)
    return () => window.clearTimeout(t)
  }, [allFound, handleAllFound])

  // ---- Render ----
  if (phase.name === 'setup') {
    return (
      <SetupScreen
        size={size}
        onSize={setSize}
        themeChoice={themeChoice}
        onThemeChoice={setThemeChoice}
        customInput={customInput}
        onCustomInput={setCustomInput}
        showMore={showMore}
        onToggleMore={() => setShowMore((s) => !s)}
        canStart={canStart}
        onStart={handleStart}
        error={setupError}
      />
    )
  }

  if (phase.name === 'loading') {
    return (
      <div className="flex flex-col items-center gap-3 py-12">
        <p className="text-sm text-[var(--sea-ink-soft)]">
          Generating puzzle…
        </p>
      </div>
    )
  }

  return (
    <div className="flex flex-col items-center gap-4">
      <div className="flex w-full items-center justify-between text-sm">
        <span className="font-semibold text-[var(--sea-ink)]">
          {phase.theme}
        </span>
        <span className="text-[var(--sea-ink-soft)]">
          {foundWords.size}/{phase.words.length}
        </span>
        <button
          type="button"
          onClick={handleGiveUp}
          className="rounded border border-[var(--btn-subtle-border)] px-2 py-1 text-xs hover:bg-[var(--btn-subtle-bg)]"
        >
          Give up
        </button>
      </div>

      <div
        className="grid w-full max-w-md select-none gap-[2px]"
        style={{
          gridTemplateColumns: `repeat(${phase.grid.length}, minmax(0, 1fr))`,
        }}
      >
        {phase.grid.flatMap((row, r) =>
          row.map((letter, c) => {
            const isStart = start?.row === r && start?.col === c
            const inFound = foundCellSet.has(`${r},${c}`)
            return (
              <button
                key={`${r}-${c}`}
                type="button"
                onClick={() => handleCellTap(r, c)}
                aria-label={`Row ${r + 1}, column ${c + 1}, ${letter}`}
                className={classNames(
                  'flex aspect-square items-center justify-center rounded-sm border text-[10px] font-bold uppercase transition sm:text-sm',
                  inFound
                    ? 'border-green-700 bg-green-600 text-white'
                    : isStart
                      ? 'border-[var(--lagoon-deep)] bg-[var(--lagoon-deep)] text-white'
                      : 'border-[var(--btn-subtle-border)] bg-[var(--btn-subtle-bg)] text-[var(--sea-ink)]',
                )}
              >
                {letter}
              </button>
            )
          }),
        )}
      </div>

      <ul className="flex w-full max-w-md flex-wrap justify-center gap-2 text-xs">
        {phase.words.map((w) => {
          const found = foundWords.has(w)
          return (
            <li
              key={w}
              className={classNames(
                'rounded border px-2 py-1 font-semibold uppercase tracking-wide',
                found
                  ? 'border-green-700 text-green-700 line-through opacity-60'
                  : 'border-[var(--btn-subtle-border)] text-[var(--sea-ink)]',
              )}
            >
              {w}
            </li>
          )
        })}
      </ul>

      <p className="text-xs text-[var(--sea-ink-soft)]">
        Tap the first letter, then the last letter of a word.
      </p>
    </div>
  )
}

interface SetupProps {
  size: Size | null
  onSize: (s: Size) => void
  themeChoice: ThemeChoice | null
  onThemeChoice: (t: ThemeChoice) => void
  customInput: string
  onCustomInput: (s: string) => void
  showMore: boolean
  onToggleMore: () => void
  canStart: boolean
  onStart: () => void
  error: string | null
}

function SetupScreen(props: SetupProps) {
  const popular = popularThemes()
  const more = moreThemes()
  const isCustom = props.themeChoice?.kind === 'custom'

  return (
    <div className="flex flex-col gap-6 py-2">
      <section>
        <h2 className="mb-2 text-xs font-semibold uppercase tracking-wide text-[var(--kicker)]">
          Size
        </h2>
        <div className="flex gap-2">
          <SizeButton
            label="Small"
            sub="8×8"
            active={props.size === 'small'}
            onClick={() => props.onSize('small')}
          />
          <SizeButton
            label="Large"
            sub="12×12"
            active={props.size === 'large'}
            onClick={() => props.onSize('large')}
          />
        </div>
      </section>

      <section>
        <h2 className="mb-2 text-xs font-semibold uppercase tracking-wide text-[var(--kicker)]">
          Theme
        </h2>
        <div className="flex flex-wrap gap-2">
          <ThemeChip
            label="Surprise me"
            active={props.themeChoice?.kind === 'surprise'}
            onClick={() => props.onThemeChoice({ kind: 'surprise' })}
          />
          {popular.map((t) => (
            <ThemeChip
              key={t.name}
              label={t.name}
              active={
                props.themeChoice?.kind === 'preset' &&
                props.themeChoice.name === t.name
              }
              onClick={() =>
                props.onThemeChoice({ kind: 'preset', name: t.name })
              }
            />
          ))}
          <button
            type="button"
            onClick={props.onToggleMore}
            className="rounded-full border border-[var(--btn-subtle-border)] px-3 py-1 text-xs text-[var(--sea-ink-soft)] hover:bg-[var(--btn-subtle-bg)]"
          >
            {props.showMore ? 'Less' : 'More…'}
          </button>
        </div>
        {props.showMore ? (
          <div className="mt-2 flex flex-wrap gap-2">
            {more.map((t: WordSearchTheme) => (
              <ThemeChip
                key={t.name}
                label={t.name}
                active={
                  props.themeChoice?.kind === 'preset' &&
                  props.themeChoice.name === t.name
                }
                onClick={() =>
                  props.onThemeChoice({ kind: 'preset', name: t.name })
                }
              />
            ))}
          </div>
        ) : null}

        <div className="mt-3 flex flex-col gap-1">
          <label className="text-xs text-[var(--sea-ink-soft)]">
            Or write your own:
          </label>
          <input
            type="text"
            inputMode="text"
            maxLength={40}
            placeholder="e.g. space pirates"
            value={props.customInput}
            onChange={(e) => {
              const v = e.target.value
              // Block characters outside the allowed set as the user types
              // — server validates again, but this avoids the user
              // discovering at submit-time that "café" isn't accepted.
              if (!CUSTOM_THEME_REGEX.test(v)) return
              props.onCustomInput(v)
              if (v.trim().length > 0) {
                props.onThemeChoice({ kind: 'custom', value: v })
              }
            }}
            className={classNames(
              'rounded border bg-[var(--option-bg)] px-3 py-2 text-sm text-[var(--sea-ink)]',
              isCustom
                ? 'border-[var(--lagoon-deep)]'
                : 'border-[var(--btn-subtle-border)]',
            )}
          />
        </div>
      </section>

      {props.error ? (
        <p className="text-sm font-semibold text-red-600">{props.error}</p>
      ) : null}

      <button
        type="button"
        disabled={!props.canStart}
        onClick={props.onStart}
        className="rounded-full bg-[var(--btn-primary-bg)] px-4 py-2 text-sm font-semibold text-[var(--btn-primary-fg)] disabled:opacity-50"
      >
        Start · 🪙 1
      </button>
    </div>
  )
}

function SizeButton({
  label,
  sub,
  active,
  onClick,
}: {
  label: string
  sub: string
  active: boolean
  onClick: () => void
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={classNames(
        'flex flex-1 flex-col items-center gap-0.5 rounded-lg border px-4 py-3 transition',
        active
          ? 'border-[var(--lagoon-deep)] bg-[var(--lagoon-deep)] text-white'
          : 'border-[var(--btn-subtle-border)] bg-[var(--btn-subtle-bg)] text-[var(--sea-ink)] hover:border-[var(--lagoon-deep)]',
      )}
    >
      <span className="text-sm font-semibold">{label}</span>
      <span className="text-[10px] uppercase tracking-wide opacity-80">
        {sub}
      </span>
    </button>
  )
}

function ThemeChip({
  label,
  active,
  onClick,
}: {
  label: string
  active: boolean
  onClick: () => void
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={classNames(
        'rounded-full border px-3 py-1 text-xs font-semibold transition',
        active
          ? 'border-[var(--lagoon-deep)] bg-[var(--lagoon-deep)] text-white'
          : 'border-[var(--btn-subtle-border)] text-[var(--sea-ink)] hover:bg-[var(--btn-subtle-bg)]',
      )}
    >
      {label}
    </button>
  )
}

// Returns the list of cells from `start` through `end` if the two cells are
// connected by one of the 8 grid directions; otherwise null.
function resolveLine(
  start: { row: number; col: number },
  end: { row: number; col: number },
): Array<{ row: number; col: number }> | null {
  const dr = end.row - start.row
  const dc = end.col - start.col
  if (dr === 0 && dc === 0) return null
  const horizontal = dr === 0
  const vertical = dc === 0
  const diagonal = Math.abs(dr) === Math.abs(dc)
  if (!horizontal && !vertical && !diagonal) return null
  const steps = Math.max(Math.abs(dr), Math.abs(dc))
  const stepR = dr === 0 ? 0 : dr / Math.abs(dr)
  const stepC = dc === 0 ? 0 : dc / Math.abs(dc)
  const cells: Array<{ row: number; col: number }> = []
  for (let i = 0; i <= steps; i++) {
    cells.push({ row: start.row + stepR * i, col: start.col + stepC * i })
  }
  return cells
}
