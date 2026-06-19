import { eq, inArray } from 'drizzle-orm'
import { db } from '../db/client'
import {
  pushSubscriptions,
  taskInstances,
  tasks,
  user as userTable,
} from '../db/schema'
import { sendWebPush } from '../push/web-push'
import { listChoreRecipients } from '../services/households'
import { isInQuietHours } from '../../domain/quietHours'
import type { Job } from 'pg-boss'

// How many times total we'll push for a single instance. 1 = initial push
// only, 3 = initial + 2 escalations (at T, T+2h, T+4h).
export const MAX_REMINDER_ATTEMPTS = 3
export const ESCALATION_INTERVAL_MS = 2 * 60 * 60 * 1000

export interface SendReminderJobData {
  taskInstanceId: string
  // Attempt number: 1 = initial reminder, 2..MAX = escalation nudges.
  // Legacy jobs that predate the escalation work will be missing this
  // field; handler defaults to 1 to keep them behaving as before.
  attempt?: number
}

export async function sendReminderHandler(
  jobs: Job<SendReminderJobData>[],
): Promise<void> {
  for (const job of jobs) {
    await handleOne(job.data)
  }
}

async function handleOne(data: SendReminderJobData) {
  const attempt = data.attempt ?? 1
  const instance = await db.query.taskInstances.findFirst({
    where: eq(taskInstances.id, data.taskInstanceId),
  })
  if (!instance) return
  // Any user action on the instance cancels the escalation chain.
  if (instance.completedAt || instance.skippedAt) return

  const now = new Date()
  if (instance.snoozedUntil && instance.snoozedUntil > now) return

  const task = await db.query.tasks.findFirst({
    where: eq(tasks.id, instance.taskId),
  })
  if (!task || !task.active) return
  if (task.snoozeUntil && task.snoozeUntil > now) return

  // Route the reminder to whoever the task is *for*, not whoever created
  // it. Household chores carry their assignment on the instance:
  //   assignedToUserId → that specific person
  //   assigneeGroup    → everyone in that role group (kids / adults)
  //   free-for-all     → everyone in the household (kiosk excluded)
  // Personal tasks (no householdId) still go to their owner.
  let recipientIds: string[]
  if (instance.assignedToUserId) {
    recipientIds = [instance.assignedToUserId]
  } else if (instance.householdId) {
    recipientIds = await listChoreRecipients(
      instance.householdId,
      instance.assigneeGroup as 'adults' | 'kids' | null,
    )
  } else {
    recipientIds = [instance.userId]
  }
  if (recipientIds.length === 0) return

  const recipients = await db.query.user.findMany({
    where: inArray(userTable.id, recipientIds),
    columns: {
      id: true,
      timezone: true,
      quietHoursStart: true,
      quietHoursEnd: true,
    },
  })

  const allSubs = await db.query.pushSubscriptions.findMany({
    where: inArray(pushSubscriptions.userId, recipientIds),
  })
  if (allSubs.length === 0) return

  // Escalations respect each recipient's quiet hours. The initial reminder
  // was scheduled by the user (they chose this timeOfDay) so it sends even
  // in quiet hours; nudges are our idea and stay silent at night. Quiet
  // hours are per-user, so we suppress recipients individually rather than
  // dropping the whole send.
  const activeIds = new Set(
    recipients
      .filter(
        (u) =>
          attempt <= 1 ||
          !isInQuietHours(
            now,
            u.quietHoursStart ?? null,
            u.quietHoursEnd ?? null,
            u.timezone ?? 'UTC',
          ),
      )
      .map((u) => u.id),
  )
  const subs = allSubs.filter((s) => activeIds.has(s.userId))

  const { title, body } = reminderCopy(task.title, task.timeOfDay, attempt)

  // subs can be empty when every recipient is currently in quiet hours on
  // a nudge — skip the send but still consider rescheduling below.
  if (subs.length > 0) {
    await Promise.allSettled(
      subs.map(async (sub) => {
        const result = await sendWebPush(
          {
            endpoint: sub.endpoint,
            keys: { p256dh: sub.p256dh, auth: sub.auth },
          },
          {
            title,
            body,
            tag: `task-${task.id}`,
            taskInstanceId: instance.id,
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

  if (attempt < MAX_REMINDER_ATTEMPTS) {
    const nextAt = new Date(now.getTime() + ESCALATION_INTERVAL_MS)
    // Only chain another nudge if at least one recipient would be reachable
    // (outside their quiet hours) at that time. If everyone's asleep then,
    // ending the chain here beats silently piling up no-op jobs.
    const anyReachable = recipients.some(
      (u) =>
        !isInQuietHours(
          nextAt,
          u.quietHoursStart ?? null,
          u.quietHoursEnd ?? null,
          u.timezone ?? 'UTC',
        ),
    )
    if (anyReachable) {
      // Avoid importing boss.ts at module top because this file is imported
      // by boss.ts — would create a cycle. Dynamic import keeps both files
      // self-contained.
      const { scheduleReminder } = await import('../boss')
      await scheduleReminder(
        { taskInstanceId: instance.id, attempt: attempt + 1 },
        nextAt,
      ).catch((e) => console.error('escalation reschedule failed', e))
    }
  }
}

function reminderCopy(
  title: string,
  timeOfDay: string | null,
  attempt: number,
): { title: string; body: string } {
  if (attempt <= 1) {
    return {
      title,
      body: timeOfDay ? 'Due now' : 'Due today',
    }
  }
  // Nudges get a softer, distinct voice so the user can tell it's a
  // follow-up and not a fresh notification for a new task.
  return {
    title: `Still on your list: ${title}`,
    body:
      attempt >= MAX_REMINDER_ATTEMPTS
        ? 'Last nudge for this one.'
        : 'Ready to knock it out?',
  }
}
