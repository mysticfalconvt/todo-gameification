// Admin dashboard queries. Single source of truth for the isAdmin check,
// which is driven by the ADMIN_EMAILS env var — a comma-separated list of
// emails allowed into /admin. Keep queries cheap-ish; this is for the
// operator, not for users, so correctness > polish.
import { and, count, desc, eq, gte, isNotNull, lt, sql } from 'drizzle-orm'
import { db } from '../db/client'
import {
  events,
  llmCallLog,
  progression,
  pushSubscriptions,
  taskInstances,
  tasks,
  user as userTable,
} from '../db/schema'
import type { DomainEvent } from '../../domain/events'
import { INITIAL_PROGRESSION, applyEvent } from '../../domain/gamification'

function allowlist(): Set<string> {
  const raw = process.env.ADMIN_EMAILS
  if (!raw) return new Set()
  return new Set(
    raw
      .split(',')
      .map((s) => s.trim().toLowerCase())
      .filter(Boolean),
  )
}

export function isAdminEmail(email: string | null | undefined): boolean {
  if (!email) return false
  return allowlist().has(email.trim().toLowerCase())
}

export async function isAdmin(userId: string): Promise<boolean> {
  const row = await db.query.user.findFirst({
    where: eq(userTable.id, userId),
    columns: { email: true },
  })
  return isAdminEmail(row?.email)
}

export interface FocusGameStats {
  focus: {
    started: number
    completed: number
    minutesCompleted: number
  }
  games: Array<{ gameId: string; played: number; won: number }>
}

export interface AdminSummary {
  totalUsers: number
  signupsToday: number
  signupsLast7: number
  signupsLast30: number
  activeLast7: number
  activeLast30: number
  inactiveCount: number
  totalTasks: number
  totalCompletions: number
  pushSubscriptions: number
  motivation: FocusGameStats
  system: {
    llm: boolean
    smtp: boolean
    vapid: boolean
    adminCount: number
  }
}

// Aggregates focus/game activity from the event log. Pass userId to scope to
// one user; omit for platform-wide totals. Minutes sums durationMin from each
// completed focus.completed event payload.
export async function loadFocusGameStats(
  userId?: string,
): Promise<FocusGameStats> {
  const scope = userId ? eq(events.userId, userId) : undefined

  const whereFor = (type: string) =>
    scope ? and(eq(events.type, type), scope) : eq(events.type, type)

  const [startedRows, completedRows, gameRows] = await Promise.all([
    db.select({ n: count() }).from(events).where(whereFor('focus.started')),
    db
      .select({
        n: count(),
        minutes: sql<number>`coalesce(sum((payload->>'durationMin')::int), 0)::int`,
      })
      .from(events)
      .where(whereFor('focus.completed')),
    db
      .select({
        gameId: sql<string>`payload->>'gameId'`,
        played: count(),
        won: sql<number>`sum(case when (payload->'result'->>'won') = 'true' then 1 else 0 end)::int`,
      })
      .from(events)
      .where(whereFor('game.played'))
      .groupBy(sql`payload->>'gameId'`),
  ])

  return {
    focus: {
      started: Number(startedRows[0]?.n ?? 0),
      completed: Number(completedRows[0]?.n ?? 0),
      minutesCompleted: Number(completedRows[0]?.minutes ?? 0),
    },
    games: gameRows
      .filter((r) => r.gameId)
      .map((r) => ({
        gameId: r.gameId,
        played: Number(r.played),
        won: Number(r.won ?? 0),
      })),
  }
}

export async function loadAdminSummary(): Promise<AdminSummary> {
  const now = new Date()
  const todayStart = new Date(now)
  todayStart.setHours(0, 0, 0, 0)
  const since7 = new Date(now.getTime() - 7 * 86_400_000)
  const since30 = new Date(now.getTime() - 30 * 86_400_000)

  // Running these as individual counts keeps each SQL simple and cheap.
  const [
    totalUsers,
    signupsToday,
    signupsLast7,
    signupsLast30,
    activeLast7,
    activeLast30,
    totalTasks,
    totalCompletions,
    pushCount,
  ] = await Promise.all([
    db.select({ n: count() }).from(userTable),
    db.select({ n: count() }).from(userTable).where(gte(userTable.createdAt, todayStart)),
    db.select({ n: count() }).from(userTable).where(gte(userTable.createdAt, since7)),
    db.select({ n: count() }).from(userTable).where(gte(userTable.createdAt, since30)),
    db
      .select({ n: sql<number>`count(distinct ${events.userId})::int` })
      .from(events)
      .where(
        and(
          eq(events.type, 'task.completed'),
          isNotNull(events.occurredAt),
          gte(events.occurredAt, since7),
        ),
      ),
    db
      .select({ n: sql<number>`count(distinct ${events.userId})::int` })
      .from(events)
      .where(
        and(
          eq(events.type, 'task.completed'),
          isNotNull(events.occurredAt),
          gte(events.occurredAt, since30),
        ),
      ),
    db.select({ n: count() }).from(tasks).where(eq(tasks.active, true)),
    db
      .select({ n: count() })
      .from(events)
      .where(eq(events.type, 'task.completed')),
    db.select({ n: count() }).from(pushSubscriptions),
  ])

  const totalUsersN = Number(totalUsers[0]?.n ?? 0)
  const activeLast30N = Number(activeLast30[0]?.n ?? 0)

  return {
    totalUsers: totalUsersN,
    signupsToday: Number(signupsToday[0]?.n ?? 0),
    signupsLast7: Number(signupsLast7[0]?.n ?? 0),
    signupsLast30: Number(signupsLast30[0]?.n ?? 0),
    activeLast7: Number(activeLast7[0]?.n ?? 0),
    activeLast30: activeLast30N,
    inactiveCount: Math.max(0, totalUsersN - activeLast30N),
    totalTasks: Number(totalTasks[0]?.n ?? 0),
    totalCompletions: Number(totalCompletions[0]?.n ?? 0),
    pushSubscriptions: Number(pushCount[0]?.n ?? 0),
    motivation: await loadFocusGameStats(),
    system: {
      llm: Boolean(process.env.LLM_BASE_URL && process.env.LLM_MODEL),
      smtp: Boolean(
        process.env.SMTP_HOST &&
          process.env.SMTP_PORT &&
          process.env.SMTP_USER &&
          process.env.SMTP_PASS,
      ),
      vapid: Boolean(
        process.env.VAPID_SUBJECT &&
          process.env.VAPID_PUBLIC_KEY &&
          process.env.VAPID_PRIVATE_KEY,
      ),
      adminCount: allowlist().size,
    },
  }
}

export interface AdminUserRow {
  id: string
  name: string
  email: string
  handle: string
  emailVerified: boolean
  timezone: string
  profileVisibility: 'public' | 'friends' | 'private'
  createdAt: string
  xp: number
  level: number
  currentStreak: number
  longestStreak: number
  lastCompletionAt: string | null
  activeTaskCount: number
  totalCompletions: number
  isAdmin: boolean
}

export async function listAllUsers(): Promise<AdminUserRow[]> {
  const rows = await db
    .select({
      id: userTable.id,
      name: userTable.name,
      email: userTable.email,
      handle: userTable.handle,
      emailVerified: userTable.emailVerified,
      timezone: userTable.timezone,
      profileVisibility: userTable.profileVisibility,
      createdAt: userTable.createdAt,
      xp: progression.xp,
      level: progression.level,
      currentStreak: progression.currentStreak,
      longestStreak: progression.longestStreak,
      lastCompletionAt: progression.lastCompletionAt,
    })
    .from(userTable)
    .leftJoin(progression, eq(progression.userId, userTable.id))
    .orderBy(desc(userTable.createdAt))

  const [taskCounts, completionCounts] = await Promise.all([
    db
      .select({
        userId: tasks.userId,
        n: sql<number>`count(*)::int`,
      })
      .from(tasks)
      .where(eq(tasks.active, true))
      .groupBy(tasks.userId),
    db
      .select({
        userId: events.userId,
        n: sql<number>`count(*)::int`,
      })
      .from(events)
      .where(eq(events.type, 'task.completed'))
      .groupBy(events.userId),
  ])
  const taskByUser = new Map(taskCounts.map((t) => [t.userId, t.n]))
  const completionsByUser = new Map(
    completionCounts.map((c) => [c.userId, c.n]),
  )
  const admins = allowlist()

  return rows.map((r) => ({
    id: r.id,
    name: r.name,
    email: r.email,
    handle: r.handle,
    emailVerified: r.emailVerified,
    timezone: r.timezone,
    profileVisibility: r.profileVisibility,
    createdAt: r.createdAt.toISOString(),
    xp: r.xp ?? 0,
    level: r.level ?? 1,
    currentStreak: r.currentStreak ?? 0,
    longestStreak: r.longestStreak ?? 0,
    lastCompletionAt: r.lastCompletionAt?.toISOString() ?? null,
    activeTaskCount: Number(taskByUser.get(r.id) ?? 0),
    totalCompletions: Number(completionsByUser.get(r.id) ?? 0),
    isAdmin: admins.has(r.email.toLowerCase()),
  }))
}

export interface AdminEventRow {
  id: string
  userId: string
  userName: string
  userHandle: string
  type: string
  occurredAt: string
  // Pre-serialized JSON. Kept as a string for transport simplicity — the
  // admin UI just renders it in a code block anyway.
  payload: string
}

export async function listRecentEvents(
  limit = 50,
): Promise<AdminEventRow[]> {
  const capped = Math.min(Math.max(limit, 1), 200)
  const rows = await db
    .select({
      id: events.id,
      userId: events.userId,
      type: events.type,
      payload: events.payload,
      occurredAt: events.occurredAt,
      userName: userTable.name,
      userHandle: userTable.handle,
    })
    .from(events)
    .leftJoin(userTable, eq(userTable.id, events.userId))
    .where(isNotNull(events.occurredAt))
    .orderBy(desc(events.occurredAt))
    .limit(capped)
  return rows.map((r) => ({
    id: r.id,
    userId: r.userId,
    userName: r.userName ?? '(deleted)',
    userHandle: r.userHandle ?? '',
    type: r.type,
    occurredAt: r.occurredAt!.toISOString(),
    payload: safeStringify(r.payload),
  }))
}

function safeStringify(value: unknown): string {
  try {
    return JSON.stringify(value)
  } catch {
    return '""'
  }
}

export interface AdminOpenInstance {
  count: number
  withDueAt: number
  someday: number
}

export async function countOpenInstances(): Promise<AdminOpenInstance> {
  const rows = await db
    .select({
      total: count(),
      withDue: sql<number>`count(*) filter (where ${taskInstances.dueAt} is not null)::int`,
    })
    .from(taskInstances)
    .where(
      and(
        sql`${taskInstances.completedAt} is null`,
        sql`${taskInstances.skippedAt} is null`,
      ),
    )
  const total = Number(rows[0]?.total ?? 0)
  const withDue = Number(rows[0]?.withDue ?? 0)
  return { count: total, withDueAt: withDue, someday: total - withDue }
}

// ---------------------------------------------------------------------------
// Per-user drill-in. Everything the operator needs on one page when a
// specific row in the users table looks off.
// ---------------------------------------------------------------------------

export interface AdminUserDetail {
  user: {
    id: string
    name: string
    email: string
    handle: string
    emailVerified: boolean
    timezone: string
    profileVisibility: 'public' | 'friends' | 'private'
    quietHoursStart: string | null
    quietHoursEnd: string | null
    createdAt: string
    isAdmin: boolean
  }
  progression: {
    xp: number
    level: number
    currentStreak: number
    longestStreak: number
    tokens: number
    lastCompletionAt: string | null
  }
  counts: {
    activeTasks: number
    totalCompletions: number
    openInstances: number
    openWithDue: number
    openSomeday: number
  }
  recentTasks: Array<{
    id: string
    title: string
    difficulty: string
    xpOverride: number | null
    categorySlug: string | null
    active: boolean
    createdAt: string
  }>
  openInstances: Array<{
    id: string
    taskId: string
    title: string
    dueAt: string | null
    snoozedUntil: string | null
    createdAt: string
  }>
  recentEvents: Array<{
    id: string
    type: string
    occurredAt: string
    payload: string
  }>
  pushSubscriptions: Array<{
    id: string
    endpoint: string
    deviceLabel: string | null
    failureCount: number
    lastFailureAt: string | null
    createdAt: string
  }>
  recentLlmCalls: Array<{
    id: string
    kind: string
    startedAt: string
    durationMs: number
    success: boolean
    totalTokens: number | null
    errorMessage: string | null
  }>
  motivation: FocusGameStats
}

export async function loadUserDetail(
  targetUserId: string,
): Promise<AdminUserDetail | null> {
  const u = await db.query.user.findFirst({
    where: eq(userTable.id, targetUserId),
  })
  if (!u) return null

  const [
    prog,
    activeTaskCount,
    totalCompletionsCount,
    openInstanceRows,
    recentTaskRows,
    openInstanceDetail,
    recentEventRows,
    pushRows,
    llmRows,
  ] = await Promise.all([
    db.query.progression.findFirst({
      where: eq(progression.userId, targetUserId),
    }),
    db
      .select({ n: count() })
      .from(tasks)
      .where(and(eq(tasks.userId, targetUserId), eq(tasks.active, true))),
    db
      .select({ n: count() })
      .from(events)
      .where(
        and(
          eq(events.userId, targetUserId),
          eq(events.type, 'task.completed'),
        ),
      ),
    db
      .select({
        total: count(),
        withDue: sql<number>`count(*) filter (where ${taskInstances.dueAt} is not null)::int`,
      })
      .from(taskInstances)
      .where(
        and(
          eq(taskInstances.userId, targetUserId),
          sql`${taskInstances.completedAt} is null`,
          sql`${taskInstances.skippedAt} is null`,
        ),
      ),
    db
      .select({
        id: tasks.id,
        title: tasks.title,
        difficulty: tasks.difficulty,
        xpOverride: tasks.xpOverride,
        categorySlug: tasks.categorySlug,
        active: tasks.active,
        createdAt: tasks.createdAt,
      })
      .from(tasks)
      .where(eq(tasks.userId, targetUserId))
      .orderBy(desc(tasks.createdAt))
      .limit(10),
    db
      .select({
        id: taskInstances.id,
        taskId: taskInstances.taskId,
        title: tasks.title,
        dueAt: taskInstances.dueAt,
        snoozedUntil: taskInstances.snoozedUntil,
        createdAt: taskInstances.createdAt,
      })
      .from(taskInstances)
      .innerJoin(tasks, eq(tasks.id, taskInstances.taskId))
      .where(
        and(
          eq(taskInstances.userId, targetUserId),
          sql`${taskInstances.completedAt} is null`,
          sql`${taskInstances.skippedAt} is null`,
        ),
      )
      .orderBy(sql`${taskInstances.dueAt} nulls last`)
      .limit(50),
    db
      .select({
        id: events.id,
        type: events.type,
        payload: events.payload,
        occurredAt: events.occurredAt,
      })
      .from(events)
      .where(eq(events.userId, targetUserId))
      .orderBy(desc(events.occurredAt))
      .limit(30),
    db
      .select({
        id: pushSubscriptions.id,
        endpoint: pushSubscriptions.endpoint,
        deviceLabel: pushSubscriptions.deviceLabel,
        failureCount: pushSubscriptions.failureCount,
        lastFailureAt: pushSubscriptions.lastFailureAt,
        createdAt: pushSubscriptions.createdAt,
      })
      .from(pushSubscriptions)
      .where(eq(pushSubscriptions.userId, targetUserId))
      .orderBy(desc(pushSubscriptions.createdAt)),
    db
      .select({
        id: llmCallLog.id,
        kind: llmCallLog.kind,
        startedAt: llmCallLog.startedAt,
        durationMs: llmCallLog.durationMs,
        success: llmCallLog.success,
        totalTokens: llmCallLog.totalTokens,
        errorMessage: llmCallLog.errorMessage,
      })
      .from(llmCallLog)
      .where(eq(llmCallLog.userId, targetUserId))
      .orderBy(desc(llmCallLog.startedAt))
      .limit(20),
  ])

  const open = openInstanceRows[0]
  const openTotal = Number(open?.total ?? 0)
  const openWithDue = Number(open?.withDue ?? 0)

  return {
    user: {
      id: u.id,
      name: u.name,
      email: u.email,
      handle: u.handle,
      emailVerified: u.emailVerified,
      timezone: u.timezone,
      profileVisibility: u.profileVisibility,
      quietHoursStart: u.quietHoursStart,
      quietHoursEnd: u.quietHoursEnd,
      createdAt: u.createdAt.toISOString(),
      isAdmin: isAdminEmail(u.email),
    },
    progression: {
      xp: prog?.xp ?? 0,
      level: prog?.level ?? 1,
      currentStreak: prog?.currentStreak ?? 0,
      longestStreak: prog?.longestStreak ?? 0,
      tokens: prog?.tokens ?? 0,
      lastCompletionAt: prog?.lastCompletionAt?.toISOString() ?? null,
    },
    counts: {
      activeTasks: Number(activeTaskCount[0]?.n ?? 0),
      totalCompletions: Number(totalCompletionsCount[0]?.n ?? 0),
      openInstances: openTotal,
      openWithDue,
      openSomeday: openTotal - openWithDue,
    },
    recentTasks: recentTaskRows.map((t) => ({
      id: t.id,
      title: t.title,
      difficulty: t.difficulty,
      xpOverride: t.xpOverride,
      categorySlug: t.categorySlug,
      active: t.active,
      createdAt: t.createdAt.toISOString(),
    })),
    openInstances: openInstanceDetail.map((i) => ({
      id: i.id,
      taskId: i.taskId,
      title: i.title,
      dueAt: i.dueAt?.toISOString() ?? null,
      snoozedUntil: i.snoozedUntil?.toISOString() ?? null,
      createdAt: i.createdAt.toISOString(),
    })),
    recentEvents: recentEventRows.map((e) => ({
      id: e.id,
      type: e.type,
      occurredAt: e.occurredAt.toISOString(),
      payload: safeStringify(e.payload),
    })),
    pushSubscriptions: pushRows.map((p) => ({
      id: p.id,
      endpoint: p.endpoint,
      deviceLabel: p.deviceLabel,
      failureCount: p.failureCount,
      lastFailureAt: p.lastFailureAt?.toISOString() ?? null,
      createdAt: p.createdAt.toISOString(),
    })),
    recentLlmCalls: llmRows.map((l) => ({
      id: l.id,
      kind: l.kind,
      startedAt: l.startedAt.toISOString(),
      durationMs: l.durationMs,
      success: l.success,
      totalTokens: l.totalTokens,
      errorMessage: l.errorMessage,
    })),
    motivation: await loadFocusGameStats(targetUserId),
  }
}

// ---------------------------------------------------------------------------
// LLM usage + call log. Totals, per-user, and per-day breakdowns. The
// call list is capped; drill-in fetches the full row with messages.
// ---------------------------------------------------------------------------

export interface LlmUsageTotal {
  callCount: number
  successCount: number
  totalDurationMs: number
  totalTokens: number
  promptTokens: number
  completionTokens: number
}

export interface LlmUsagePerUser {
  userId: string | null
  userName: string | null
  userHandle: string | null
  email: string | null
  callCount: number
  successCount: number
  totalDurationMs: number
  totalTokens: number
  lastCallAt: string | null
}

export interface LlmUsagePerKind {
  kind: string
  callCount: number
  successCount: number
  totalDurationMs: number
  totalTokens: number
}

export interface LlmUsagePerDay {
  day: string
  callCount: number
  successCount: number
  totalDurationMs: number
  totalTokens: number
}

export interface LlmUsage {
  generatedAt: string
  windowDays: number
  totalsAllTime: LlmUsageTotal
  totalsInWindow: LlmUsageTotal
  perKind: LlmUsagePerKind[]
  perUser: LlmUsagePerUser[]
  perDay: LlmUsagePerDay[]
}

export async function loadLlmUsage(windowDays = 14): Promise<LlmUsage> {
  const now = new Date()
  const sinceWindow = new Date(
    now.getTime() - windowDays * 24 * 60 * 60 * 1000,
  )

  const totalExpr = {
    callCount: sql<number>`count(*)::int`,
    successCount: sql<number>`count(*) filter (where ${llmCallLog.success} = true)::int`,
    totalDurationMs: sql<number>`coalesce(sum(${llmCallLog.durationMs}), 0)::bigint`,
    totalTokens: sql<number>`coalesce(sum(${llmCallLog.totalTokens}), 0)::bigint`,
    promptTokens: sql<number>`coalesce(sum(${llmCallLog.promptTokens}), 0)::bigint`,
    completionTokens: sql<number>`coalesce(sum(${llmCallLog.completionTokens}), 0)::bigint`,
  }

  const [allTimeRow, inWindowRow, perKindRows, perUserRows, perDayRows] =
    await Promise.all([
      db.select(totalExpr).from(llmCallLog),
      db
        .select(totalExpr)
        .from(llmCallLog)
        .where(gte(llmCallLog.startedAt, sinceWindow)),
      db
        .select({
          kind: llmCallLog.kind,
          callCount: sql<number>`count(*)::int`,
          successCount: sql<number>`count(*) filter (where ${llmCallLog.success} = true)::int`,
          totalDurationMs: sql<number>`coalesce(sum(${llmCallLog.durationMs}), 0)::bigint`,
          totalTokens: sql<number>`coalesce(sum(${llmCallLog.totalTokens}), 0)::bigint`,
        })
        .from(llmCallLog)
        .where(gte(llmCallLog.startedAt, sinceWindow))
        .groupBy(llmCallLog.kind)
        .orderBy(sql`count(*) desc`),
      db
        .select({
          userId: llmCallLog.userId,
          userName: userTable.name,
          userHandle: userTable.handle,
          email: userTable.email,
          callCount: sql<number>`count(*)::int`,
          successCount: sql<number>`count(*) filter (where ${llmCallLog.success} = true)::int`,
          totalDurationMs: sql<number>`coalesce(sum(${llmCallLog.durationMs}), 0)::bigint`,
          totalTokens: sql<number>`coalesce(sum(${llmCallLog.totalTokens}), 0)::bigint`,
          lastCallAt: sql<Date>`max(${llmCallLog.startedAt})`,
        })
        .from(llmCallLog)
        .leftJoin(userTable, eq(userTable.id, llmCallLog.userId))
        .where(gte(llmCallLog.startedAt, sinceWindow))
        .groupBy(
          llmCallLog.userId,
          userTable.name,
          userTable.handle,
          userTable.email,
        )
        .orderBy(sql`sum(${llmCallLog.durationMs}) desc nulls last`),
      // date_trunc bucketing keeps this accurate regardless of how many
      // days fit in the window; UI renders the last `windowDays` entries.
      db
        .select({
          day: sql<string>`to_char(date_trunc('day', ${llmCallLog.startedAt}), 'YYYY-MM-DD')`,
          callCount: sql<number>`count(*)::int`,
          successCount: sql<number>`count(*) filter (where ${llmCallLog.success} = true)::int`,
          totalDurationMs: sql<number>`coalesce(sum(${llmCallLog.durationMs}), 0)::bigint`,
          totalTokens: sql<number>`coalesce(sum(${llmCallLog.totalTokens}), 0)::bigint`,
        })
        .from(llmCallLog)
        .where(gte(llmCallLog.startedAt, sinceWindow))
        .groupBy(sql`date_trunc('day', ${llmCallLog.startedAt})`)
        .orderBy(sql`date_trunc('day', ${llmCallLog.startedAt}) desc`),
    ])

  const toTotal = (r: Record<string, unknown> | undefined): LlmUsageTotal => ({
    callCount: Number(r?.callCount ?? 0),
    successCount: Number(r?.successCount ?? 0),
    totalDurationMs: Number(r?.totalDurationMs ?? 0),
    totalTokens: Number(r?.totalTokens ?? 0),
    promptTokens: Number(r?.promptTokens ?? 0),
    completionTokens: Number(r?.completionTokens ?? 0),
  })

  return {
    generatedAt: now.toISOString(),
    windowDays,
    totalsAllTime: toTotal(allTimeRow[0]),
    totalsInWindow: toTotal(inWindowRow[0]),
    perKind: perKindRows.map((r) => ({
      kind: r.kind,
      callCount: Number(r.callCount),
      successCount: Number(r.successCount),
      totalDurationMs: Number(r.totalDurationMs),
      totalTokens: Number(r.totalTokens),
    })),
    perUser: perUserRows.map((r) => ({
      userId: r.userId,
      userName: r.userName,
      userHandle: r.userHandle,
      email: r.email,
      callCount: Number(r.callCount),
      successCount: Number(r.successCount),
      totalDurationMs: Number(r.totalDurationMs),
      totalTokens: Number(r.totalTokens),
      lastCallAt: r.lastCallAt ? new Date(r.lastCallAt).toISOString() : null,
    })),
    perDay: perDayRows.map((r) => ({
      day: r.day,
      callCount: Number(r.callCount),
      successCount: Number(r.successCount),
      totalDurationMs: Number(r.totalDurationMs),
      totalTokens: Number(r.totalTokens),
    })),
  }
}

export interface LlmCallListItem {
  id: string
  userId: string | null
  userHandle: string | null
  userName: string | null
  kind: string
  model: string | null
  startedAt: string
  durationMs: number
  success: boolean
  totalTokens: number | null
  errorMessage: string | null
}

export interface LlmCallList {
  rows: LlmCallListItem[]
  // Cursor is the startedAt ISO of the last returned row; pass it back as
  // `before` to fetch the next page.
  nextCursor: string | null
}

export async function listLlmCalls(params: {
  kind?: string
  userId?: string
  before?: string | null
  limit?: number
}): Promise<LlmCallList> {
  const limit = Math.min(Math.max(params.limit ?? 50, 1), 200)
  const conditions = []
  if (params.kind) conditions.push(eq(llmCallLog.kind, params.kind))
  if (params.userId) conditions.push(eq(llmCallLog.userId, params.userId))
  if (params.before) {
    const d = new Date(params.before)
    if (!Number.isNaN(d.getTime())) {
      conditions.push(lt(llmCallLog.startedAt, d))
    }
  }
  const where = conditions.length > 0 ? and(...conditions) : undefined

  const rows = await db
    .select({
      id: llmCallLog.id,
      userId: llmCallLog.userId,
      kind: llmCallLog.kind,
      model: llmCallLog.model,
      startedAt: llmCallLog.startedAt,
      durationMs: llmCallLog.durationMs,
      success: llmCallLog.success,
      totalTokens: llmCallLog.totalTokens,
      errorMessage: llmCallLog.errorMessage,
      userHandle: userTable.handle,
      userName: userTable.name,
    })
    .from(llmCallLog)
    .leftJoin(userTable, eq(userTable.id, llmCallLog.userId))
    .where(where)
    .orderBy(desc(llmCallLog.startedAt))
    .limit(limit + 1)

  const hasMore = rows.length > limit
  const page = hasMore ? rows.slice(0, limit) : rows
  const nextCursor = hasMore
    ? page[page.length - 1].startedAt.toISOString()
    : null

  return {
    rows: page.map((r) => ({
      id: r.id,
      userId: r.userId,
      userHandle: r.userHandle,
      userName: r.userName,
      kind: r.kind,
      model: r.model,
      startedAt: r.startedAt.toISOString(),
      durationMs: r.durationMs,
      success: r.success,
      totalTokens: r.totalTokens,
      errorMessage: r.errorMessage,
    })),
    nextCursor,
  }
}

export interface LlmCallDetail {
  id: string
  userId: string | null
  userHandle: string | null
  userName: string | null
  kind: string
  model: string | null
  startedAt: string
  durationMs: number
  success: boolean
  errorMessage: string | null
  promptTokens: number | null
  completionTokens: number | null
  totalTokens: number | null
  messages: Array<{ role: string; content: string }> | null
  response: string | null
}

export async function getLlmCallDetail(
  id: string,
): Promise<LlmCallDetail | null> {
  const rows = await db
    .select({
      id: llmCallLog.id,
      userId: llmCallLog.userId,
      kind: llmCallLog.kind,
      model: llmCallLog.model,
      startedAt: llmCallLog.startedAt,
      durationMs: llmCallLog.durationMs,
      success: llmCallLog.success,
      errorMessage: llmCallLog.errorMessage,
      promptTokens: llmCallLog.promptTokens,
      completionTokens: llmCallLog.completionTokens,
      totalTokens: llmCallLog.totalTokens,
      messages: llmCallLog.messages,
      response: llmCallLog.response,
      userHandle: userTable.handle,
      userName: userTable.name,
    })
    .from(llmCallLog)
    .leftJoin(userTable, eq(userTable.id, llmCallLog.userId))
    .where(eq(llmCallLog.id, id))
    .limit(1)
  const r = rows[0]
  if (!r) return null
  return {
    id: r.id,
    userId: r.userId,
    userHandle: r.userHandle,
    userName: r.userName,
    kind: r.kind,
    model: r.model,
    startedAt: r.startedAt.toISOString(),
    durationMs: r.durationMs,
    success: r.success,
    errorMessage: r.errorMessage,
    promptTokens: r.promptTokens,
    completionTokens: r.completionTokens,
    totalTokens: r.totalTokens,
    messages: r.messages,
    response: r.response,
  }
}

// Admin-issued token grant. Writes a `tokens.granted` event so the balance
// survives `rebuildProgression` (triggered e.g. by task reopen). Amount may
// be negative to deduct. Balance clamps at 0 in applyEvent.
export async function grantTokens(input: {
  targetUserId: string
  grantedBy: string
  amount: number
  reason: string | null
}): Promise<{ tokens: number }> {
  if (!Number.isInteger(input.amount) || input.amount === 0) {
    throw new Error('amount must be a non-zero integer')
  }
  const now = new Date()
  const event: DomainEvent = {
    type: 'tokens.granted',
    amount: input.amount,
    reason: input.reason,
    grantedBy: input.grantedBy,
    occurredAt: now,
  }

  return await db.transaction(async (tx) => {
    const target = await tx.query.user.findFirst({
      where: eq(userTable.id, input.targetUserId),
      columns: { id: true },
    })
    if (!target) throw new Error('target user not found')

    await tx.insert(events).values({
      userId: input.targetUserId,
      type: event.type,
      payload: {
        amount: event.amount,
        reason: event.reason,
        grantedBy: event.grantedBy,
      },
      occurredAt: now,
    })

    const current = await tx.query.progression.findFirst({
      where: eq(progression.userId, input.targetUserId),
    })
    const prevState = current
      ? {
          xp: current.xp,
          level: current.level,
          currentStreak: current.currentStreak,
          longestStreak: current.longestStreak,
          tokens: current.tokens,
          lastCompletionAt: current.lastCompletionAt,
        }
      : INITIAL_PROGRESSION

    const next = applyEvent(prevState, event, { timeZone: 'UTC' })

    await tx
      .insert(progression)
      .values({
        userId: input.targetUserId,
        tokens: next.tokens,
      })
      .onConflictDoUpdate({
        target: progression.userId,
        set: { tokens: next.tokens, updatedAt: now },
      })

    return { tokens: next.tokens }
  })
}
