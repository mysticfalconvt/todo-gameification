import { PgBoss } from 'pg-boss'
import {
  ESCALATION_INTERVAL_MS,
  MAX_REMINDER_ATTEMPTS,
  sendReminderHandler,
  type SendReminderJobData,
} from './jobs/sendReminder'
import { cleanupStaleSubsHandler } from './jobs/cleanupStaleSubs'
import { checkPlantRiskHandler } from './jobs/checkPlantRisk'
import { githubPollHandler } from './jobs/githubPoll'
import {
  focusSessionEndHandler,
  focusSessionExpireHandler,
  type FocusSessionEndJobData,
  type FocusSessionExpireJobData,
} from './jobs/focusSessionEnd'

const FOCUS_END_QUEUE = 'focus-session-end'
const FOCUS_EXPIRE_QUEUE = 'focus-session-expire'

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
  await boss.createQueue('check-plant-risk')
  await boss.createQueue('poll-github')
  await boss.createQueue(FOCUS_END_QUEUE)
  await boss.createQueue(FOCUS_EXPIRE_QUEUE)
  await boss.work('send-reminder', sendReminderHandler)
  await boss.work('cleanup-stale-subs', async () => cleanupStaleSubsHandler())
  await boss.work('check-plant-risk', async () => checkPlantRiskHandler())
  await boss.work('poll-github', async () => githubPollHandler())
  await boss.work(FOCUS_END_QUEUE, focusSessionEndHandler)
  await boss.work(FOCUS_EXPIRE_QUEUE, focusSessionExpireHandler)
  await boss.schedule('cleanup-stale-subs', '0 3 * * *')
  // Runs at :00 every hour, UTC. The handler filters to users whose
  // local hour is 18 and only sends to those with at-risk plants.
  await boss.schedule('check-plant-risk', '0 * * * *')
  // Fires every minute; handler filters users by their per-integration
  // poll_interval_minutes (so a user with 15-min interval only gets
  // polled every 15 min, not every tick).
  await boss.schedule('poll-github', '* * * * *')
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
      singletonKey: `reminder-${data.taskInstanceId}-${data.attempt ?? 1}`,
      retryLimit: 3,
      retryBackoff: true,
    },
    fireAt,
  )
}

// Returns the job id so the caller can persist it on the originating
// focus.started event (used for early-cancel via boss.cancel).
export async function scheduleFocusSessionEnd(
  data: FocusSessionEndJobData,
  fireAt: Date,
): Promise<string | null> {
  const boss = await getBoss()
  return await boss.sendAfter(
    FOCUS_END_QUEUE,
    data,
    {
      singletonKey: `focus-end-${data.startEventId}`,
      retryLimit: 2,
      retryBackoff: true,
    },
    fireAt,
  )
}

export async function scheduleFocusSessionExpire(
  data: FocusSessionExpireJobData,
  fireAt: Date,
): Promise<string | null> {
  const boss = await getBoss()
  return await boss.sendAfter(
    FOCUS_EXPIRE_QUEUE,
    data,
    {
      singletonKey: `focus-expire-${data.startEventId}`,
      retryLimit: 1,
    },
    fireAt,
  )
}

export async function cancelFocusSessionEndJob(jobId: string): Promise<void> {
  const boss = await getBoss()
  await boss.cancel(FOCUS_END_QUEUE, jobId)
}

export { ESCALATION_INTERVAL_MS, MAX_REMINDER_ATTEMPTS }
