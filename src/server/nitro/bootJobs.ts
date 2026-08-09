// Nitro startup plugin: eagerly boot pg-boss when the server process starts,
// instead of waiting for the first request that happens to schedule a job
// (task create / focus / doomscroll / admin stats).
//
// Why this matters: pg-boss's cron scheduler and workers only run inside a
// live boss instance, and pg-boss does NOT backfill a cron tick that passed
// while it was down. Before this plugin, a fresh container that received no
// job-triggering action before a user's weekly-summary hour would silently
// miss that week's send. Booting here makes the scheduler live for the whole
// process lifetime regardless of traffic shape.
//
// Fire-and-forget on purpose: registerJobWorkers() is idempotent and cached,
// so we don't block server readiness on the DB handshake. A boot failure is
// logged, not fatal — the lazy getBoss() callers still work for scheduling,
// and the next process start retries registration.
//
// This is now the ONLY place workers get registered. boss.ts provisions the
// queues and schedules jobs but starts no workers, so that services can import
// it without pulling in every job handler (see the note there).
import type { NitroApp } from 'nitro/types'
import { registerJobWorkers } from '../jobs/register'

export default function bootJobsPlugin(_nitroApp: NitroApp): void {
  registerJobWorkers()
    .then(() => {
      console.log('[boot] pg-boss started; workers and cron schedulers active')
    })
    .catch((err) => {
      console.error('[boot] pg-boss failed to start', err)
    })
}
