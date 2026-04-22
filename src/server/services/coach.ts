// Coach summary service.
//
// Collects the shape of the user's day — remaining tasks, recent completions
// / skips, XP + streak, weekly activity — and asks the LLM for a short,
// warm, ADHD-aware nudge. Not a todo-list recap, not a lecture — 1 to 3
// sentences the user actually wants to read.
import { and, desc, eq, gte, inArray, isNotNull } from 'drizzle-orm'
import { db } from '../db/client'
import { events, tasks } from '../db/schema'
import { callLlmChat } from '../llm/client'
import * as taskService from './tasks'
import { DAY_PART_LABEL, currentDayPart } from '../../domain/dayParts'

const SYSTEM_PROMPT = `You are a warm, ADHD-aware companion for a gamified personal todo app. You speak to the user in one short blurb that shows up in the app.

STYLE:
- 1 to 3 sentences. Never longer.
- Plain, friendly, second-person. No emojis, no hashtags, no all-caps.
- No toxic positivity. No guilt. No "You got this!" filler.
- Be specific. If you name a task, use its real title. If you give a tip, give exactly one.
- If the user just completed something, briefly acknowledge it by name.
- If the list is empty, validate the break — don't push more work.
- If they're mid-streak, quietly honor it without turning it into pressure.
- If they've missed days recently, be gentle and low-friction — suggest the smallest task to restart momentum.
- Never list out the remaining tasks (the UI already shows that). Speak to the human, not to a dashboard.
- You may reference the someday backlog by name when an item has been waiting a long time and it feels worth a gentle nudge — but never guilt-trip about age, and only mention one. Short items ("waiting 2 days") are usually not worth mentioning.
- You may contextualize today's pace ("already past yesterday", "same as usual", "quiet day") when it adds warmth, but never turn cadence into a metric to beat. If today is 0 and yesterday was 5, don't shame.
- Match the time-of-day. Morning voice, evening voice, and late-night voice should feel different. Don't push a big task at night.

OUTPUT RULES — STRICT:
- Return ONLY the finished sentence(s) the user should see.
- No preamble, no commentary, no quotes around the output, no markdown.
- Never emit channel markers, reasoning traces, XML-like tags (for example "<channel>", "<analysis>", "<think>"), control tokens, JSON, or section headers.
- Never prefix with "Here is" / "Sure, " / "Response:" / similar scaffolding.
- If you have nothing useful to say, still write 1–2 honest sentences rather than emitting empty or structural output.
- The first character of your reply must be a regular letter or digit, not a bracket or punctuation.`

export interface CoachSummary {
  summary: string
  generatedAt: string
}

function payloadAsObj(payload: unknown): Record<string, unknown> {
  return (payload && typeof payload === 'object' ? payload : {}) as Record<
    string,
    unknown
  >
}

async function loadRecentEvents(userId: string, since: Date) {
  const rows = await db
    .select({
      type: events.type,
      payload: events.payload,
      occurredAt: events.occurredAt,
    })
    .from(events)
    .where(and(eq(events.userId, userId), gte(events.occurredAt, since)))
    .orderBy(desc(events.occurredAt))
    .limit(20)

  const taskIds = Array.from(
    new Set(
      rows
        .map((r) => payloadAsObj(r.payload)['taskId'])
        .filter((v): v is string => typeof v === 'string'),
    ),
  )
  const titleMap = new Map<string, string>()
  if (taskIds.length > 0) {
    const titled = await db
      .select({ id: tasks.id, title: tasks.title })
      .from(tasks)
      .where(inArray(tasks.id, taskIds))
    for (const t of titled) titleMap.set(t.id, t.title)
  }

  return rows.map((r) => {
    const p = payloadAsObj(r.payload)
    const taskId = typeof p['taskId'] === 'string' ? (p['taskId'] as string) : null
    return {
      type: r.type,
      occurredAt: r.occurredAt,
      taskId,
      title: taskId ? titleMap.get(taskId) ?? null : null,
    }
  })
}

function formatClock(date: Date, timeZone: string): string {
  return new Intl.DateTimeFormat('en-US', {
    timeZone,
    hour: 'numeric',
    minute: '2-digit',
  }).format(date)
}

function minutesAgo(date: Date): number {
  return Math.max(0, Math.round((Date.now() - date.getTime()) / 60_000))
}

function daysAgo(iso: string): number {
  return Math.max(0, Math.floor((Date.now() - new Date(iso).getTime()) / 86_400_000))
}

function localDayKey(date: Date, timeZone: string): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(date)
}

// Returns completion counts per local day for the last `days` days, plus
// the usual reference days (today / yesterday / prior-7-average excluding
// today). Used so the coach can say "ahead of yesterday" style things.
async function loadCompletionCadence(
  userId: string,
  timeZone: string,
  days = 8,
): Promise<{
  today: number
  yesterday: number
  priorAverage: number
}> {
  const since = new Date(Date.now() - days * 86_400_000)
  const rows = await db
    .select({ occurredAt: events.occurredAt })
    .from(events)
    .where(
      and(
        eq(events.userId, userId),
        eq(events.type, 'task.completed'),
        isNotNull(events.occurredAt),
        gte(events.occurredAt, since),
      ),
    )
  const todayKey = localDayKey(new Date(), timeZone)
  const yesterdayKey = localDayKey(
    new Date(Date.now() - 86_400_000),
    timeZone,
  )
  const counts = new Map<string, number>()
  for (const r of rows) {
    if (!r.occurredAt) continue
    const key = localDayKey(r.occurredAt, timeZone)
    counts.set(key, (counts.get(key) ?? 0) + 1)
  }
  let priorSum = 0
  let priorDays = 0
  for (let i = 1; i <= 7; i++) {
    const key = localDayKey(new Date(Date.now() - i * 86_400_000), timeZone)
    priorSum += counts.get(key) ?? 0
    priorDays += 1
  }
  return {
    today: counts.get(todayKey) ?? 0,
    yesterday: counts.get(yesterdayKey) ?? 0,
    priorAverage: priorDays > 0 ? priorSum / priorDays : 0,
  }
}

function buildUserPrompt(input: {
  today: Awaited<ReturnType<typeof taskService.listTodayInstances>>
  someday: Awaited<ReturnType<typeof taskService.listSomedayInstances>>
  progression: Awaited<ReturnType<typeof taskService.getProgression>>
  activityDays: string[]
  recentEvents: Awaited<ReturnType<typeof loadRecentEvents>>
  cadence: Awaited<ReturnType<typeof loadCompletionCadence>>
  timeZone: string
}): string {
  const {
    today,
    someday,
    progression,
    activityDays,
    recentEvents,
    cadence,
    timeZone,
  } = input
  const parts: string[] = []

  const now = new Date()
  const localClock = formatClock(now, timeZone)
  const part = currentDayPart(now, timeZone)
  parts.push(
    `Local time: ${localClock} (${timeZone}). Day-part: ${DAY_PART_LABEL[part]}.`,
  )

  if (today.length === 0) {
    parts.push('Remaining tasks today: none.')
  } else {
    const lines = today.slice(0, 8).map((t) => {
      const when = t.timeOfDay ? `due ${t.timeOfDay}` : 'anytime'
      const overdue =
        t.dueAt && new Date(t.dueAt).getTime() < now.getTime()
          ? ', overdue'
          : ''
      const xp = t.xpOverride ?? '?'
      return `- "${t.title}" (${when}${overdue}, ${xp} XP)`
    })
    parts.push(`Remaining tasks today (${today.length}):`)
    parts.push(lines.join('\n'))
  }

  if (someday.length > 0) {
    // Sort oldest first so the coach can zero in on the ones that have been
    // sitting longest. Cap the list so the prompt stays bounded.
    const sorted = [...someday].sort((a, b) =>
      a.createdAt < b.createdAt ? -1 : 1,
    )
    const lines = sorted.slice(0, 5).map((s) => {
      const age = daysAgo(s.createdAt)
      const ageLabel =
        age < 1 ? 'today' : age === 1 ? '1 day' : `${age} days`
      const xp = s.xpOverride ?? '?'
      return `- "${s.title}" (waiting ${ageLabel}, ${xp} XP)`
    })
    const extra = someday.length > sorted.length ? ` (+${someday.length - sorted.length} more)` : ''
    parts.push(
      `Someday backlog (${someday.length} total${extra}); oldest first:`,
    )
    parts.push(lines.join('\n'))
  }

  parts.push(
    `Progression: ${progression.xp} XP, level ${progression.level}, current streak ${progression.currentStreak} days, longest ${progression.longestStreak}.`,
  )

  // Cadence line — concrete numbers the coach can use to contextualize
  // today without pushing. Average is rounded so phrasing stays natural.
  const avg = cadence.priorAverage
  const avgLabel = avg >= 10 ? `${Math.round(avg)}` : avg.toFixed(1)
  parts.push(
    `Completions cadence — today: ${cadence.today}, yesterday: ${cadence.yesterday}, prior 7-day average: ${avgLabel}/day.`,
  )

  const daysWithActivity = activityDays.length
  parts.push(
    `This week: completed tasks on ${daysWithActivity} of the last 7 days.`,
  )

  const recentCompletions = recentEvents
    .filter((e) => e.type === 'task.completed')
    .slice(0, 5)
  if (recentCompletions.length > 0) {
    const lines = recentCompletions.map((e) => {
      const title = e.title ?? '(unknown task)'
      return `- "${title}" (${minutesAgo(e.occurredAt)} min ago)`
    })
    parts.push('Recent completions:')
    parts.push(lines.join('\n'))
  }

  const veryRecent = recentEvents.find(
    (e) =>
      e.type === 'task.completed' &&
      Date.now() - e.occurredAt.getTime() < 10 * 60_000,
  )
  if (veryRecent && veryRecent.title) {
    parts.push(
      `Just happened (last 10 min): user completed "${veryRecent.title}".`,
    )
  }

  parts.push('Write the coach message now.')
  return parts.join('\n\n')
}

export async function generateCoachSummary(
  userId: string,
): Promise<CoachSummary | null> {
  const timeZone = await taskService.getUserTimeZone(userId)
  const since = new Date(Date.now() - 24 * 3_600_000)
  const [today, someday, progression, activityDays, recentEvents, cadence] =
    await Promise.all([
      taskService.listTodayInstances(userId),
      taskService.listSomedayInstances(userId),
      taskService.getProgression(userId),
      taskService.listRecentActivity(userId),
      loadRecentEvents(userId, since),
      loadCompletionCadence(userId, timeZone),
    ])

  const userPrompt = buildUserPrompt({
    today,
    someday,
    progression,
    activityDays,
    recentEvents,
    cadence,
    timeZone,
  })

  const raw = await callLlmChat({
    messages: [
      { role: 'system', content: SYSTEM_PROMPT },
      { role: 'user', content: userPrompt },
    ],
    temperature: 0.7,
    maxTokens: 200,
    timeoutMs: 15_000,
    track: { kind: 'coach', userId },
  })

  const cleaned = sanitizeCoachOutput(raw)
  if (!cleaned) return null
  return { summary: cleaned, generatedAt: new Date().toISOString() }
}

/**
 * Strip common reasoning-model artifacts that leak past the system prompt.
 * Return null if there's nothing usable left — the UI will hide the panel.
 */
function sanitizeCoachOutput(raw: string | null): string | null {
  if (!raw) return null
  let s = raw

  // Drop everything before and including a closing reasoning/channel tag
  // (e.g. a stray "...</analysis>Actual message" pattern).
  const closeTag = /<\/[a-z_-]{2,20}>/gi
  let match: RegExpExecArray | null
  let lastClose = -1
  while ((match = closeTag.exec(s)) !== null) {
    lastClose = match.index + match[0].length
  }
  if (lastClose >= 0) s = s.slice(lastClose)

  // Strip any remaining tag-like markers on their own lines or inline.
  s = s.replace(/<[a-z_\s-]{2,40}\/?>/gi, '')

  // Strip common reasoning-model control tokens.
  s = s.replace(
    /<\|[^>|]{1,40}\|>/g,
    '',
  )

  // Strip wrapping quotes/backticks, common conversational preambles.
  s = s.trim()
  s = s.replace(/^["'`]+|["'`]+$/g, '').trim()
  s = s.replace(/^(?:response:|here(?:'s| is)?:?|sure[,.!:]?)\s+/i, '')
  s = s.trim()

  // Require a real sentence-ish result: starts with a letter or digit and is
  // at least a handful of characters long.
  if (s.length < 12) return null
  if (!/^[\p{L}\p{N}]/u.test(s)) return null

  return s
}
