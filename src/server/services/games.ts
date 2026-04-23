import { eq } from 'drizzle-orm'
import { db } from '../db/client'
import { events, progression } from '../db/schema'
import type { DomainEvent } from '../../domain/events'
import { INITIAL_PROGRESSION, applyEvent } from '../../domain/gamification'
import { findGame, GAMES } from '../../games/registry'
import { getUserTimeZone } from './tasks'
import { checkAndNotifyLowPool } from './wordle'

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
  result: {
    won: boolean
    score: number | null
    meta?: Record<string, unknown>
  }
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
    result: { won: input.result.won, score: input.result.score },
    meta: input.result.meta,
    occurredAt: now,
  }

  return await db.transaction(async (tx) => {
    const current = await tx.query.progression.findFirst({
      where: eq(progression.userId, input.userId),
    })
    if ((current?.tokens ?? 0) < game.tokenCost) {
      throw new Error('not enough tokens')
    }

    // Wordle stores the played word in `payload.word` (promoted from meta)
    // so the per-user "seen words" query can match on it directly.
    const basePayload: Record<string, unknown> = {
      gameId: event.gameId,
      tokenCost: event.tokenCost,
      xpReward: event.xpReward,
      result: event.result,
    }
    const word = event.meta?.word
    if (typeof word === 'string') basePayload.word = word

    await tx.insert(events).values({
      userId: input.userId,
      type: event.type,
      payload: basePayload,
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
  }).then(async (out) => {
    // Post-commit side effect: if this was a wordle play, check whether the
    // user has run low on unseen words and nudge the admin. Fire-and-forget;
    // a failure here shouldn't roll back the play.
    if (input.gameId === 'wordle') {
      await checkAndNotifyLowPool(input.userId).catch((err) => {
        console.error('[games] wordle low-pool check failed', err)
      })
    }
    return out
  })
}
