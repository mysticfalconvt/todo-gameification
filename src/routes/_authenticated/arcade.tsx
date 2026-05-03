import { useState } from 'react'
import { createFileRoute, Link } from '@tanstack/react-router'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { toast } from 'sonner'
import {
  listGames,
  finishGame,
  getArcadeStats,
} from '../../server/functions/games'
import { getProgression } from '../../server/functions/tasks'
import { findGame } from '../../games/registry'
import type { GameResult } from '../../games/types'

interface PersonalGameStats {
  gameId: string
  played: number
  won: number
  bestScore: number | null
  bestAt: string | null
  lastPlayedAt: string | null
}

interface FriendBest {
  gameId: string
  handle: string
  name: string
  bestScore: number
  bestAt: string
}

interface WordleDetails {
  played: number
  won: number
  bestGuesses: number | null
  averageGuessesOnWin: number | null
  uniqueWordsSolved: number
  currentWinStreak: number
  longestWinStreak: number
}

function formatScore(gameId: string, score: number): string {
  switch (gameId) {
    case 'wordle':
      return `${score} ${score === 1 ? 'guess' : 'guesses'}`
    case '2048':
      return `tile ${score}`
    case 'sliding-puzzle':
    case 'memory-flip':
      return `${score} ${score === 1 ? 'move' : 'moves'}`
    default:
      return `${score}`
  }
}

function formatWinRate(played: number, won: number): string {
  if (played === 0) return ''
  return `${Math.round((won / played) * 100)}%`
}

export const Route = createFileRoute('/_authenticated/arcade')({
  component: ArcadePage,
})

function ArcadePage() {
  const qc = useQueryClient()
  const [playingId, setPlayingId] = useState<string | null>(null)

  const gamesQuery = useQuery({
    queryKey: ['games'],
    queryFn: () => listGames(),
  })
  const progressionQuery = useQuery({
    queryKey: ['progression'],
    queryFn: () => getProgression(),
  })
  const statsQuery = useQuery({
    queryKey: ['arcade-stats'],
    queryFn: () => getArcadeStats(),
  })

  const finish = useMutation({
    mutationFn: (input: { gameId: string; result: GameResult }) =>
      finishGame({ data: input }),
    onSuccess: (res) => {
      qc.invalidateQueries({ queryKey: ['progression'] })
      qc.invalidateQueries({ queryKey: ['arcade-stats'] })
      const xpMsg = res.xpReward > 0 ? `, +${res.xpReward} XP` : ''
      toast.success(`Play recorded${xpMsg}. Balance: 🪙 ${res.tokens}`)
      setPlayingId(null)
    },
    onError: (err) => {
      toast.error(err instanceof Error ? err.message : 'Game finish failed')
      setPlayingId(null)
    },
  })

  const progression = progressionQuery.data
  const games = Array.isArray(gamesQuery.data) ? gamesQuery.data : []
  const balance = progression?.tokens ?? 0

  const activeGame = playingId ? findGame(playingId) : null

  if (activeGame) {
    const ActiveComponent = activeGame.Component
    return (
      <main className="page-wrap px-4 py-8">
        <header className="mb-4 flex items-center justify-between">
          <h1 className="text-xl font-semibold text-[var(--sea-ink)]">
            {activeGame.name}
          </h1>
          <span className="text-sm text-[var(--sea-ink-soft)]">
            🪙 {balance}
          </span>
        </header>
        <ActiveComponent
          onFinish={(result) =>
            finish.mutate({ gameId: activeGame.id, result })
          }
          onExit={() =>
            finish.mutate({
              gameId: activeGame.id,
              result: { won: false, score: null },
            })
          }
        />
      </main>
    )
  }

  return (
    <main className="page-wrap px-4 py-8">
      <header className="mb-6 flex items-end justify-between gap-3">
        <div>
          <p className="island-kicker mb-1">Arcade</p>
          <h1 className="display-title text-4xl font-bold text-[var(--sea-ink)]">
            Balance: 🪙 {balance}
          </h1>
          <p className="mt-2 text-sm text-[var(--sea-ink-soft)]">
            Spend tokens on a game. Tokens come from completing{' '}
            <Link to="/focus" className="underline">
              focus sessions
            </Link>
            .
          </p>
        </div>
      </header>

      <ul className="space-y-3">
        {games.map((g) => {
          const affordable = balance >= g.tokenCost
          const personal = statsQuery.data?.personal.find(
            (p) => p.gameId === g.id,
          ) as PersonalGameStats | undefined
          const friendBest = statsQuery.data?.friendBests.find(
            (f) => f.gameId === g.id,
          ) as FriendBest | undefined
          const wordle =
            g.id === 'wordle'
              ? (statsQuery.data?.wordle as WordleDetails | null | undefined)
              : null
          return (
            <li
              key={g.id}
              className="island-shell rounded-xl p-4"
            >
              <div className="flex items-center gap-3">
                <div className="min-w-0 flex-1">
                  <p className="font-semibold text-[var(--sea-ink)]">{g.name}</p>
                  <p className="text-xs text-[var(--sea-ink-soft)]">
                    {g.description}
                  </p>
                </div>
                <button
                  type="button"
                  disabled={!affordable || finish.isPending}
                  onClick={() => setPlayingId(g.id)}
                  className="rounded-full bg-[var(--btn-primary-bg)] px-4 py-2 text-sm font-semibold text-[var(--btn-primary-fg)] disabled:opacity-50"
                >
                  Play · 🪙 {g.tokenCost}
                </button>
              </div>
              <GameStatsRow
                personal={personal}
                friendBest={friendBest}
                gameId={g.id}
              />
              {wordle ? <WordlePanel details={wordle} /> : null}
            </li>
          )
        })}
      </ul>

      {games.length === 0 ? (
        <p className="mt-6 text-sm text-[var(--sea-ink-soft)]">
          No games yet.
        </p>
      ) : null}
    </main>
  )
}

function GameStatsRow({
  personal,
  friendBest,
  gameId,
}: {
  personal: PersonalGameStats | undefined
  friendBest: FriendBest | undefined
  gameId: string
}) {
  // Show nothing if we have neither a personal play nor a visible friend
  // record. Avoids dead pixels for fresh users.
  const hasPersonal = personal && personal.played > 0
  if (!hasPersonal && !friendBest) return null

  return (
    <div className="mt-3 flex flex-wrap gap-x-3 gap-y-1 border-t border-[var(--line)] pt-2 text-xs text-[var(--sea-ink-soft)]">
      {hasPersonal ? (
        <>
          {personal!.bestScore !== null ? (
            <span>
              <span aria-hidden>🏆 </span>
              Best: {formatScore(gameId, personal!.bestScore)}
            </span>
          ) : null}
          <span>
            {personal!.played} {personal!.played === 1 ? 'play' : 'plays'}
            {personal!.won > 0
              ? ` · ${personal!.won} won (${formatWinRate(
                  personal!.played,
                  personal!.won,
                )})`
              : null}
          </span>
        </>
      ) : (
        <span>No plays yet.</span>
      )}
      {friendBest ? (
        <span>
          <span aria-hidden>👥 </span>
          Friends' best: {formatScore(gameId, friendBest.bestScore)} —{' '}
          <span className="font-semibold text-[var(--sea-ink)]">
            @{friendBest.handle}
          </span>
        </span>
      ) : null}
    </div>
  )
}

function WordlePanel({ details }: { details: WordleDetails }) {
  if (details.played === 0) return null
  return (
    <details className="mt-3 rounded-lg border border-[var(--line)] bg-[var(--option-bg)] p-3 text-xs">
      <summary className="cursor-pointer font-semibold uppercase tracking-wide text-[var(--kicker)]">
        Wordle stats
      </summary>
      <dl className="mt-3 grid grid-cols-2 gap-x-4 gap-y-2 text-[var(--sea-ink)] sm:grid-cols-3">
        <Stat label="Win rate" value={formatWinRate(details.played, details.won)} />
        <Stat
          label="Best"
          value={
            details.bestGuesses !== null
              ? `${details.bestGuesses} ${details.bestGuesses === 1 ? 'guess' : 'guesses'}`
              : '—'
          }
        />
        <Stat
          label="Avg on win"
          value={
            details.averageGuessesOnWin !== null
              ? `${details.averageGuessesOnWin}`
              : '—'
          }
        />
        <Stat label="Words solved" value={`${details.uniqueWordsSolved}`} />
        <Stat label="Current streak" value={`${details.currentWinStreak}`} />
        <Stat label="Best streak" value={`${details.longestWinStreak}`} />
      </dl>
    </details>
  )
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <dt className="text-[10px] font-semibold uppercase tracking-wide text-[var(--kicker)]">
        {label}
      </dt>
      <dd className="text-sm font-semibold">{value}</dd>
    </div>
  )
}
