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
// Fire-and-forget on purpose: getBoss() is idempotent and cached, so we don't
// block server readiness on the DB handshake. A boot failure is logged, not
// fatal — the existing lazy getBoss() callers will retry on the next request.
import type { NitroApp } from 'nitro/types'
import { getBoss } from '../boss'

export default function bootJobsPlugin(_nitroApp: NitroApp): void {
  getBoss()
    .then(() => {
      console.log('[boot] pg-boss started; cron schedulers active')
    })
    .catch((err) => {
      console.error('[boot] pg-boss failed to start', err)
    })
}
