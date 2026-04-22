import { useState } from 'react'
import { createFileRoute, Link } from '@tanstack/react-router'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { toast } from 'sonner'
import { listGames, finishGame } from '../../server/functions/games'
import { getProgression } from '../../server/functions/tasks'
import { findGame } from '../../games/registry'
import type { GameResult } from '../../games/types'

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

  const finish = useMutation({
    mutationFn: (input: { gameId: string; result: GameResult }) =>
      finishGame({ data: input }),
    onSuccess: (res) => {
      qc.invalidateQueries({ queryKey: ['progression'] })
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
          return (
            <li
              key={g.id}
              className="island-shell flex items-center gap-3 rounded-xl p-4"
            >
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
