import { PgBoss } from 'pg-boss'
import {
  sendReminderHandler,
  type SendReminderJobData,
} from './jobs/sendReminder'
import { cleanupStaleSubsHandler } from './jobs/cleanupStaleSubs'

let instance: PgBoss | null = null
let booting: Promise<PgBoss> | null = null

async function boot(): Promise<PgBoss> {
  const url = process.env.DATABASE_URL
  if (!url) throw new Error('DATABASE_URL is not set')
  const boss = new PgBoss(url)
  boss.on('error', (e) => console.error('pg-boss error', e))
  await boss.start()
  await boss.createQueue('send-reminder')
  await boss.createQueue('cleanup-stale-subs')
  await boss.work('send-reminder', sendReminderHandler)
  await boss.work('cleanup-stale-subs', async () => cleanupStaleSubsHandler())
  await boss.schedule('cleanup-stale-subs', '0 3 * * *')
  return boss
}

export async function getBoss(): Promise<PgBoss> {
  if (instance) return instance
  if (!booting) {
    booting = boot()
      .then((b) => {
        instance = b
        return b
      })
      .catch((err) => {
        booting = null
        throw err
      })
  }
  return booting
}

export async function scheduleReminder(
  data: SendReminderJobData,
  fireAt: Date,
): Promise<void> {
  const boss = await getBoss()
  await boss.sendAfter(
    'send-reminder',
    data,
    {
      singletonKey: `reminder-${data.taskInstanceId}-${data.kind}`,
      retryLimit: 3,
      retryBackoff: true,
    },
    fireAt,
  )
}
