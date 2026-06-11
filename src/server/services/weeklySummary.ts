// Weekly summary service.
//
// One aggregator — getWeeklySummary — folds the user's last *completed*
// Mon–Sun week into a single object: completions this week vs last week,
// per-day XP, all-time totals for repeating tasks, arcade activity, the
// friends XP leaderboard, and (if applicable) a household comparison.
// The /weekly-summary page and the Monday-morning email both consume it,
// so the stats logic lives in exactly one place.
//
// generateWeeklyAnalysis layers a short, cached LLM review on top ("did
// you do better, here's a nudge, nice work on X"). Cached per (user,
// weekKey) in weekly_summaries — mirrors the coach blurb cache.
//
// Week semantics: the summary always covers the most recently *completed*
// calendar week (last Mon–Sun) in the user's timezone, regardless of when
// it's viewed — so the page is a faithful preview of the Monday email.
import { and, eq, gte, inArray, isNotNull } from 'drizzle-orm'
import { formatInTimeZone } from 'date-fns-tz'
import { db } from '../db/client'
import {
  events,
  taskInstances,
  tasks,
  userPrefs,
  weeklySummaries,
} from '../db/schema'
import { callLlmChat } from '../llm/client'
import { sanitizeCoachOutput } from './coach'
import {
  getProgression,
  getUserTimeZone,
  type ProgressionSummary,
} from './tasks'
import { getArcadeStats, type ArcadeStats } from './arcadeStats'
import { getLeaderboard, type LeaderboardRow } from './leaderboard'
import {
  getMyHousehold,
  listHouseholdStats,
  type HouseholdStatsResult,
} from './households'

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface WeeklyKpis {
  completionsThisWeek: number
  completionsLastWeek: number
  xpThisWeek: number
  xpLastWeek: number
  // Per-weekday completion counts for the subject week, Mon..Sun (7 items).
  byWeekday: number[]
  // Current progression snapshot (point-in-time, not windowed).
  level: number
  totalXp: number
  currentStreak: number
  longestStreak: number
  tokens: number
}

export interface RepeatingTaskTotal {
  taskId: string
  title: string
  allTimeCount: number
  thisWeekCount: number
}

export interface WeeklyTopTask {
  taskId: string | null
  title: string
  count: number
}

export interface WeeklySummary {
  // ISO yyyy-MM-dd of the subject week's Monday, in the user's tz. Stable
  // per week — used as the cache key and the email dedup key.
  weekKey: string
  weekStartLabel: string
  weekEndLabel: string
  timeZone: string
  kpis: WeeklyKpis
  // XP + count per day for the subject week, Mon..Sun. Feeds XpLineSection.
  xpByDay: Array<{ date: string; xp: number; count: number }>
  topTasks: WeeklyTopTask[]
  repeatingTasks: RepeatingTaskTotal[]
  arcade: ArcadeStats
  leaderboard: LeaderboardRow[]
  household: { name: string; stats: HouseholdStatsResult } | null
}

// ---------------------------------------------------------------------------
// Week math
// ---------------------------------------------------------------------------

const DAY_MS = 86_400_000

function dayKey(date: Date, tz: string): string {
  return formatInTimeZone(date, tz, 'yyyy-MM-dd')
}

// ISO day of week for `now` in tz: 1 (Mon) .. 7 (Sun).
function isoDow(date: Date, tz: string): number {
  return Number(formatInTimeZone(date, tz, 'i'))
}

// Returns the local day-keys for the subject week (most recent completed
// Mon–Sun) and the prior week, plus an ordered Mon..Sun list for the
// subject week. Uses the same `now - k*DAY` day-key approach as coach.ts
// / households so bucketing is consistent across the codebase.
function computeWeekWindows(
  now: Date,
  tz: string,
): {
  weekKey: string
  thisWeekOrdered: string[] // Mon..Sun
  thisWeekSet: Set<string>
  lastWeekSet: Set<string>
} {
  const dow = isoDow(now, tz) // 1..7
  // Last Sunday is `dow` days back; the subject week is the 7 days ending
  // there. k=dow → Sun, k=dow+6 → Mon.
  const keyAt = (k: number) => dayKey(new Date(now.getTime() - k * DAY_MS), tz)
  const thisWeekOrdered: string[] = []
  for (let k = dow + 6; k >= dow; k--) thisWeekOrdered.push(keyAt(k)) // Mon..Sun
  const thisWeekSet = new Set(thisWeekOrdered)
  const lastWeekSet = new Set<string>()
  for (let k = dow + 7; k <= dow + 13; k++) lastWeekSet.add(keyAt(k))
  return {
    weekKey: thisWeekOrdered[0], // Monday
    thisWeekOrdered,
    thisWeekSet,
    lastWeekSet,
  }
}

function payloadObj(payload: unknown): Record<string, unknown> {
  return (payload && typeof payload === 'object' ? payload : {}) as Record<
    string,
    unknown
  >
}

// XP for a completion event, matching the derivation used everywhere else
// (leaderboard/households/stats): explicit xpOverride, else the difficulty
// default. Bare numbers only — punctuality multipliers aren't replayed here.
function xpOf(payload: Record<string, unknown>): number {
  const override = payload['xpOverride']
  if (typeof override === 'number') return override
  const difficulty = payload['difficulty']
  return difficulty === 'small' ? 10 : difficulty === 'large' ? 60 : 25
}

// ---------------------------------------------------------------------------
// Aggregation
// ---------------------------------------------------------------------------

async function loadCompletionsByWeek(
  userId: string,
  tz: string,
  windows: ReturnType<typeof computeWeekWindows>,
): Promise<{
  kpisPartial: Pick<
    WeeklyKpis,
    | 'completionsThisWeek'
    | 'completionsLastWeek'
    | 'xpThisWeek'
    | 'xpLastWeek'
    | 'byWeekday'
  >
  xpByDay: Array<{ date: string; xp: number; count: number }>
  topTasks: WeeklyTopTask[]
}> {
  // Cover both weeks plus slack; bucket by local day-key and keep only the
  // days that fall in our two sets.
  const since = new Date(Date.now() - 22 * DAY_MS)
  const rows = await db
    .select({ payload: events.payload, occurredAt: events.occurredAt })
    .from(events)
    .where(
      and(
        eq(events.userId, userId),
        eq(events.type, 'task.completed'),
        isNotNull(events.occurredAt),
        gte(events.occurredAt, since),
      ),
    )

  const perDayXp = new Map<string, number>()
  const perDayCount = new Map<string, number>()
  const titleCounts = new Map<string, number>() // taskId -> count (this week)
  let completionsThisWeek = 0
  let completionsLastWeek = 0
  let xpThisWeek = 0
  let xpLastWeek = 0

  for (const r of rows) {
    if (!r.occurredAt) continue
    const key = dayKey(r.occurredAt, tz)
    const inThis = windows.thisWeekSet.has(key)
    const inLast = windows.lastWeekSet.has(key)
    if (!inThis && !inLast) continue
    const p = payloadObj(r.payload)
    const xp = xpOf(p)
    if (inThis) {
      completionsThisWeek += 1
      xpThisWeek += xp
      perDayXp.set(key, (perDayXp.get(key) ?? 0) + xp)
      perDayCount.set(key, (perDayCount.get(key) ?? 0) + 1)
      const taskId = p['taskId']
      if (typeof taskId === 'string') {
        titleCounts.set(taskId, (titleCounts.get(taskId) ?? 0) + 1)
      }
    } else {
      completionsLastWeek += 1
      xpLastWeek += xp
    }
  }

  // Mon..Sun ordered series + weekday histogram.
  const xpByDay = windows.thisWeekOrdered.map((date) => ({
    date,
    xp: perDayXp.get(date) ?? 0,
    count: perDayCount.get(date) ?? 0,
  }))
  const byWeekday = windows.thisWeekOrdered.map((date) => perDayCount.get(date) ?? 0)

  // Resolve titles for this week's top tasks.
  const taskIds = [...titleCounts.keys()]
  const titleMap = new Map<string, string>()
  if (taskIds.length > 0) {
    const titled = await db
      .select({ id: tasks.id, title: tasks.title })
      .from(tasks)
      .where(inArray(tasks.id, taskIds))
    for (const t of titled) titleMap.set(t.id, t.title)
  }
  const topTasks: WeeklyTopTask[] = taskIds
    .map((id) => ({
      taskId: id,
      title: titleMap.get(id) ?? '(deleted task)',
      count: titleCounts.get(id) ?? 0,
    }))
    .sort((a, b) => b.count - a.count)
    .slice(0, 8)

  return {
    kpisPartial: {
      completionsThisWeek,
      completionsLastWeek,
      xpThisWeek,
      xpLastWeek,
      byWeekday,
    },
    xpByDay,
    topTasks,
  }
}

// All-time completion totals for the user's recurring tasks, with the
// subject-week slice. Joins completed instances to their (recurring)
// parent task.
async function loadRepeatingTaskTotals(
  userId: string,
  tz: string,
  thisWeekSet: Set<string>,
): Promise<RepeatingTaskTotal[]> {
  const rows = await db
    .select({
      taskId: tasks.id,
      title: tasks.title,
      completedAt: taskInstances.completedAt,
    })
    .from(taskInstances)
    .innerJoin(tasks, eq(taskInstances.taskId, tasks.id))
    .where(
      and(
        eq(tasks.userId, userId),
        isNotNull(tasks.recurrence),
        isNotNull(taskInstances.completedAt),
      ),
    )

  const byTask = new Map<
    string,
    { title: string; all: number; week: number }
  >()
  for (const r of rows) {
    if (!r.completedAt) continue
    const cur = byTask.get(r.taskId) ?? { title: r.title, all: 0, week: 0 }
    cur.all += 1
    if (thisWeekSet.has(dayKey(r.completedAt, tz))) cur.week += 1
    byTask.set(r.taskId, cur)
  }

  return [...byTask.entries()]
    .map(([taskId, v]) => ({
      taskId,
      title: v.title,
      allTimeCount: v.all,
      thisWeekCount: v.week,
    }))
    .sort((a, b) => b.allTimeCount - a.allTimeCount)
    .slice(0, 12)
}

export async function getWeeklySummary(userId: string): Promise<WeeklySummary> {
  const now = new Date()
  const tz = await getUserTimeZone(userId)
  const windows = computeWeekWindows(now, tz)

  // Social blocks each isolated: a privacy-empty or failing block yields a
  // safe default rather than breaking the whole summary.
  const safeLeaderboard = async (): Promise<LeaderboardRow[]> => {
    try {
      return await getLeaderboard(userId, {
        scope: 'friends',
        metric: 'xp',
        days: 7,
      })
    } catch {
      return []
    }
  }
  const safeHousehold = async (): Promise<WeeklySummary['household']> => {
    try {
      const hh = await getMyHousehold(userId)
      if (!hh) return null
      const stats = await listHouseholdStats(userId, hh.household.id, 7)
      return { name: hh.household.name, stats }
    } catch {
      return null
    }
  }
  const safeArcade = async (): Promise<ArcadeStats> => {
    try {
      return await getArcadeStats(userId)
    } catch {
      return { personal: [], friendBests: [], wordle: null, sudoku: null }
    }
  }

  const [completions, progression, repeatingTasks, arcade, leaderboard, household] =
    await Promise.all([
      loadCompletionsByWeek(userId, tz, windows),
      getProgression(userId),
      loadRepeatingTaskTotals(userId, tz, windows.thisWeekSet),
      safeArcade(),
      safeLeaderboard(),
      safeHousehold(),
    ])

  const prog: ProgressionSummary = progression
  const kpis: WeeklyKpis = {
    ...completions.kpisPartial,
    level: prog.level,
    totalXp: prog.xp,
    currentStreak: prog.currentStreak,
    longestStreak: prog.longestStreak,
    tokens: prog.tokens,
  }

  const start = windows.thisWeekOrdered[0]
  const end = windows.thisWeekOrdered[windows.thisWeekOrdered.length - 1]
  const labelOf = (key: string) =>
    formatInTimeZone(new Date(key + 'T12:00:00Z'), 'UTC', 'MMM d')

  return {
    weekKey: windows.weekKey,
    weekStartLabel: labelOf(start),
    weekEndLabel: labelOf(end),
    timeZone: tz,
    kpis,
    xpByDay: completions.xpByDay,
    topTasks: completions.topTasks,
    repeatingTasks,
    arcade,
    leaderboard,
    household,
  }
}

// ---------------------------------------------------------------------------
// LLM analysis (cached per week)
// ---------------------------------------------------------------------------

const WEEKLY_SYSTEM_PROMPT = `You are writing a short weekly review for a user of a gamified personal todo app. The user has just finished a week and wants an honest, warm, ADHD-aware recap they actually want to read.

STYLE:
- 3 to 6 sentences, two short paragraphs at most. Plain, friendly, second-person. No emojis, no hashtags, no all-caps, no markdown.
- Lead with how this week compared to last week — be honest. If completions or XP dropped, say so kindly without guilt-tripping. If they rose, genuinely celebrate it.
- Reference one or two specifics by real name (a top task, a repeating habit they kept up, a game they did well at, their streak, or their leaderboard standing) — concrete beats generic.
- Give exactly one small, concrete suggestion for next week. One. The smallest reasonable thing.
- End on an encouraging note that fits the data — earned, not empty cheerleading. A flat or down week still deserves warmth, not a pep-talk lecture.
- Never invent numbers. Only use what the data block gives you. If a week is empty, acknowledge the rest honestly.

OUTPUT RULES — STRICT:
- Return ONLY the finished sentences the user should see. No preamble, no headers, no quotes, no markdown, no bullet points.
- The first character must be a regular letter or digit.`

function buildAnalysisDigest(s: WeeklySummary, userId: string): string {
  const k = s.kpis
  const parts: string[] = []
  parts.push(`Week of ${s.weekStartLabel}–${s.weekEndLabel} (${s.timeZone}).`)
  const dCompletions = k.completionsThisWeek - k.completionsLastWeek
  const dXp = k.xpThisWeek - k.xpLastWeek
  const dir = (n: number) => (n > 0 ? `up ${n}` : n < 0 ? `down ${Math.abs(n)}` : 'flat')
  parts.push(
    `Completions — this week: ${k.completionsThisWeek}, last week: ${k.completionsLastWeek} (${dir(dCompletions)}).`,
  )
  parts.push(
    `XP earned — this week: ${k.xpThisWeek}, last week: ${k.xpLastWeek} (${dir(dXp)}).`,
  )
  parts.push(
    `Progression: level ${k.level}, ${k.totalXp} total XP, current streak ${k.currentStreak} days (longest ${k.longestStreak}), ${k.tokens} tokens.`,
  )

  if (s.topTasks.length > 0) {
    parts.push(
      `Top tasks this week: ${s.topTasks
        .slice(0, 5)
        .map((t) => `"${t.title}" (${t.count})`)
        .join(', ')}.`,
    )
  } else {
    parts.push('No task completions this week.')
  }

  const keptUp = s.repeatingTasks.filter((r) => r.thisWeekCount > 0).slice(0, 5)
  if (keptUp.length > 0) {
    parts.push(
      `Repeating habits kept up this week: ${keptUp
        .map((r) => `"${r.title}" (${r.thisWeekCount}× this week, ${r.allTimeCount} all-time)`)
        .join(', ')}.`,
    )
  }

  const playedGames = s.arcade.personal.filter((g) => g.played > 0)
  if (playedGames.length > 0) {
    parts.push(
      `Arcade: ${playedGames
        .map((g) => `${g.gameId} (${g.won}/${g.played} won)`)
        .join(', ')}.`,
    )
  }

  const me = s.leaderboard.find((r) => r.isMe)
  if (me && s.leaderboard.length > 1) {
    parts.push(
      `Friends XP leaderboard (last 7 days): rank ${me.rank} of ${s.leaderboard.length} with ${me.value} XP.`,
    )
  }

  if (s.household) {
    const mine = s.household.stats.members.find((m) => m.userId === userId)
    parts.push(
      `Household "${s.household.name}": ${s.household.stats.totalCompletions} chores done across the family this week${mine ? `, ${mine.totalCount} of them yours` : ''}.`,
    )
  }

  parts.push('Write the weekly review now.')
  return parts.join('\n')
}

async function currentAttitude(userId: string): Promise<string> {
  const row = await db.query.userPrefs.findFirst({
    where: eq(userPrefs.userId, userId),
    columns: { coachAttitude: true },
  })
  return row?.coachAttitude ?? 'warm'
}

// Read-through cache: returns the stored analysis for the week unless
// `force` is set or the stored attitude is stale. Returns null when the
// LLM isn't configured or produced nothing usable (caller hides the card).
export async function generateWeeklyAnalysis(
  userId: string,
  summary: WeeklySummary,
  opts: { force?: boolean } = {},
): Promise<{ analysis: string; generatedAt: string } | null> {
  const attitude = await currentAttitude(userId)
  const digest = buildAnalysisDigest(summary, userId)

  if (!opts.force) {
    const cached = await db.query.weeklySummaries.findFirst({
      where: and(
        eq(weeklySummaries.userId, userId),
        eq(weeklySummaries.weekKey, summary.weekKey),
      ),
    })
    if (cached && cached.attitude === attitude) {
      return {
        analysis: cached.analysis,
        generatedAt: cached.generatedAt.toISOString(),
      }
    }
  }

  const raw = await callLlmChat({
    messages: [
      { role: 'system', content: WEEKLY_SYSTEM_PROMPT },
      { role: 'user', content: digest },
    ],
    temperature: 0.7,
    maxTokens: 600,
    timeoutMs: 20_000,
    track: { kind: 'weekly', userId },
  })
  const cleaned = sanitizeCoachOutput(raw)
  if (!cleaned) return null

  const generatedAt = new Date()
  await db
    .insert(weeklySummaries)
    .values({
      userId,
      weekKey: summary.weekKey,
      analysis: cleaned,
      attitude,
      generatedAt,
    })
    .onConflictDoUpdate({
      target: [weeklySummaries.userId, weeklySummaries.weekKey],
      set: { analysis: cleaned, attitude, generatedAt },
    })
  return { analysis: cleaned, generatedAt: generatedAt.toISOString() }
}
