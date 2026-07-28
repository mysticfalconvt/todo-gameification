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
  if (!isEmailConfigured()) {
    console.warn('[weekly-summary] SMTP not configured; skipping run')
    return
  }
  const now = new Date()

  // Per-run tally so each hourly tick leaves a visible trace in the logs —
  // otherwise a run where every user is off-slot, unverified, or a send
  // silently fails is indistinguishable from the cron never firing.
  let dueThisTick = 0
  let sent = 0
  let skippedUnverified = 0
  let skippedNonMember = 0
  let alreadySent = 0
  let failed = 0

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

    // From here on the user is due this tick — count them so the log
    // distinguishes "nobody was due" from "due but not delivered".
    dueThisTick++

    // Unverified (or missing) email addresses are skipped by design, but
    // count them: a user who never got a weekly email is often one whose
    // verification email itself failed, and this makes that visible.
    if (!u.email || !u.emailVerified) {
      skippedUnverified++
      continue
    }

    try {
      const member = await getEffectiveMemberStatus(u.id)
      if (!member.isMember) {
        skippedNonMember++
        continue
      }

      const summary = await getWeeklySummary(u.id)

      // Dedup gate: claim this week for this user. If the row already
      // exists, another tick already sent it — skip.
      const claimed = await db
        .insert(weeklyEmailLog)
        .values({ userId: u.id, weekKey: summary.weekKey })
        .onConflictDoNothing()
        .returning({ userId: weeklyEmailLog.userId })
      if (claimed.length === 0) {
        alreadySent++
        continue
      }

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
        sent++
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
      failed++
      console.error('[weekly-summary] failed for', u.id, err)
    }
  }

  // Only log when the tick actually had work to do — an idle hour (no user
  // in their configured slot) stays quiet so the logs aren't flooded 24x/day.
  if (dueThisTick > 0) {
    console.log(
      `[weekly-summary] tick done: due=${dueThisTick} sent=${sent} ` +
        `already-sent=${alreadySent} skipped-unverified=${skippedUnverified} ` +
        `skipped-non-member=${skippedNonMember} failed=${failed}`,
    )
  }
}

export type DeliverWeeklyResult =
  | { status: 'sent'; weekKey: string }
  | { status: 'smtp-not-configured' }
  | { status: 'user-not-found' }
  | { status: 'no-email' }
  | { status: 'already-sent'; weekKey: string }

// Send one user's weekly summary on demand — powers the admin "Send now"
// button and any support-driven resend.
//
// IMPORTANT: a forced (admin) send must NOT write weekly_email_log. The
// dedup key is the Monday-anchored weekKey, and that key does not advance
// until the next Monday — so Monday's and (say) Saturday's sends share one
// weekKey. If a forced resend claimed that row, the user's *scheduled* send
// later in the same week would be skipped as "already-sent" — which is
// exactly how a Jul-25 send got suppressed after a Jul-20 delivery of the
// same weekKey. So: `force` sends the email and touches nothing else, and
// only the scheduled path (and non-forced callers) claim the dedup row.
export async function deliverWeeklySummaryToUser(
  userId: string,
  opts: { force: boolean },
): Promise<DeliverWeeklyResult> {
  if (!isEmailConfigured()) return { status: 'smtp-not-configured' }

  const [u] = await db
    .select({ email: userTable.email })
    .from(userTable)
    .where(eq(userTable.id, userId))
    .limit(1)
  if (!u) return { status: 'user-not-found' }
  if (!u.email) return { status: 'no-email' }

  const summary = await getWeeklySummary(userId)

  // Non-forced sends claim the once-per-week row up front so the scheduled
  // cron and a concurrent resend can't double up. Forced sends skip this
  // entirely and never write the dedup log (see note above).
  let claimedHere = false
  if (!opts.force) {
    const claimed = await db
      .insert(weeklyEmailLog)
      .values({ userId, weekKey: summary.weekKey })
      .onConflictDoNothing()
      .returning({ userId: weeklyEmailLog.userId })
    if (claimed.length === 0) {
      return { status: 'already-sent', weekKey: summary.weekKey }
    }
    claimedHere = true
  }

  try {
    const [analysis, householdAnalysis] = await Promise.all([
      generateWeeklyAnalysis(userId, summary),
      generateHouseholdAnalysis(userId, summary),
    ])
    const { subject, text, html } = renderWeeklyEmail(
      summary,
      analysis?.analysis ?? null,
      householdAnalysis?.analysis ?? null,
    )
    await sendMail({ to: u.email, subject, text, html })
  } catch (sendErr) {
    // Release a claim we made so a failed non-forced send can be retried.
    if (claimedHere) {
      await db
        .delete(weeklyEmailLog)
        .where(
          and(
            eq(weeklyEmailLog.userId, userId),
            eq(weeklyEmailLog.weekKey, summary.weekKey),
          ),
        )
        .catch(() => {})
    }
    throw sendErr
  }

  return { status: 'sent', weekKey: summary.weekKey }
}
