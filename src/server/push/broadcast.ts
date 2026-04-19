// Fan-out push helper. Every consumer that wants to nudge a user should
// go through here so stale-subscription cleanup stays consistent.
import { eq } from 'drizzle-orm'
import { db } from '../db/client'
import { pushSubscriptions } from '../db/schema'
import { sendWebPush, type PushPayload } from './web-push'

export async function sendPushToUser(
  userId: string,
  payload: PushPayload,
): Promise<void> {
  const subs = await db.query.pushSubscriptions.findMany({
    where: eq(pushSubscriptions.userId, userId),
  })
  if (subs.length === 0) return
  await Promise.allSettled(
    subs.map(async (sub) => {
      const result = await sendWebPush(
        {
          endpoint: sub.endpoint,
          keys: { p256dh: sub.p256dh, auth: sub.auth },
        },
        payload,
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
