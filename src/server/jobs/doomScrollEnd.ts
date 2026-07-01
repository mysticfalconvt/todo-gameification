import { eq } from 'drizzle-orm'
import { db } from '../db/client'
import { pushSubscriptions } from '../db/schema'
import { sendWebPush } from '../push/web-push'
import type { Job } from 'pg-boss'

export interface DoomScrollEndJobData {
  startEventId: string
  userId: string
  durationMin: number
}

// Fires when a doom-scroll break timer expires. Pushes the user to get
// back to work. There's no confirm/cancel flow — the token was spent and
// the XP granted at start — so this is a pure reminder with no state
// check beyond finding the user's push subscriptions.
export async function doomScrollEndHandler(
  jobs: Job<DoomScrollEndJobData>[],
): Promise<void> {
  for (const job of jobs) {
    await handleOne(job.data)
  }
}

async function handleOne(data: DoomScrollEndJobData) {
  const subs = await db.query.pushSubscriptions.findMany({
    where: eq(pushSubscriptions.userId, data.userId),
  })
  if (subs.length === 0) return

  await Promise.allSettled(
    subs.map(async (sub) => {
      const result = await sendWebPush(
        {
          endpoint: sub.endpoint,
          keys: { p256dh: sub.p256dh, auth: sub.auth },
        },
        {
          title: '💀 Time to resurface',
          body: `Your ${data.durationMin}-min scroll break is up — back to it.`,
          tag: `doomscroll-end-${data.startEventId}`,
          url: '/today',
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
