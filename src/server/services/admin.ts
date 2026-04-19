// Admin dashboard queries. Single source of truth for the isAdmin check,
// which is driven by the ADMIN_EMAILS env var — a comma-separated list of
// emails allowed into /admin. Keep queries cheap-ish; this is for the
// operator, not for users, so correctness > polish.
import { and, count, desc, eq, gte, isNotNull, sql } from 'drizzle-orm'
import { db } from '../db/client'
import {
  events,
  progression,
  pushSubscriptions,
  taskInstances,
  tasks,
  user as userTable,
} from '../db/schema'

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
  system: {
    llm: boolean
    smtp: boolean
    vapid: boolean
    adminCount: number
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
