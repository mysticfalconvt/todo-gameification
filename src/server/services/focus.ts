import { and, desc, eq, gte, sql } from 'drizzle-orm'
import { db } from '../db/client'
import { events, progression } from '../db/schema'
import {
  focusDurationMs,
  focusRewardsFor,
  isFocusDuration,
  type DomainEvent,
  type FocusDurationMin,
  type FocusMode,
} from '../../domain/events'
import { INITIAL_PROGRESSION, applyEvent } from '../../domain/gamification'
import { getUserTimeZone } from './tasks'

export type FocusDuration = FocusDurationMin

export interface StartFocusInput {
  userId: string
  durationMin: FocusDuration
  mode: FocusMode
  taskInstanceId?: string | null
}

export interface StartFocusResult {
  startEventId: string
  expectedEndAt: Date
}

export async function recordFocusStart(
  input: StartFocusInput,
): Promise<StartFocusResult> {
  if (!isFocusDuration(input.durationMin)) {
    throw new Error('invalid focus duration')
  }
  const startedAt = new Date()
  const expectedEndAt = new Date(
    startedAt.getTime() + focusDurationMs(input.durationMin),
  )

  // Insert the started event first so we have an ID to associate the
  // pg-boss job with. The completion-end push handler looks the event
  // up by ID, so the row must exist before the job is scheduled.
  const [inserted] = await db
    .insert(events)
    .values({
      userId: input.userId,
      type: 'focus.started',
      payload: {
        durationMin: input.durationMin,
        taskInstanceId: input.taskInstanceId ?? null,
        mode: input.mode,
        expectedEndAt: expectedEndAt.toISOString(),
        scheduledJobId: null,
      },
      occurredAt: startedAt,
    })
    .returning({ id: events.id })

  const startEventId = inserted.id

  // Pocket mode = server schedules a push when the timer would expire,
  // plus a follow-up sweep job 24h after that to auto-cancel any
  // session the user never came back to confirm.
  if (input.mode === 'pocket') {
    try {
      const { scheduleFocusSessionEnd, scheduleFocusSessionExpire } =
        await import('../boss')
      const jobId = await scheduleFocusSessionEnd(
        { startEventId, userId: input.userId },
        expectedEndAt,
      )
      await scheduleFocusSessionExpire(
        { startEventId, userId: input.userId },
        new Date(expectedEndAt.getTime() + 24 * 60 * 60 * 1000),
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
      // If scheduling fails the session still runs; the user just won't
      // get a push at the end. Log and continue so we don't block start.
      console.warn('[focus] failed to schedule pocket-mode end job', err)
    }
  }

  return { startEventId, expectedEndAt }
}

export interface ActiveFocusSession {
  startEventId: string
  startedAt: Date
  expectedEndAt: Date
  durationMin: FocusDuration
  mode: FocusMode
  taskInstanceId: string | null
}

// Derives the in-flight focus session for a user (if any). Looks at the
// most recent focus.started in the last 24h and reports it as active
// unless a matching focus.completed or focus.cancelled exists.
export async function getActiveFocusSession(
  userId: string,
): Promise<ActiveFocusSession | null> {
  const since = new Date(Date.now() - 24 * 60 * 60 * 1000)
  const recentStart = await db
    .select({
      id: events.id,
      payload: events.payload,
      occurredAt: events.occurredAt,
    })
    .from(events)
    .where(
      and(
        eq(events.userId, userId),
        eq(events.type, 'focus.started'),
        gte(events.occurredAt, since),
      ),
    )
    .orderBy(desc(events.occurredAt))
    .limit(1)

  if (recentStart.length === 0) return null
  const row = recentStart[0]

  const matched = await db
    .select({ id: events.id })
    .from(events)
    .where(
      and(
        eq(events.userId, userId),
        sql`${events.type} in ('focus.completed', 'focus.cancelled')`,
        sql`${events.payload}->>'startEventId' = ${row.id}`,
      ),
    )
    .limit(1)
  if (matched.length > 0) return null

  const payload =
    row.payload && typeof row.payload === 'object'
      ? (row.payload as Record<string, unknown>)
      : {}
  const durationRaw = payload.durationMin
  const durationMin =
    typeof durationRaw === 'number' && isFocusDuration(durationRaw)
      ? durationRaw
      : null
  if (durationMin === null) return null

  const modeRaw = payload.mode
  const mode: FocusMode = modeRaw === 'pocket' ? 'pocket' : 'visible'
  const taskInstanceId =
    typeof payload.taskInstanceId === 'string' ? payload.taskInstanceId : null

  const expectedRaw = payload.expectedEndAt
  const expectedEndAt =
    typeof expectedRaw === 'string'
      ? new Date(expectedRaw)
      : new Date(row.occurredAt.getTime() + focusDurationMs(durationMin))

  return {
    startEventId: row.id,
    startedAt: row.occurredAt,
    expectedEndAt,
    durationMin,
    mode,
    taskInstanceId,
  }
}

export interface CancelFocusInput {
  userId: string
  startEventId: string
  // Internal callers (e.g., the 24h auto-expire job) skip the ownership
  // check because they're running with no session.
  trusted?: boolean
}

export async function cancelFocusSession(input: CancelFocusInput): Promise<void> {
  const start = await db.query.events.findFirst({
    where: and(
      eq(events.id, input.startEventId),
      eq(events.type, 'focus.started'),
    ),
  })
  if (!start) return
  if (!input.trusted && start.userId !== input.userId) {
    throw new Error('not your session')
  }

  // Skip if already terminated (idempotent on re-cancel / auto-expire).
  const terminated = await db
    .select({ id: events.id })
    .from(events)
    .where(
      and(
        eq(events.userId, start.userId),
        sql`${events.type} in ('focus.completed', 'focus.cancelled')`,
        sql`${events.payload}->>'startEventId' = ${input.startEventId}`,
      ),
    )
    .limit(1)
  if (terminated.length > 0) return

  await db.insert(events).values({
    userId: start.userId,
    type: 'focus.cancelled',
    payload: { startEventId: input.startEventId },
    occurredAt: new Date(),
  })

  // Best-effort cancel of the scheduled push (it has its own
  // double-check on fire, but we save a wasted notification).
  const payload =
    start.payload && typeof start.payload === 'object'
      ? (start.payload as Record<string, unknown>)
      : {}
  const jobId = payload.scheduledJobId
  if (typeof jobId === 'string' && jobId.length > 0) {
    try {
      const { cancelFocusSessionEndJob } = await import('../boss')
      await cancelFocusSessionEndJob(jobId)
    } catch (err) {
      console.warn('[focus] failed to cancel scheduled end job', err)
    }
  }
}

export interface CompleteFocusSessionInput {
  userId: string
  durationMin: FocusDuration
  mode: FocusMode
  startEventId?: string | null
  taskInstanceId?: string | null
}

export interface CompleteFocusSessionResult {
  xp: number
  level: number
  tokens: number
  xpEarned: number
  tokensEarned: number
  // True when the call no-op'd because this session was already
  // confirmed (e.g., user tapped the push on a second device).
  duplicate: boolean
}

// Awards XP + tokens for a finished focus session. Task completion is a
// separate concern handled by the client (via `completeInstance`) so the
// user can confirm task completion independently of focus success.
export async function completeFocusSession(
  input: CompleteFocusSessionInput,
): Promise<CompleteFocusSessionResult> {
  const { userId, durationMin, mode } = input
  const taskInstanceId = input.taskInstanceId ?? null
  const startEventId = input.startEventId ?? null

  if (!isFocusDuration(durationMin)) {
    throw new Error('invalid focus duration')
  }
  const { tokens: tokensEarned, xp: xpEarned } = focusRewardsFor(mode)[durationMin]

  const timeZone = await getUserTimeZone(userId)
  const now = new Date()

  // Idempotency: if a completion event already exists for this start,
  // return the current progression unchanged so two devices racing on
  // the same notification can't double-credit.
  if (startEventId) {
    const existing = await db
      .select({ id: events.id })
      .from(events)
      .where(
        and(
          eq(events.userId, userId),
          eq(events.type, 'focus.completed'),
          sql`${events.payload}->>'startEventId' = ${startEventId}`,
        ),
      )
      .limit(1)
    if (existing.length > 0) {
      const current = await db.query.progression.findFirst({
        where: eq(progression.userId, userId),
      })
      return {
        xp: current?.xp ?? 0,
        level: current?.level ?? 1,
        tokens: current?.tokens ?? 0,
        xpEarned: 0,
        tokensEarned: 0,
        duplicate: true,
      }
    }
  }

  const focusEvent: DomainEvent = {
    type: 'focus.completed',
    durationMin,
    taskInstanceId,
    tokensEarned,
    xpEarned,
    mode,
    startEventId,
    occurredAt: now,
  }

  const result = await db.transaction(async (tx) => {
    await tx.insert(events).values({
      userId,
      type: focusEvent.type,
      payload: {
        durationMin,
        taskInstanceId,
        tokensEarned,
        xpEarned,
        mode,
        startEventId,
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

  // If we just credited a pocket session, kill any still-pending push
  // job (e.g., user confirmed early via the in-app modal before the
  // scheduled fire time).
  if (startEventId && mode === 'pocket') {
    const start = await db.query.events.findFirst({
      where: eq(events.id, startEventId),
    })
    const payload =
      start?.payload && typeof start.payload === 'object'
        ? (start.payload as Record<string, unknown>)
        : {}
    const jobId = payload.scheduledJobId
    if (typeof jobId === 'string' && jobId.length > 0) {
      try {
        const { cancelFocusSessionEndJob } = await import('../boss')
        await cancelFocusSessionEndJob(jobId)
      } catch (err) {
        console.warn('[focus] failed to cancel scheduled end job', err)
      }
    }
  }

  return {
    xp: result.xp,
    level: result.level,
    tokens: result.tokens,
    xpEarned,
    tokensEarned,
    duplicate: false,
  }
}
