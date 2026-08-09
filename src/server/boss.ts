// pg-boss *client*: owns the singleton connection, ensures the queues exist,
// and exposes the schedule/cancel calls services use.
//
// It deliberately does NOT import job handlers. Registering workers lives in
// `jobs/register.ts`, which the nitro startup plugin calls. Splitting the two
// is what keeps this module importable from a service: handlers import
// services, so a registrar that also owned scheduling would close the loop
// boss.ts → jobs/* → services/* → boss.ts.
//
// Practical consequence: getBoss() gives you a live, queue-provisioned boss
// that can send jobs but won't process them. Only the registrar starts
// workers, and it runs once per server process.
import { PgBoss } from 'pg-boss'
import {
  ALL_QUEUES,
  DOOMSCROLL_END_QUEUE,
  FOCUS_END_QUEUE,
  FOCUS_EXPIRE_QUEUE,
  REMINDER_QUEUE,
  type DoomScrollEndJobData,
  type FocusSessionEndJobData,
  type FocusSessionExpireJobData,
  type SendReminderJobData,
} from './jobs/queues'

let instance: PgBoss | null = null
let booting: Promise<PgBoss> | null = null

async function boot(): Promise<PgBoss> {
  const url = process.env.DATABASE_URL
  if (!url) throw new Error('DATABASE_URL is not set')
  const boss = new PgBoss(url)
  boss.on('error', (e) => console.error('pg-boss error', e))
  await boss.start()
  // Queues must exist before anything can be sent to them, so this stays on
  // the client side rather than in the registrar.
  for (const queue of ALL_QUEUES) {
    await boss.createQueue(queue)
  }
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

export async function scheduleReminder(data: SendReminderJobData, fireAt: Date): Promise<void> {
  const boss = await getBoss()
  await boss.sendAfter(
    REMINDER_QUEUE,
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

// Schedules the "back to work" push for when a doom-scroll break timer
// expires. Returns the job id so the caller can persist it on the
// originating doomscroll.started event.
export async function scheduleDoomScrollEnd(
  data: DoomScrollEndJobData,
  fireAt: Date,
): Promise<string | null> {
  const boss = await getBoss()
  return await boss.sendAfter(
    DOOMSCROLL_END_QUEUE,
    data,
    {
      singletonKey: `doomscroll-end-${data.startEventId}`,
      retryLimit: 2,
      retryBackoff: true,
    },
    fireAt,
  )
}

export async function cancelFocusSessionEndJob(jobId: string): Promise<void> {
  const boss = await getBoss()
  await boss.cancel(FOCUS_END_QUEUE, jobId)
}
