import { eq } from 'drizzle-orm'
import { db } from '../db/client'
import { events, progression } from '../db/schema'
import { FOCUS_REWARDS, type DomainEvent } from '../../domain/events'
import { INITIAL_PROGRESSION, applyEvent } from '../../domain/gamification'
import { completeInstance, getUserTimeZone } from './tasks'

export type FocusDuration = 15 | 25 | 50

export async function recordFocusStart(input: {
  userId: string
  durationMin: FocusDuration
  taskInstanceId?: string | null
}): Promise<void> {
  if (!FOCUS_REWARDS[input.durationMin]) {
    throw new Error('invalid focus duration')
  }
  await db.insert(events).values({
    userId: input.userId,
    type: 'focus.started',
    payload: {
      durationMin: input.durationMin,
      taskInstanceId: input.taskInstanceId ?? null,
    },
    occurredAt: new Date(),
  })
}

export interface CompleteFocusSessionInput {
  userId: string
  durationMin: FocusDuration
  taskInstanceId?: string | null
}

export interface CompleteFocusSessionResult {
  xp: number
  level: number
  tokens: number
  xpEarned: number
  tokensEarned: number
  taskCompleted: boolean
}

export async function completeFocusSession(
  input: CompleteFocusSessionInput,
): Promise<CompleteFocusSessionResult> {
  const { userId, durationMin } = input
  const taskInstanceId = input.taskInstanceId ?? null

  if (!FOCUS_REWARDS[durationMin]) {
    throw new Error('invalid focus duration')
  }
  const { tokens: tokensEarned, xp: xpEarned } = FOCUS_REWARDS[durationMin]

  const timeZone = await getUserTimeZone(userId)
  const now = new Date()

  const focusEvent: DomainEvent = {
    type: 'focus.completed',
    durationMin,
    taskInstanceId,
    tokensEarned,
    xpEarned,
    occurredAt: now,
  }

  const nextState = await db.transaction(async (tx) => {
    await tx.insert(events).values({
      userId,
      type: focusEvent.type,
      payload: {
        durationMin,
        taskInstanceId,
        tokensEarned,
        xpEarned,
      },
      occurredAt: now,
    })

    const current = await tx.query.progression.findFirst({
      where: eq(progression.userId, userId),
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

    const next = applyEvent(prevState, focusEvent, { timeZone })

    await tx
      .insert(progression)
      .values({
        userId,
        xp: next.xp,
        level: next.level,
        currentStreak: next.currentStreak,
        longestStreak: next.longestStreak,
        tokens: next.tokens,
        lastCompletionAt: next.lastCompletionAt,
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

    return next
  })

  let taskCompleted = false
  if (taskInstanceId) {
    const result = await completeInstance(userId, taskInstanceId).catch(
      (err) => {
        console.error('[focus] completeInstance failed', err)
        return null
      },
    )
    if (result && !result.alreadyHandled) taskCompleted = true
  }

  // Re-read progression in case completeInstance advanced XP/level.
  const row = await db.query.progression.findFirst({
    where: eq(progression.userId, userId),
  })
  return {
    xp: row?.xp ?? nextState.xp,
    level: row?.level ?? nextState.level,
    tokens: row?.tokens ?? nextState.tokens,
    xpEarned,
    tokensEarned,
    taskCompleted,
  }
}
