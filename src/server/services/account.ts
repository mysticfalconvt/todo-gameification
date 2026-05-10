// Self-serve account deletion. Cancels the Stripe subscription if any,
// then deletes every user-owned row. Most tables cascade off `user.id`,
// but a handful (events, progression, push_subscriptions, llm_call_log,
// task_instances by way of tasks → cascade, email_send_log by email,
// verification by identifier) need explicit cleanup since they store
// `user_id` as plain text without a FK or are keyed by email.
//
// This is irreversible. Callers should require an explicit user
// confirmation (see DangerZoneSection in settings/index.tsx).
import { eq } from 'drizzle-orm'
import { db } from '../db/client'
import {
  emailSendLog,
  events,
  llmCallLog,
  memberships,
  progression,
  pushSubscriptions,
  user as userTable,
  verification,
} from '../db/schema'
import { getStripe } from '../stripe/client'

export interface DeleteAccountResult {
  deletedUserId: string
  stripeSubscriptionCanceled: boolean
}

export async function deleteAccount(
  userId: string,
): Promise<DeleteAccountResult> {
  const target = await db.query.user.findFirst({
    where: eq(userTable.id, userId),
    columns: { id: true, email: true },
  })
  if (!target) throw new Error('user not found')

  // Pull the membership row before delete so we know whether to call
  // Stripe. We'll let the cascade clean up the projection itself.
  const membership = await db.query.memberships.findFirst({
    where: eq(memberships.userId, userId),
    columns: { stripeSubscriptionId: true, tier: true },
  })

  // Cancel any active Stripe subscription so the user isn't billed for
  // the next period. Fire-and-log: if Stripe is unreachable we still
  // delete the user — they can dispute the charge if it lands.
  let stripeSubscriptionCanceled = false
  if (
    membership?.stripeSubscriptionId &&
    membership.tier === 'annual'
  ) {
    try {
      const stripe = getStripe()
      await stripe.subscriptions.cancel(membership.stripeSubscriptionId)
      stripeSubscriptionCanceled = true
    } catch (err) {
      console.error('[account] failed to cancel Stripe subscription', {
        userId,
        subscriptionId: membership.stripeSubscriptionId,
        err,
      })
    }
  }

  const lowerEmail = target.email.toLowerCase()

  await db.transaction(async (tx) => {
    // Tables with no FK cascade: explicit delete.
    await tx.delete(events).where(eq(events.userId, userId))
    await tx.delete(progression).where(eq(progression.userId, userId))
    await tx
      .delete(pushSubscriptions)
      .where(eq(pushSubscriptions.userId, userId))
    await tx.delete(llmCallLog).where(eq(llmCallLog.userId, userId))

    // Email-keyed audit/verification rows.
    await tx
      .delete(emailSendLog)
      .where(eq(emailSendLog.email, lowerEmail))
    await tx
      .delete(verification)
      .where(eq(verification.identifier, target.email))

    // Finally drop the user. This cascades to:
    //   account, session, tasks (and via tasks: task_instances,
    //   task_steps, task_step_completions), userPrefs,
    //   userIntegrations, userCategories, apiTokens, friendships
    //   (both sides), memberships.
    await tx.delete(userTable).where(eq(userTable.id, userId))
  })

  return { deletedUserId: userId, stripeSubscriptionCanceled }
}
