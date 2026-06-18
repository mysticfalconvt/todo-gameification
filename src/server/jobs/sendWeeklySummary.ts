// Hourly cron that emails each opted-in member a recap of the week just
// finished at their chosen local weekday + hour (defaults Monday 08:00).
// Mirrors checkPlantRisk: the queue fires every hour and the handler
// filters users to those whose local time matches their configured slot.
//
// Idempotency: a (user, weekKey) row in weekly_email_log is inserted
// onConflictDoNothing before sending — we only send when the insert took
// effect, so retries, double-fires, and missed-then-caught-up ticks never
// send the same week twice.
import { and, eq } from 'drizzle-orm'
import { formatInTimeZone } from 'date-fns-tz'
import { db } from '../db/client'
import { user as userTable, userPrefs, weeklyEmailLog } from '../db/schema'
import { isEmailConfigured, sendMail } from '../email'
import { getEffectiveMemberStatus } from '../services/membership'
import {
  generateHouseholdAnalysis,
  generateWeeklyAnalysis,
  getWeeklySummary,
} from '../services/weeklySummary'
import { renderWeeklyEmail } from './weeklySummaryEmail'

export async function sendWeeklySummaryHandler(): Promise<void> {
  if (!isEmailConfigured()) return
  const now = new Date()

  const candidates = await db
    .select({
      id: userTable.id,
      email: userTable.email,
      emailVerified: userTable.emailVerified,
      timezone: userTable.timezone,
      // Per-user delivery time (ISO weekday 1..7, local hour 0..23).
      // Defaults are Monday/08:00 — see migration 0045.
      dow: userPrefs.weeklyEmailDow,
      hour: userPrefs.weeklyEmailHour,
    })
    .from(userPrefs)
    .innerJoin(userTable, eq(userTable.id, userPrefs.userId))
    .where(eq(userPrefs.weeklyEmailOptIn, true))

  for (const u of candidates) {
    if (!u.email || !u.emailVerified) continue
    const tz = u.timezone || 'UTC'
    let localHour: number
    let localDow: number
    try {
      localHour = Number(formatInTimeZone(now, tz, 'H'))
      localDow = Number(formatInTimeZone(now, tz, 'i'))
    } catch {
      continue
    }
    if (localDow !== u.dow || localHour !== u.hour) continue

    try {
      const member = await getEffectiveMemberStatus(u.id)
      if (!member.isMember) continue

      const summary = await getWeeklySummary(u.id)

      // Dedup gate: claim this week for this user. If the row already
      // exists, another tick already sent it — skip.
      const claimed = await db
        .insert(weeklyEmailLog)
        .values({ userId: u.id, weekKey: summary.weekKey })
        .onConflictDoNothing()
        .returning({ userId: weeklyEmailLog.userId })
      if (claimed.length === 0) continue

      try {
        const [analysis, householdAnalysis] = await Promise.all([
          generateWeeklyAnalysis(u.id, summary),
          generateHouseholdAnalysis(u.id, summary),
        ])
        const { subject, text, html } = renderWeeklyEmail(
          summary,
          analysis?.analysis ?? null,
          householdAnalysis?.analysis ?? null,
        )
        await sendMail({ to: u.email, subject, text, html })
      } catch (sendErr) {
        // Release the claim so the send isn't silently marked done.
        await db
          .delete(weeklyEmailLog)
          .where(
            and(
              eq(weeklyEmailLog.userId, u.id),
              eq(weeklyEmailLog.weekKey, summary.weekKey),
            ),
          )
          .catch(() => {})
        throw sendErr
      }
    } catch (err) {
      console.error('[weekly-summary] failed for', u.id, err)
    }
  }
}
