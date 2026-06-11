// Hourly cron that, at each opted-in member's local Monday 08:00, emails
// them a recap of the week just finished. Mirrors checkPlantRisk: the
// queue fires every hour and the handler filters users to those whose
// local time is Monday 8am right now.
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
import { getMemberStatus } from '../services/membership'
import {
  generateWeeklyAnalysis,
  getWeeklySummary,
} from '../services/weeklySummary'
import { renderWeeklyEmail } from './weeklySummaryEmail'

// Local hour at which the email fires. Monday is ISO weekday 1.
const SEND_HOUR_LOCAL = 8
const SEND_ISO_DOW = 1

export async function sendWeeklySummaryHandler(): Promise<void> {
  if (!isEmailConfigured()) return
  const now = new Date()

  const candidates = await db
    .select({
      id: userTable.id,
      email: userTable.email,
      emailVerified: userTable.emailVerified,
      timezone: userTable.timezone,
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
    if (localDow !== SEND_ISO_DOW || localHour !== SEND_HOUR_LOCAL) continue

    try {
      const member = await getMemberStatus(u.id)
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
        const analysis = await generateWeeklyAnalysis(u.id, summary)
        const { subject, text, html } = renderWeeklyEmail(
          summary,
          analysis?.analysis ?? null,
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
