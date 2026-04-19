// Hourly cron that, at the user's local 18:00, fires a push listing
// plants whose streak will break if today ends without a watering.
// "At risk" = the plant's last watering was yesterday in the user's
// timezone and there's no watering yet today. We fire one push per
// user, tagged `garden-risk` so browsers collapse any accidental
// duplicates across retries or missed ticks.
import { formatInTimeZone } from 'date-fns-tz'
import { isNotNull } from 'drizzle-orm'
import { db } from '../db/client'
import { user as userTable } from '../db/schema'
import { isInQuietHours } from '../../domain/quietHours'
import { sendPushToUser } from '../push/broadcast'
import { getGarden } from '../services/garden'

// The user's local hour at which the push fires. Hard-coded for v1;
// settings can grow a picker later.
const RISK_HOUR_LOCAL = 18

export async function checkPlantRiskHandler(): Promise<void> {
  const now = new Date()
  const users = await db
    .select({
      id: userTable.id,
      timezone: userTable.timezone,
      quietHoursStart: userTable.quietHoursStart,
      quietHoursEnd: userTable.quietHoursEnd,
    })
    .from(userTable)
    .where(isNotNull(userTable.timezone))

  const yesterdayMs = now.getTime() - 24 * 60 * 60 * 1000

  for (const u of users) {
    const tz = u.timezone || 'UTC'
    let localHour: number
    try {
      localHour = Number(formatInTimeZone(now, tz, 'H'))
    } catch {
      continue
    }
    if (localHour !== RISK_HOUR_LOCAL) continue
    // Quiet hours shouldn't matter at 18:00 but respect them anyway —
    // some users may have set an unusual window (sleep-shift work etc).
    if (
      isInQuietHours(
        now,
        u.quietHoursStart ?? null,
        u.quietHoursEnd ?? null,
        tz,
      )
    ) {
      continue
    }

    let garden
    try {
      garden = await getGarden(u.id)
    } catch (err) {
      console.error('[plant-risk] getGarden failed for', u.id, err)
      continue
    }

    const today = formatInTimeZone(now, tz, 'yyyy-MM-dd')
    const yesterday = formatInTimeZone(new Date(yesterdayMs), tz, 'yyyy-MM-dd')

    const atRisk = garden.plants.filter((p) => {
      if (!p.lastWateredAt) return false
      const lastLocal = formatInTimeZone(
        new Date(p.lastWateredAt),
        tz,
        'yyyy-MM-dd',
      )
      // Already watered today → safe.
      if (lastLocal === today) return false
      // Only warn for plants that had yesterday's watering — a plant
      // that's been dormant for days isn't "about to" break anything.
      return lastLocal === yesterday
    })

    if (atRisk.length === 0) continue

    const title =
      atRisk.length === 1
        ? `🌿 ${atRisk[0].label} needs a watering today`
        : `🌿 ${atRisk.length} plants at risk`
    const body =
      atRisk.length === 1
        ? 'A quick task before bed keeps the streak going.'
        : atRisk.map((p) => p.label).join(', ')

    try {
      await sendPushToUser(u.id, {
        title,
        body,
        tag: 'garden-risk',
        url: '/garden',
      })
    } catch (err) {
      console.error('[plant-risk] push failed for', u.id, err)
    }
  }
}
