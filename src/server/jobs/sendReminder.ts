import { eq } from 'drizzle-orm'
import { db } from '../db/client'
import {
  pushSubscriptions,
  taskInstances,
  tasks,
  user as userTable,
} from '../db/schema'
import { sendWebPush } from '../push/web-push'
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

  const owner = await db.query.user.findFirst({
    where: eq(userTable.id, instance.userId),
    columns: {
      timezone: true,
      quietHoursStart: true,
      quietHoursEnd: true,
    },
  })
  const timezone = owner?.timezone ?? 'UTC'

  // Escalations respect quiet hours. The initial reminder was scheduled by
  // the user (they chose this timeOfDay) so we send it even in quiet hours;
  // nudges are our idea and should stay silent at night.
  if (
    attempt > 1 &&
    isInQuietHours(
      now,
      owner?.quietHoursStart ?? null,
      owner?.quietHoursEnd ?? null,
      timezone,
    )
  ) {
    return
  }

  const subs = await db.query.pushSubscriptions.findMany({
    where: eq(pushSubscriptions.userId, instance.userId),
  })
  if (subs.length === 0) return

  const { title, body } = reminderCopy(task.title, task.timeOfDay, attempt)

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

  if (attempt < MAX_REMINDER_ATTEMPTS) {
    const nextAt = new Date(now.getTime() + ESCALATION_INTERVAL_MS)
    // Don't chain a nudge into quiet hours. Skipping here ends the chain
    // cleanly rather than silently piling up jobs.
    if (
      !isInQuietHours(
        nextAt,
        owner?.quietHoursStart ?? null,
        owner?.quietHoursEnd ?? null,
        timezone,
      )
    ) {
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
