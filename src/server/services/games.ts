import { eq } from 'drizzle-orm'
import { db } from '../db/client'
import { events, progression } from '../db/schema'
import type { DomainEvent } from '../../domain/events'
import { INITIAL_PROGRESSION, applyEvent } from '../../domain/gamification'
import { findGame, GAMES } from '../../games/registry'
import { getUserTimeZone } from './tasks'

export interface GameMeta {
  id: string
  name: string
  description: string
  tokenCost: number
}

export function listGames(): GameMeta[] {
  return GAMES.map((g) => ({
    id: g.id,
    name: g.name,
    description: g.description,
    tokenCost: g.tokenCost,
  }))
}

// Balance check used before rendering a game. Doesn't touch the DB — the token
// is only spent when the play is finalized via `finishGame`, so closing the
// tab mid-play is a free refund.
export async function canPlay(userId: string, gameId: string): Promise<boolean> {
  const game = findGame(gameId)
  if (!game) return false
  const row = await db.query.progression.findFirst({
    where: eq(progression.userId, userId),
  })
  return (row?.tokens ?? 0) >= game.tokenCost
}

export interface FinishGameInput {
  userId: string
  gameId: string
  result: { won: boolean; score: number | null }
}

export interface FinishGameResult {
  xp: number
  level: number
  tokens: number
  xpReward: number
}

// Single source of truth per play: writes `game.played` event, applies it.
// Debits `tokenCost` and credits `xpReward` (0 on loss/quit). Replay-safe.
export async function finishGame(
  input: FinishGameInput,
): Promise<FinishGameResult> {
  const game = findGame(input.gameId)
  if (!game) throw new Error('unknown game')
  const xpReward = game.rewardXp(input.result)
  const timeZone = await getUserTimeZone(input.userId)
  const now = new Date()

  const event: DomainEvent = {
    type: 'game.played',
    gameId: game.id,
    tokenCost: game.tokenCost,
    xpReward,
    result: input.result,
    occurredAt: now,
  }

  return await db.transaction(async (tx) => {
    const current = await tx.query.progression.findFirst({
      where: eq(progression.userId, input.userId),
    })
    if ((current?.tokens ?? 0) < game.tokenCost) {
      throw new Error('not enough tokens')
    }

    await tx.insert(events).values({
      userId: input.userId,
      type: event.type,
      payload: {
        gameId: event.gameId,
        tokenCost: event.tokenCost,
        xpReward: event.xpReward,
        result: event.result,
      },
      occurredAt: now,
    })

    const prevState = current
      ? {
          xp: current.xp,
          level: current.level,
          currentStreak: current.currentStreak,
          longestStreak: current.longestStreak,
          tokens: current.tokens,
          lastCompletionAt: current.lastCompletionAt,
        }
      : INITIAL_PROGRESSION

    const next = applyEvent(prevState, event, { timeZone })

    await tx
      .insert(progression)
      .values({
        userId: input.userId,
        xp: next.xp,
        level: next.level,
        tokens: next.tokens,
      })
      .onConflictDoUpdate({
        target: progression.userId,
        set: {
          xp: next.xp,
          level: next.level,
          tokens: next.tokens,
          updatedAt: now,
        },
      })

    return { xp: next.xp, level: next.level, tokens: next.tokens, xpReward }
  })
}
