import { and, count, desc, eq, gte, sql } from 'drizzle-orm'
import { db } from '../db/client'
import { events } from '../db/schema'
import { GAMES } from '../../games/registry'

export type StatsWindow = number | 'all'

export interface MotivationStats {
  windowDays: StatsWindow
  focus: {
    started: number
    completed: number
    minutesCompleted: number
    xpEarned: number
    tokensEarned: number
  }
  games: Array<{
    gameId: string
    name: string
    played: number
    won: number
    xpEarned: number
  }>
  recentEvents: MotivationEvent[]
}

export type MotivationEvent =
  | {
      id: string
      type: 'focus.started'
      occurredAt: string
      durationMin: number | null
    }
  | {
      id: string
      type: 'focus.completed'
      occurredAt: string
      durationMin: number | null
      xpEarned: number
      tokensEarned: number
    }
  | {
      id: string
      type: 'game.played'
      occurredAt: string
      gameId: string
      gameName: string
      won: boolean
      tokenCost: number
      xpReward: number
    }

const RECENT_LIMIT = 50

function cutoff(days: StatsWindow): Date | null {
  if (days === 'all') return null
  return new Date(Date.now() - Math.max(1, days) * 86_400_000)
}

function gameName(gameId: string): string {
  return GAMES.find((g) => g.id === gameId)?.name ?? gameId
}

export async function getMotivationStats(
  userId: string,
  days: StatsWindow,
): Promise<MotivationStats> {
  const since = cutoff(days)
  const whereFor = (type: string) =>
    since
      ? and(
          eq(events.userId, userId),
          eq(events.type, type),
          gte(events.occurredAt, since),
        )
      : and(eq(events.userId, userId), eq(events.type, type))

  const [startedRows, completedRows, gameRows, recentRows] = await Promise.all([
    db.select({ n: count() }).from(events).where(whereFor('focus.started')),
    db
      .select({
        n: count(),
        minutes: sql<number>`coalesce(sum((payload->>'durationMin')::int), 0)::int`,
        xp: sql<number>`coalesce(sum((payload->>'xpEarned')::int), 0)::int`,
        tokens: sql<number>`coalesce(sum((payload->>'tokensEarned')::int), 0)::int`,
      })
      .from(events)
      .where(whereFor('focus.completed')),
    db
      .select({
        gameId: sql<string>`payload->>'gameId'`,
        played: count(),
        won: sql<number>`sum(case when (payload->'result'->>'won') = 'true' then 1 else 0 end)::int`,
        xp: sql<number>`coalesce(sum((payload->>'xpReward')::int), 0)::int`,
      })
      .from(events)
      .where(whereFor('game.played'))
      .groupBy(sql`payload->>'gameId'`),
    db
      .select({
        id: events.id,
        type: events.type,
        payload: events.payload,
        occurredAt: events.occurredAt,
      })
      .from(events)
      .where(
        since
          ? and(
              eq(events.userId, userId),
              sql`${events.type} in ('focus.started', 'focus.completed', 'game.played')`,
              gte(events.occurredAt, since),
            )
          : and(
              eq(events.userId, userId),
              sql`${events.type} in ('focus.started', 'focus.completed', 'game.played')`,
            ),
      )
      .orderBy(desc(events.occurredAt))
      .limit(RECENT_LIMIT),
  ])

  const recentEvents: MotivationEvent[] = recentRows.map((r) => {
    const p = (r.payload ?? {}) as Record<string, unknown>
    const iso = r.occurredAt.toISOString()
    if (r.type === 'focus.started') {
      return {
        id: r.id,
        type: 'focus.started',
        occurredAt: iso,
        durationMin:
          typeof p['durationMin'] === 'number' ? (p['durationMin'] as number) : null,
      }
    }
    if (r.type === 'focus.completed') {
      return {
        id: r.id,
        type: 'focus.completed',
        occurredAt: iso,
        durationMin:
          typeof p['durationMin'] === 'number' ? (p['durationMin'] as number) : null,
        xpEarned:
          typeof p['xpEarned'] === 'number' ? (p['xpEarned'] as number) : 0,
        tokensEarned:
          typeof p['tokensEarned'] === 'number'
            ? (p['tokensEarned'] as number)
            : 0,
      }
    }
    // game.played
    const gameId = typeof p['gameId'] === 'string' ? (p['gameId'] as string) : ''
    const result =
      p['result'] && typeof p['result'] === 'object'
        ? (p['result'] as Record<string, unknown>)
        : {}
    return {
      id: r.id,
      type: 'game.played',
      occurredAt: iso,
      gameId,
      gameName: gameName(gameId),
      won: result['won'] === true,
      tokenCost:
        typeof p['tokenCost'] === 'number' ? (p['tokenCost'] as number) : 0,
      xpReward:
        typeof p['xpReward'] === 'number' ? (p['xpReward'] as number) : 0,
    }
  })

  return {
    windowDays: days,
    focus: {
      started: Number(startedRows[0]?.n ?? 0),
      completed: Number(completedRows[0]?.n ?? 0),
      minutesCompleted: Number(completedRows[0]?.minutes ?? 0),
      xpEarned: Number(completedRows[0]?.xp ?? 0),
      tokensEarned: Number(completedRows[0]?.tokens ?? 0),
    },
    games: gameRows
      .filter((r) => r.gameId)
      .map((r) => ({
        gameId: r.gameId,
        name: gameName(r.gameId),
        played: Number(r.played),
        won: Number(r.won ?? 0),
        xpEarned: Number(r.xp ?? 0),
      })),
    recentEvents,
  }
}
