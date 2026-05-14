import { and, eq, sql } from 'drizzle-orm'
import { db } from '../db/client'
import { events, pushSubscriptions } from '../db/schema'
import { sendWebPush } from '../push/web-push'
import type { Job } from 'pg-boss'

export interface FocusSessionEndJobData {
  startEventId: string
  userId: string
}

// Fires when a pocket-mode focus session's expected end time arrives.
// Sends a push to all of the user's devices with a deep link that opens
// the in-app confirmation modal — XP is *not* applied here, the user
// has to confirm (honesty clause preserved across modes).
export async function focusSessionEndHandler(
  jobs: Job<FocusSessionEndJobData>[],
): Promise<void> {
  for (const job of jobs) {
    await handleOne(job.data)
  }
}

async function handleOne(data: FocusSessionEndJobData) {
  const start = await db.query.events.findFirst({
    where: and(
      eq(events.id, data.startEventId),
      eq(events.type, 'focus.started'),
    ),
  })
  if (!start) return

  // If the user already confirmed or cancelled (e.g., they tapped
  // "Cancel" before the timer fired, or finished early on another
  // device), suppress the push.
  const terminated = await db
    .select({ id: events.id })
    .from(events)
    .where(
      and(
        eq(events.userId, start.userId),
        sql`${events.type} in ('focus.completed', 'focus.cancelled')`,
        sql`${events.payload}->>'startEventId' = ${data.startEventId}`,
      ),
    )
    .limit(1)
  if (terminated.length > 0) return

  const payload =
    start.payload && typeof start.payload === 'object'
      ? (start.payload as Record<string, unknown>)
      : {}
  const durationMin =
    typeof payload.durationMin === 'number' ? payload.durationMin : null
  if (durationMin === null) return

  const subs = await db.query.pushSubscriptions.findMany({
    where: eq(pushSubscriptions.userId, start.userId),
  })
  if (subs.length === 0) return

  const url = `/focus?focus_confirm=${encodeURIComponent(data.startEventId)}`

  await Promise.allSettled(
    subs.map(async (sub) => {
      const result = await sendWebPush(
        {
          endpoint: sub.endpoint,
          keys: { p256dh: sub.p256dh, auth: sub.auth },
        },
        {
          title: 'Focus session complete',
          body: `${durationMin}-min session is up — tap to claim your XP.`,
          tag: `focus-end-${data.startEventId}`,
          url,
        },
      )
      if (!result.ok) {
        if (result.gone) {
          await db
            .delete(pushSubscriptions)
            .where(eq(pushSubscriptions.id, sub.id))
        } else {
          await db
            .update(pushSubscriptions)
            .set({
              failureCount: sub.failureCount + 1,
              lastFailureAt: new Date(),
            })
            .where(eq(pushSubscriptions.id, sub.id))
        }
      }
    }),
  )
}

// Auto-expire sweep: fires 24h after the expected end if the user
// never confirmed. Writes a focus.cancelled so the active-session
// lookup stops returning this row.
export interface FocusSessionExpireJobData {
  startEventId: string
  userId: string
}

export async function focusSessionExpireHandler(
  jobs: Job<FocusSessionExpireJobData>[],
): Promise<void> {
  for (const job of jobs) {
    const { startEventId, userId } = job.data
    try {
      const { cancelFocusSession } = await import('../services/focus')
      await cancelFocusSession({ userId, startEventId, trusted: true })
    } catch (err) {
      console.warn('[focus] auto-expire failed', err)
    }
  }
}
