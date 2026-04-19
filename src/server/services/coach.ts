// Coach summary service.
//
// Collects the shape of the user's day — remaining tasks, recent completions
// / skips, XP + streak, weekly activity — and asks the LLM for a short,
// warm, ADHD-aware nudge. Not a todo-list recap, not a lecture — 1 to 3
// sentences the user actually wants to read.
import { and, desc, eq, gte, inArray } from 'drizzle-orm'
import { db } from '../db/client'
import { events, tasks } from '../db/schema'
import { callLlmChat } from '../llm/client'
import * as taskService from './tasks'

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

OUTPUT:
Return ONLY the text the user should see. No preamble, no quotes, no markdown formatting beyond plain sentences.`

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

function buildUserPrompt(input: {
  today: Awaited<ReturnType<typeof taskService.listTodayInstances>>
  progression: Awaited<ReturnType<typeof taskService.getProgression>>
  activityDays: string[]
  recentEvents: Awaited<ReturnType<typeof loadRecentEvents>>
  timeZone: string
}): string {
  const { today, progression, activityDays, recentEvents, timeZone } = input
  const parts: string[] = []

  const now = new Date()
  const localClock = formatClock(now, timeZone)
  parts.push(`Local time: ${localClock} (${timeZone}).`)

  if (today.length === 0) {
    parts.push('Remaining tasks today: none.')
  } else {
    const lines = today.slice(0, 8).map((t) => {
      const when = t.timeOfDay ? `due ${t.timeOfDay}` : 'anytime'
      const xp = t.xpOverride ?? '?'
      return `- "${t.title}" (${when}, ${xp} XP)`
    })
    parts.push(`Remaining tasks today (${today.length}):`)
    parts.push(lines.join('\n'))
  }

  parts.push(
    `Progression: ${progression.xp} XP, level ${progression.level}, current streak ${progression.currentStreak} days, longest ${progression.longestStreak}.`,
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
  const [today, progression, activityDays, recentEvents] = await Promise.all([
    taskService.listTodayInstances(userId),
    taskService.getProgression(userId),
    taskService.listRecentActivity(userId),
    loadRecentEvents(userId, since),
  ])

  const userPrompt = buildUserPrompt({
    today,
    progression,
    activityDays,
    recentEvents,
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
  })

  const trimmed = raw?.trim().replace(/^"|"$/g, '').trim()
  if (!trimmed) return null
  return { summary: trimmed, generatedAt: new Date().toISOString() }
}
