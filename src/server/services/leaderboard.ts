// Leaderboard service. Ranks viewer + eligible users by three metrics over a
// rolling window. Respects profileVisibility + user_prefs.shareProgression.
import { and, eq, gte, inArray, isNotNull, or } from 'drizzle-orm'
import { db } from '../db/client'
import {
  events,
  friendships,
  user as userTable,
  userPrefs,
} from '../db/schema'

export type LeaderboardScope = 'friends' | 'global'
export type LeaderboardMetric = 'xp' | 'streak' | 'showed-up'
export type LeaderboardWindow = 7 | 30 | 90 | 'all'

export interface LeaderboardRow {
  rank: number
  userId: string
  handle: string
  name: string
  value: number
  isMe: boolean
}

interface CandidateUser {
  id: string
  handle: string
  name: string
  timezone: string
}

async function friendIdsFor(userId: string): Promise<string[]> {
  const rows = await db
    .select({
      requester: friendships.requesterId,
      addressee: friendships.addresseeId,
    })
    .from(friendships)
    .where(
      and(
        eq(friendships.status, 'accepted'),
        or(
          eq(friendships.requesterId, userId),
          eq(friendships.addresseeId, userId),
        ),
      ),
    )
  return rows.map((r) =>
    r.requester === userId ? r.addressee : r.requester,
  )
}

// Resolve the viewer + the users eligible to appear in their leaderboard.
// Friends scope: me + accepted friends. Global scope: me + everyone with
// profileVisibility=public.
// Either way we drop users whose shareProgression pref is false, unless that
// user is the viewer (they always see themselves).
async function loadCandidates(
  viewerId: string,
  scope: LeaderboardScope,
): Promise<CandidateUser[]> {
  let ids: string[]
  if (scope === 'friends') {
    ids = [viewerId, ...(await friendIdsFor(viewerId))]
  } else {
    const publicUsers = await db
      .select({ id: userTable.id })
      .from(userTable)
      .where(eq(userTable.profileVisibility, 'public'))
    ids = Array.from(new Set([viewerId, ...publicUsers.map((u) => u.id)]))
  }
  if (ids.length === 0) return []

  const rows = await db
    .select({
      id: userTable.id,
      handle: userTable.handle,
      name: userTable.name,
      timezone: userTable.timezone,
      shareProgression: userPrefs.shareProgression,
    })
    .from(userTable)
    .leftJoin(userPrefs, eq(userPrefs.userId, userTable.id))
    .where(inArray(userTable.id, ids))

  return rows
    .filter(
      (r) => r.id === viewerId || (r.shareProgression ?? true) === true,
    )
    .map((r) => ({
      id: r.id,
      handle: r.handle,
      name: r.name,
      timezone: r.timezone,
    }))
}

export async function getLeaderboard(
  viewerId: string,
  opts: {
    scope: LeaderboardScope
    metric: LeaderboardMetric
    days: LeaderboardWindow
  },
): Promise<LeaderboardRow[]> {
  const { scope, metric, days } = opts
  const candidates = await loadCandidates(viewerId, scope)
  if (candidates.length === 0) return []
  const candidateIds = candidates.map((c) => c.id)

  const since =
    days === 'all'
      ? new Date(0)
      : new Date(Date.now() - (days as number) * 24 * 3_600_000)

  const rows = await db
    .select({
      userId: events.userId,
      payload: events.payload,
      occurredAt: events.occurredAt,
    })
    .from(events)
    .where(
      and(
        eq(events.type, 'task.completed'),
        isNotNull(events.occurredAt),
        gte(events.occurredAt, since),
        inArray(events.userId, candidateIds),
      ),
    )

  const valueByUser = computeMetric(metric, candidates, rows)

  // Keep every candidate so the viewer sees themselves at 0 when relevant.
  const ranked: LeaderboardRow[] = candidates
    .map((c) => ({
      userId: c.id,
      handle: c.handle,
      name: c.name,
      value: valueByUser.get(c.id) ?? 0,
      isMe: c.id === viewerId,
      rank: 0,
    }))
    .sort((a, b) => b.value - a.value || a.handle.localeCompare(b.handle))

  // Dense rank (ties share a rank, next row jumps).
  let lastValue = Number.POSITIVE_INFINITY
  let currentRank = 0
  ranked.forEach((row, idx) => {
    if (row.value !== lastValue) {
      currentRank = idx + 1
      lastValue = row.value
    }
    row.rank = currentRank
  })

  return ranked
}

function computeMetric(
  metric: LeaderboardMetric,
  candidates: CandidateUser[],
  rows: Array<{
    userId: string
    payload: unknown
    occurredAt: Date | null
  }>,
): Map<string, number> {
  const tzByUser = new Map(candidates.map((c) => [c.id, c.timezone]))
  const values = new Map<string, number>()

  if (metric === 'xp') {
    for (const r of rows) {
      if (!r.occurredAt) continue
      const p =
        r.payload && typeof r.payload === 'object'
          ? (r.payload as Record<string, unknown>)
          : {}
      const xpOverride =
        typeof p['xpOverride'] === 'number'
          ? (p['xpOverride'] as number)
          : null
      const difficulty =
        typeof p['difficulty'] === 'string' ? p['difficulty'] : null
      const xp =
        xpOverride ??
        (difficulty === 'small' ? 10 : difficulty === 'large' ? 60 : 25)
      values.set(r.userId, (values.get(r.userId) ?? 0) + xp)
    }
    return values
  }

  // For streak + showed-up we need distinct local-day counts per user.
  const daysByUser = new Map<string, Set<string>>()
  for (const r of rows) {
    if (!r.occurredAt) continue
    const tz = tzByUser.get(r.userId) ?? 'UTC'
    const key = localDayKey(r.occurredAt, tz)
    let set = daysByUser.get(r.userId)
    if (!set) {
      set = new Set()
      daysByUser.set(r.userId, set)
    }
    set.add(key)
  }

  if (metric === 'showed-up') {
    for (const [userId, set] of daysByUser) {
      values.set(userId, set.size)
    }
    return values
  }

  // metric === 'streak' — longest consecutive-day run within window.
  for (const [userId, set] of daysByUser) {
    values.set(userId, longestConsecutiveRun(set))
  }
  return values
}

function localDayKey(date: Date, timeZone: string): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(date)
}

function longestConsecutiveRun(dayKeys: Set<string>): number {
  if (dayKeys.size === 0) return 0
  // Parse YYYY-MM-DD keys into epoch-day numbers so "consecutive" is simple
  // integer math. en-CA format guarantees ISO ordering.
  const daysEpoch = Array.from(dayKeys)
    .map((k) => {
      const [y, m, d] = k.split('-').map(Number)
      return Date.UTC(y, m - 1, d) / 86_400_000
    })
    .sort((a, b) => a - b)
  let longest = 1
  let current = 1
  for (let i = 1; i < daysEpoch.length; i++) {
    if (daysEpoch[i] === daysEpoch[i - 1] + 1) {
      current += 1
      if (current > longest) longest = current
    } else if (daysEpoch[i] === daysEpoch[i - 1]) {
      // dup, ignore
    } else {
      current = 1
    }
  }
  return longest
}
