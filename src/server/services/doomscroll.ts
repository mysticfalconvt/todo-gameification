import { eq, sql } from 'drizzle-orm'
import { db } from '../db/client'
import { events, progression } from '../db/schema'
import {
  DOOMSCROLL_TOKEN_COST,
  DOOMSCROLL_XP,
  doomScrollDurationMs,
  isDoomScrollDuration,
  type DomainEvent,
  type DoomScrollDurationMin,
} from '../../domain/events'
import { INITIAL_PROGRESSION, applyEvent } from '../../domain/gamification'
import { getUserTimeZone } from './tasks'

export type DoomScrollDuration = DoomScrollDurationMin

export interface StartDoomScrollInput {
  userId: string
  durationMin: DoomScrollDuration
}

export interface StartDoomScrollResult {
  startEventId: string
  expectedEndAt: Date
  xp: number
  level: number
  tokens: number
}

// Spends a token and grants the flat XP reward up front (there's no
// completion step — the scheduled push is just a "back to work" nudge).
// The token debit + XP credit happen inside the same transaction as the
// event insert so the projection can never drift from the log.
export async function recordDoomScrollStart(
  input: StartDoomScrollInput,
): Promise<StartDoomScrollResult> {
  if (!isDoomScrollDuration(input.durationMin)) {
    throw new Error('invalid doom scroll duration')
  }
  const startedAt = new Date()
  const expectedEndAt = new Date(
    startedAt.getTime() + doomScrollDurationMs(input.durationMin),
  )
  const timeZone = await getUserTimeZone(input.userId)

  const event: DomainEvent = {
    type: 'doomscroll.started',
    durationMin: input.durationMin,
    tokenCost: DOOMSCROLL_TOKEN_COST,
    xpEarned: DOOMSCROLL_XP,
    expectedEndAt,
    scheduledJobId: null,
    occurredAt: startedAt,
  }

  const { startEventId, next } = await db.transaction(async (tx) => {
    const current = await tx.query.progression.findFirst({
      where: eq(progression.userId, input.userId),
    })
    if ((current?.tokens ?? 0) < DOOMSCROLL_TOKEN_COST) {
      throw new Error('not enough tokens')
    }

    const [inserted] = await tx
      .insert(events)
      .values({
        userId: input.userId,
        type: 'doomscroll.started',
        payload: {
          durationMin: input.durationMin,
          tokenCost: DOOMSCROLL_TOKEN_COST,
          xpEarned: DOOMSCROLL_XP,
          expectedEndAt: expectedEndAt.toISOString(),
          scheduledJobId: null,
        },
        occurredAt: startedAt,
      })
      .returning({ id: events.id })

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
    const nextState = applyEvent(prevState, event, { timeZone })

    await tx
      .insert(progression)
      .values({
        userId: input.userId,
        xp: nextState.xp,
        level: nextState.level,
        currentStreak: nextState.currentStreak,
        longestStreak: nextState.longestStreak,
        tokens: nextState.tokens,
        lastCompletionAt: nextState.lastCompletionAt,
      })
      .onConflictDoUpdate({
        target: progression.userId,
        set: {
          xp: nextState.xp,
          level: nextState.level,
          tokens: nextState.tokens,
          updatedAt: startedAt,
        },
      })

    return { startEventId: inserted.id, next: nextState }
  })

  // Schedule the "back to work" push for when the timer expires. Best
  // effort — if scheduling fails the break still ran, the user just
  // won't get pinged at the end.
  try {
    const { scheduleDoomScrollEnd } = await import('../boss')
    const jobId = await scheduleDoomScrollEnd(
      {
        startEventId,
        userId: input.userId,
        durationMin: input.durationMin,
      },
      expectedEndAt,
    )
    if (jobId) {
      await db
        .update(events)
        .set({
          payload: sql`jsonb_set(${events.payload}, '{scheduledJobId}', to_jsonb(${jobId}::text))`,
        })
        .where(eq(events.id, startEventId))
    }
  } catch (err) {
    console.warn('[doomscroll] failed to schedule end push', err)
  }

  return {
    startEventId,
    expectedEndAt,
    xp: next.xp,
    level: next.level,
    tokens: next.tokens,
  }
}
