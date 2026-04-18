import { eq } from 'drizzle-orm'
import { db } from '../db/client'
import { pushSubscriptions, taskInstances, tasks } from '../db/schema'
import { sendWebPush } from '../push/web-push'
import type { Job } from 'pg-boss'

export interface SendReminderJobData {
  taskInstanceId: string
  kind: 'due'
}

export async function sendReminderHandler(
  jobs: Job<SendReminderJobData>[],
): Promise<void> {
  for (const job of jobs) {
    await handleOne(job.data)
  }
}

async function handleOne(data: SendReminderJobData) {
  const instance = await db.query.taskInstances.findFirst({
    where: eq(taskInstances.id, data.taskInstanceId),
  })
  if (!instance) return
  if (instance.completedAt || instance.skippedAt) return

  const now = new Date()
  if (instance.snoozedUntil && instance.snoozedUntil > now) return

  const task = await db.query.tasks.findFirst({
    where: eq(tasks.id, instance.taskId),
  })
  if (!task || !task.active) return
  if (task.snoozeUntil && task.snoozeUntil > now) return

  const subs = await db.query.pushSubscriptions.findMany({
    where: eq(pushSubscriptions.userId, instance.userId),
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
          title: task.title,
          body: task.timeOfDay ? `Due now` : `Due today`,
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
