// Worker + cron registration. This is the only module that imports job
// handlers, which is what lets `boss.ts` stay importable from a service
// (handlers import services; see the note at the top of boss.ts).
//
// Called once per server process by the nitro startup plugin.
import { getBoss } from '../boss'
import {
  CLEANUP_SUBS_QUEUE,
  DOOMSCROLL_END_QUEUE,
  FOCUS_END_QUEUE,
  FOCUS_EXPIRE_QUEUE,
  GITHUB_POLL_QUEUE,
  PLANT_RISK_QUEUE,
  REMINDER_QUEUE,
  WEEKLY_SUMMARY_QUEUE,
} from './queues'
import { sendReminderHandler } from './sendReminder'
import { cleanupStaleSubsHandler } from './cleanupStaleSubs'
import { checkPlantRiskHandler } from './checkPlantRisk'
import { githubPollHandler } from './githubPoll'
import { sendWeeklySummaryHandler } from './sendWeeklySummary'
import { focusSessionEndHandler, focusSessionExpireHandler } from './focusSessionEnd'
import { doomScrollEndHandler } from './doomScrollEnd'

let registered: Promise<void> | null = null

async function register(): Promise<void> {
  const boss = await getBoss()

  await boss.work(REMINDER_QUEUE, sendReminderHandler)
  await boss.work(CLEANUP_SUBS_QUEUE, async () => cleanupStaleSubsHandler())
  await boss.work(PLANT_RISK_QUEUE, async () => checkPlantRiskHandler())
  await boss.work(GITHUB_POLL_QUEUE, async () => githubPollHandler())
  await boss.work(WEEKLY_SUMMARY_QUEUE, async () => sendWeeklySummaryHandler())
  await boss.work(FOCUS_END_QUEUE, focusSessionEndHandler)
  await boss.work(FOCUS_EXPIRE_QUEUE, focusSessionExpireHandler)
  await boss.work(DOOMSCROLL_END_QUEUE, doomScrollEndHandler)

  await boss.schedule(CLEANUP_SUBS_QUEUE, '0 3 * * *')
  // Runs at :00 every hour, UTC. The handler filters to users whose
  // local hour is 18 and only sends to those with at-risk plants.
  await boss.schedule(PLANT_RISK_QUEUE, '0 * * * *')
  // Fires every minute; handler filters users by their per-integration
  // poll_interval_minutes (so a user with 15-min interval only gets
  // polled every 15 min, not every tick).
  await boss.schedule(GITHUB_POLL_QUEUE, '* * * * *')
  // Runs at :00 every hour, UTC. The handler filters to opted-in members
  // whose local time is Monday 08:00 and dedups via weekly_email_log.
  await boss.schedule(WEEKLY_SUMMARY_QUEUE, '0 * * * *')
}

// Idempotent and cached, mirroring getBoss() — calling it twice in one
// process registers workers once.
export function registerJobWorkers(): Promise<void> {
  if (!registered) {
    registered = register().catch((err) => {
      registered = null
      throw err
    })
  }
  return registered
}
