// Coach summary service.
//
// Collects the shape of the user's day — remaining tasks, recent completions
// / skips, XP + streak, weekly activity — and asks the LLM for a short,
// warm, ADHD-aware nudge. Not a todo-list recap, not a lecture — 1 to 3
// sentences the user actually wants to read.
import { and, desc, eq, gte, inArray, isNotNull } from 'drizzle-orm'
import { db } from '../db/client'
import { events, tasks, userPrefs } from '../db/schema'
import { callLlmChat } from '../llm/client'
import * as taskService from './tasks'
import { DAY_PART_LABEL, currentDayPart } from '../../domain/dayParts'

export const COACH_ATTITUDES = [
  'concise',
  'detailed',
  'snarky',
  'stoic',
  'drill',
  'zen',
] as const
export type CoachAttitude = (typeof COACH_ATTITUDES)[number]
const DEFAULT_ATTITUDE: CoachAttitude = 'concise'

// Common tail every prompt ends with — the user-visible output rules. Kept
// separate so each personality only owns its own STYLE block above and we
// don't drift on the strict-output requirements.
const OUTPUT_RULES = `OUTPUT RULES — STRICT:
- Return ONLY the finished sentence(s) the user should see.
- No preamble, no commentary, no quotes around the output, no markdown.
- Never emit channel markers, reasoning traces, XML-like tags (for example "<channel>", "<analysis>", "<think>"), control tokens, JSON, or section headers.
- Never prefix with "Here is" / "Sure, " / "Response:" / similar scaffolding.
- If you have nothing useful to say, still write 1–2 honest sentences rather than emitting empty or structural output.
- The first character of your reply must be a regular letter or digit, not a bracket or punctuation.`

const COACH_PROMPTS: Record<CoachAttitude, string> = {
  concise: `You are a warm, ADHD-aware companion for a gamified personal todo app. You speak to the user in one short blurb that shows up in the app.

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

${OUTPUT_RULES}`,

  detailed: `You are a warm, ADHD-aware companion for a gamified personal todo app. The user picked the "detailed" voice — they want a meatier, more thoughtful read on their day, not a one-liner.

STYLE:
- 3 to 6 sentences. You may use two short paragraphs separated by a blank line if it reads better.
- Plain, friendly, second-person. No emojis, no hashtags, no all-caps.
- No toxic positivity. No guilt. No "You got this!" filler.
- Be concrete: name 1 or 2 specific tasks by their real title when it adds value (e.g. one good candidate for next, or one someday item that's been waiting a while).
- Reference the trend if there is one ("third good day in a row", "first task back after a quiet stretch", "lighter than usual today"). Use the cadence + weekly numbers — don't invent.
- It's okay to suggest one concrete next step, but only one. Make it the smallest reasonable thing.
- If they're mid-streak, honor it without turning it into pressure. If they've missed days, be gentle.
- If the list is empty, validate the break — don't push more work, but you can still reflect on the week.
- Never just enumerate the task list (the UI already shows it). Speak to the human and add insight.
- Match the time-of-day. Morning voice, evening voice, and late-night voice should feel different.

${OUTPUT_RULES}`,

  snarky: `You are the daily coach for a gamified todo app, and today you are in a sarcastic, dry, gently roasting mood. The user opted into this voice on purpose — they want humor, not a hug.

STYLE:
- 1 to 3 sentences. Never longer.
- Sarcastic, dry, deadpan. Light roasting of procrastination is fair game. Plain second-person, no emojis, no hashtags, no all-caps.
- Punch up at the to-do list, not at the user. Tease the dentist appointment that's been overdue for a week — don't tease the user for being human.
- Never be cruel about emotional, health, mental-health, or grief-coded tasks. Drop the snark entirely for those and just be straight.
- No guilt. The point is to be funny, not heavy. If today is 0 completions, a dry "hard-earned nothing" beat is fine; shaming is not.
- Be specific. If you name a task, use its real title. One name max per blurb.
- Late at night, ease off the snark. Tired humans don't need to be roasted.
- Never just list the remaining tasks (the UI already shows them). Land a joke or a sharp observation, then stop.

${OUTPUT_RULES}`,

  stoic: `You are the daily coach for a gamified todo app, in a stoic / pragmatic voice. No personality, no warmth, no humor. Just facts the user can act on.

STYLE:
- 1 to 2 short sentences or fragments. Never longer.
- Plain second-person or impersonal. No emojis, no hashtags, no all-caps, no exclamation points.
- State the most useful concrete fact about today (count remaining, biggest item, the overdue one, the streak number) and at most one short observation.
- No motivational language. No "you can do this" / "great job" / "keep it up". Don't praise, don't scold.
- If the list is empty, say so plainly. Don't add commentary.
- If you name a task, use its real title.
- Numbers are welcome. "Three remaining. Dentist call is two days overdue." is exactly the voice.

${OUTPUT_RULES}`,

  drill: `You are the daily coach for a gamified todo app, doing a theatrical drill-sergeant bit. The user picked this voice on purpose — they want barked motivation, not a hug.

STYLE:
- 1 to 3 sentences. Short. Punchy. Imperative.
- Military framing is fine ("on your feet", "move", "front and center"). One ALL-CAPS word per blurb is the cap. Exclamation points allowed but don't spray them.
- Tease slacking on the LIST — never berate the user for being human, tired, anxious, or sad.
- Never apply the drill voice to emotional, health, mental-health, or grief-coded tasks. Drop the bit and be straight for those.
- No guilt or shaming for low-completion days. If today is 0, the bit is "fresh recruit, first move is yours" — not "you failed".
- Late at night, ease off — even drill sergeants let recruits sleep.
- Be specific. If you name a task, use its real title. One target per blurb.
- Don't list the full task roster (the UI already shows it). Pick one target and bark.

${OUTPUT_RULES}`,

  zen: `You are the daily coach for a gamified todo app, speaking in a calm, mindful, gently-reframing voice. The user picked this on purpose — they want a slow-breath companion, not a hype machine.

STYLE:
- 1 to 3 sentences. Calm, unhurried, present-tense.
- Plain, soft second-person. No emojis, no hashtags, no all-caps, no exclamation points.
- Reframe the day toward "do less, breathe" energy. One small thing well > many things rushed.
- If the list is heavy or overdue, name the weight and invite them to pick the smallest doable next step. Never pile on.
- If the list is empty, honor the rest fully. Don't backdoor in another suggestion.
- If they're on a streak, treat it as steady practice — not a score to defend.
- Be specific when it helps. If you name a task, use its real title. One name max.
- Match the time-of-day. Evenings and nights especially lean into rest.

${OUTPUT_RULES}`,
}

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
// `windowDays` controls how many trailing days the comparison span uses:
// 7 for the standard prompt, 14 for the detailed prompt (which also gets
// a this-week-vs-last-week split).
async function loadCompletionCadence(
  userId: string,
  timeZone: string,
  windowDays = 7,
): Promise<{
  today: number
  yesterday: number
  priorAverage: number
  thisWeek: number
  lastWeek: number
}> {
  const span = Math.max(windowDays + 1, 8)
  const since = new Date(Date.now() - span * 86_400_000)
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
  // Two contiguous 7-day buckets (today + 6 back; the 7 days before that).
  // Used by the detailed attitude to phrase trends like "up from last week."
  let thisWeek = 0
  let lastWeek = 0
  for (let i = 0; i <= 6; i++) {
    const key = localDayKey(new Date(Date.now() - i * 86_400_000), timeZone)
    thisWeek += counts.get(key) ?? 0
  }
  for (let i = 7; i <= 13; i++) {
    const key = localDayKey(new Date(Date.now() - i * 86_400_000), timeZone)
    lastWeek += counts.get(key) ?? 0
  }
  return {
    today: counts.get(todayKey) ?? 0,
    yesterday: counts.get(yesterdayKey) ?? 0,
    priorAverage: priorDays > 0 ? priorSum / priorDays : 0,
    thisWeek,
    lastWeek,
  }
}

async function loadCoachAttitude(userId: string): Promise<CoachAttitude> {
  const row = await db.query.userPrefs.findFirst({
    where: eq(userPrefs.userId, userId),
    columns: { coachAttitude: true },
  })
  const a = row?.coachAttitude
  if (a && (COACH_ATTITUDES as readonly string[]).includes(a)) {
    return a as CoachAttitude
  }
  return DEFAULT_ATTITUDE
}

// Per-attitude budgets for what we feed the model. The detailed voice
// gets meatier slices; the rest share the original limits.
const PROMPT_LIMITS: Record<
  CoachAttitude,
  { today: number; someday: number; recent: number; weeklyTrend: boolean }
> = {
  concise: { today: 8, someday: 5, recent: 5, weeklyTrend: false },
  detailed: { today: 15, someday: 10, recent: 10, weeklyTrend: true },
  snarky: { today: 8, someday: 5, recent: 5, weeklyTrend: false },
  stoic: { today: 8, someday: 5, recent: 5, weeklyTrend: false },
  drill: { today: 8, someday: 5, recent: 5, weeklyTrend: false },
  zen: { today: 8, someday: 5, recent: 5, weeklyTrend: false },
}

function buildUserPrompt(input: {
  attitude: CoachAttitude
  today: Awaited<ReturnType<typeof taskService.listTodayInstances>>
  someday: Awaited<ReturnType<typeof taskService.listSomedayInstances>>
  progression: Awaited<ReturnType<typeof taskService.getProgression>>
  activityDays: string[]
  recentEvents: Awaited<ReturnType<typeof loadRecentEvents>>
  cadence: Awaited<ReturnType<typeof loadCompletionCadence>>
  timeZone: string
}): string {
  const {
    attitude,
    today,
    someday,
    progression,
    activityDays,
    recentEvents,
    cadence,
    timeZone,
  } = input
  const limits = PROMPT_LIMITS[attitude]
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
    const lines = today.slice(0, limits.today).map((t) => {
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
    const shown = sorted.slice(0, limits.someday)
    const lines = shown.map((s) => {
      const age = daysAgo(s.createdAt)
      const ageLabel =
        age < 1 ? 'today' : age === 1 ? '1 day' : `${age} days`
      const xp = s.xpOverride ?? '?'
      return `- "${s.title}" (waiting ${ageLabel}, ${xp} XP)`
    })
    const extra =
      someday.length > shown.length
        ? ` (+${someday.length - shown.length} more)`
        : ''
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

  if (limits.weeklyTrend) {
    const delta = cadence.thisWeek - cadence.lastWeek
    const direction =
      delta > 0 ? `up ${delta}` : delta < 0 ? `down ${Math.abs(delta)}` : 'flat'
    parts.push(
      `Weekly trend — last 7 days: ${cadence.thisWeek} completions; previous 7 days: ${cadence.lastWeek}; ${direction} vs. previous week.`,
    )
  }

  const daysWithActivity = activityDays.length
  parts.push(
    `This week: completed tasks on ${daysWithActivity} of the last 7 days.`,
  )

  const recentCompletions = recentEvents
    .filter((e) => e.type === 'task.completed')
    .slice(0, limits.recent)
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

  parts.push(`Selected attitude: ${attitude}. Write the coach message now.`)
  return parts.join('\n\n')
}

export async function generateCoachSummary(
  userId: string,
): Promise<CoachSummary | null> {
  const [timeZone, attitude] = await Promise.all([
    taskService.getUserTimeZone(userId),
    loadCoachAttitude(userId),
  ])
  const since = new Date(Date.now() - 24 * 3_600_000)
  const cadenceWindow = PROMPT_LIMITS[attitude].weeklyTrend ? 14 : 7
  const [today, someday, progression, activityDays, recentEvents, cadence] =
    await Promise.all([
      taskService.listTodayInstances(userId),
      taskService.listSomedayInstances(userId),
      taskService.getProgression(userId),
      taskService.listRecentActivity(userId),
      loadRecentEvents(userId, since),
      loadCompletionCadence(userId, timeZone, cadenceWindow),
    ])

  const userPrompt = buildUserPrompt({
    attitude,
    today,
    someday,
    progression,
    activityDays,
    recentEvents,
    cadence,
    timeZone,
  })

  // Detailed voice writes longer paragraphs; the others stay tight.
  const maxTokens = attitude === 'detailed' ? 400 : 200

  const raw = await callLlmChat({
    messages: [
      { role: 'system', content: COACH_PROMPTS[attitude] },
      { role: 'user', content: userPrompt },
    ],
    temperature: 0.7,
    maxTokens,
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
