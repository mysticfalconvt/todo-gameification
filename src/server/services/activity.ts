// Activity feed + cheers. Shows recent completions from friends, respecting
// shareActivity / shareTaskTitles prefs and per-task visibility. Cheers bump
// the recipient's XP and cost nothing to the giver, with a daily cap to keep
// mutual-cheer farming bounded.
import { and, desc, eq, gte, inArray, isNotNull, or, sql } from 'drizzle-orm'
import { db } from '../db/client'
import {
  events,
  friendships,
  progression,
  tasks,
  user as userTable,
  userPrefs,
} from '../db/schema'
import { INITIAL_PROGRESSION, applyEvent } from '../../domain/gamification'
import type { DomainEvent } from '../../domain/events'
import { sendPushToUser } from '../push/broadcast'
import { getUserTimeZone } from './tasks'

export const CHEER_XP = 2
const CHEER_DAILY_CAP = 20

export interface ActivityRow {
  eventId: string
  userId: string
  handle: string
  name: string
  taskTitle: string | null
  xp: number
  occurredAt: Date
  cheerCount: number
  viewerCheered: boolean
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

export async function getFriendActivity(
  viewerId: string,
  opts: { days: number; limit?: number } = { days: 7 },
): Promise<ActivityRow[]> {
  const friendIds = await friendIdsFor(viewerId)
  if (friendIds.length === 0) return []
  const since = new Date(Date.now() - opts.days * 24 * 3_600_000)
  const limit = Math.min(Math.max(opts.limit ?? 50, 1), 200)

  // Only include friends who allow activity sharing.
  const sharers = await db
    .select({
      id: userTable.id,
      handle: userTable.handle,
      name: userTable.name,
      shareActivity: userPrefs.shareActivity,
      shareTaskTitles: userPrefs.shareTaskTitles,
    })
    .from(userTable)
    .leftJoin(userPrefs, eq(userPrefs.userId, userTable.id))
    .where(inArray(userTable.id, friendIds))

  const allowed = sharers.filter((s) => (s.shareActivity ?? true) !== false)
  if (allowed.length === 0) return []
  const allowedIds = allowed.map((a) => a.id)
  const shareTitlesByUser = new Map(
    allowed.map((a) => [a.id, a.shareTaskTitles ?? false]),
  )
  const profileByUser = new Map(
    allowed.map((a) => [a.id, { handle: a.handle, name: a.name }]),
  )

  const completions = await db
    .select({
      id: events.id,
      userId: events.userId,
      payload: events.payload,
      occurredAt: events.occurredAt,
      taskId: tasks.id,
      taskTitle: tasks.title,
      taskVisibility: tasks.visibility,
    })
    .from(events)
    .leftJoin(tasks, eq(tasks.id, sql`(${events.payload}->>'taskId')::uuid`))
    .where(
      and(
        eq(events.type, 'task.completed'),
        isNotNull(events.occurredAt),
        gte(events.occurredAt, since),
        inArray(events.userId, allowedIds),
      ),
    )
    .orderBy(desc(events.occurredAt))
    .limit(limit)

  if (completions.length === 0) return []

  // Fetch cheers for these completion events so we can count + detect
  // whether the viewer has already cheered.
  const completionIds = completions.map((c) => c.id)
  const cheers = await db
    .select({
      completionEventId: sql<string>`${events.payload}->>'completionEventId'`,
      giverUserId: sql<string>`${events.payload}->>'giverUserId'`,
    })
    .from(events)
    .where(
      and(
        eq(events.type, 'task.cheered'),
        sql`${events.payload}->>'completionEventId' IN ${completionIds}`,
      ),
    )

  const cheersByCompletion = new Map<
    string,
    { count: number; viewerCheered: boolean }
  >()
  for (const c of cheers) {
    const bucket =
      cheersByCompletion.get(c.completionEventId) ?? {
        count: 0,
        viewerCheered: false,
      }
    bucket.count += 1
    if (c.giverUserId === viewerId) bucket.viewerCheered = true
    cheersByCompletion.set(c.completionEventId, bucket)
  }

  return completions
    .filter(
      (c) =>
        // Per-task visibility gate. Private tasks are hidden entirely.
        c.taskVisibility !== 'private',
    )
    .map((c): ActivityRow => {
      const p =
        c.payload && typeof c.payload === 'object'
          ? (c.payload as Record<string, unknown>)
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
      const showTitle = shareTitlesByUser.get(c.userId) ?? false
      const prof = profileByUser.get(c.userId) ?? { handle: '', name: '' }
      const cheerBucket = cheersByCompletion.get(c.id) ?? {
        count: 0,
        viewerCheered: false,
      }
      return {
        eventId: c.id,
        userId: c.userId,
        handle: prof.handle,
        name: prof.name,
        taskTitle: showTitle ? c.taskTitle ?? null : null,
        xp,
        occurredAt: c.occurredAt!,
        cheerCount: cheerBucket.count,
        viewerCheered: cheerBucket.viewerCheered,
      }
    })
}

export async function cheerCompletion(
  giverId: string,
  completionEventId: string,
): Promise<{ ok: true }> {
  // Load the completion event.
  const completion = await db.query.events.findFirst({
    where: and(eq(events.id, completionEventId), eq(events.type, 'task.completed')),
  })
  if (!completion) throw new Error('That completion no longer exists.')
  const recipientId = completion.userId
  if (recipientId === giverId) {
    throw new Error("You can't cheer your own completion.")
  }

  // Viewer must be an accepted friend of the recipient for cheers to count.
  const friendRow = await db.query.friendships.findFirst({
    where: and(
      eq(friendships.status, 'accepted'),
      or(
        and(
          eq(friendships.requesterId, giverId),
          eq(friendships.addresseeId, recipientId),
        ),
        and(
          eq(friendships.requesterId, recipientId),
          eq(friendships.addresseeId, giverId),
        ),
      ),
    ),
  })
  if (!friendRow) throw new Error('Only friends can cheer each other.')

  // Dedupe: has this giver already cheered this completion?
  const existing = await db
    .select({ id: events.id })
    .from(events)
    .where(
      and(
        eq(events.type, 'task.cheered'),
        sql`${events.payload}->>'completionEventId' = ${completionEventId}`,
        sql`${events.payload}->>'giverUserId' = ${giverId}`,
      ),
    )
    .limit(1)
  if (existing.length > 0) {
    throw new Error('Already cheered.')
  }

  // Daily cap per giver.
  const since = new Date(Date.now() - 24 * 60 * 60 * 1000)
  const recent = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(events)
    .where(
      and(
        eq(events.type, 'task.cheered'),
        gte(events.occurredAt, since),
        sql`${events.payload}->>'giverUserId' = ${giverId}`,
      ),
    )
  if ((recent[0]?.count ?? 0) >= CHEER_DAILY_CAP) {
    throw new Error('Daily cheer limit reached.')
  }

  const now = new Date()
  const cheerEvent: DomainEvent = {
    type: 'task.cheered',
    completionEventId,
    giverUserId: giverId,
    xp: CHEER_XP,
    occurredAt: now,
  }

  const timeZone = await getUserTimeZone(recipientId)

  await db.transaction(async (tx) => {
    await tx.insert(events).values({
      userId: recipientId,
      type: cheerEvent.type,
      payload: {
        completionEventId: cheerEvent.completionEventId,
        giverUserId: cheerEvent.giverUserId,
        xp: cheerEvent.xp,
      },
      occurredAt: now,
    })

    const current = await tx.query.progression.findFirst({
      where: eq(progression.userId, recipientId),
    })
    const prevState = current
      ? {
          xp: current.xp,
          level: current.level,
          currentStreak: current.currentStreak,
          longestStreak: current.longestStreak,
          lastCompletionAt: current.lastCompletionAt,
        }
      : INITIAL_PROGRESSION

    const next = applyEvent(prevState, cheerEvent, { timeZone })

    await tx
      .insert(progression)
      .values({
        userId: recipientId,
        xp: next.xp,
        level: next.level,
        currentStreak: next.currentStreak,
        longestStreak: next.longestStreak,
        lastCompletionAt: next.lastCompletionAt,
      })
      .onConflictDoUpdate({
        target: progression.userId,
        set: {
          xp: next.xp,
          level: next.level,
          updatedAt: now,
        },
      })
  })

  // Best-effort push to the recipient. Errors are logged only — the cheer
  // itself already landed, so a failed push shouldn't fail the mutation.
  try {
    const taskId =
      completion.payload && typeof completion.payload === 'object'
        ? (completion.payload as Record<string, unknown>)['taskId']
        : null
    const [giver, task] = await Promise.all([
      db.query.user.findFirst({
        where: eq(userTable.id, giverId),
        columns: { name: true, handle: true },
      }),
      typeof taskId === 'string'
        ? db.query.tasks.findFirst({
            where: eq(tasks.id, taskId),
            columns: { title: true },
          })
        : Promise.resolve(null),
    ])
    if (giver) {
      const title = task?.title ? `"${task.title}"` : 'your completion'
      await sendPushToUser(recipientId, {
        title: `${giver.name} cheered you`,
        body: `${title} · +${CHEER_XP} XP`,
        tag: `cheer-${completionEventId}`,
        url: '/friends',
      })
    }
  } catch (err) {
    console.error('[activity] cheer push failed:', err)
  }

  return { ok: true }
}

export interface ReceivedCheer {
  eventId: string
  giverUserId: string
  giverHandle: string
  giverName: string
  taskTitle: string | null
  xp: number
  occurredAt: Date
}

// Recent cheers the viewer has received. Joins through the referenced
// completion event so we can surface the original task's title (respecting
// the task-level visibility: private completions never surface, even if
// somehow cheered).
export async function getReceivedCheers(
  viewerId: string,
  opts: { days?: number; limit?: number } = {},
): Promise<ReceivedCheer[]> {
  const days = opts.days ?? 30
  const limit = Math.min(Math.max(opts.limit ?? 50, 1), 200)
  const since = new Date(Date.now() - days * 24 * 3_600_000)

  const rows = await db
    .select({
      id: events.id,
      payload: events.payload,
      occurredAt: events.occurredAt,
    })
    .from(events)
    .where(
      and(
        eq(events.userId, viewerId),
        eq(events.type, 'task.cheered'),
        isNotNull(events.occurredAt),
        gte(events.occurredAt, since),
      ),
    )
    .orderBy(desc(events.occurredAt))
    .limit(limit)

  if (rows.length === 0) return []

  const giverIds: string[] = []
  const completionIds: string[] = []
  for (const r of rows) {
    const p =
      r.payload && typeof r.payload === 'object'
        ? (r.payload as Record<string, unknown>)
        : {}
    const giver = typeof p['giverUserId'] === 'string' ? p['giverUserId'] : null
    const comp =
      typeof p['completionEventId'] === 'string' ? p['completionEventId'] : null
    if (giver) giverIds.push(giver)
    if (comp) completionIds.push(comp)
  }

  const [givers, completions] = await Promise.all([
    giverIds.length > 0
      ? db
          .select({
            id: userTable.id,
            handle: userTable.handle,
            name: userTable.name,
          })
          .from(userTable)
          .where(inArray(userTable.id, giverIds))
      : Promise.resolve([] as Array<{ id: string; handle: string; name: string }>),
    completionIds.length > 0
      ? db
          .select({
            id: events.id,
            taskTitle: tasks.title,
            taskVisibility: tasks.visibility,
          })
          .from(events)
          .leftJoin(
            tasks,
            eq(tasks.id, sql`(${events.payload}->>'taskId')::uuid`),
          )
          .where(inArray(events.id, completionIds))
      : Promise.resolve(
          [] as Array<{
            id: string
            taskTitle: string | null
            taskVisibility: string | null
          }>,
        ),
  ])

  const giverById = new Map(givers.map((g) => [g.id, g]))
  const completionById = new Map(completions.map((c) => [c.id, c]))

  return rows
    .map((r): ReceivedCheer | null => {
      const p =
        r.payload && typeof r.payload === 'object'
          ? (r.payload as Record<string, unknown>)
          : {}
      const giverId =
        typeof p['giverUserId'] === 'string' ? (p['giverUserId'] as string) : ''
      const compId =
        typeof p['completionEventId'] === 'string'
          ? (p['completionEventId'] as string)
          : ''
      const xp = typeof p['xp'] === 'number' ? (p['xp'] as number) : CHEER_XP
      const giver = giverById.get(giverId)
      if (!giver) return null
      const comp = completionById.get(compId)
      // Don't surface titles from private tasks even to the owner here —
      // keeps the behavior consistent with the activity feed.
      const title =
        comp && comp.taskVisibility !== 'private' ? comp.taskTitle : null
      return {
        eventId: r.id,
        giverUserId: giverId,
        giverHandle: giver.handle,
        giverName: giver.name,
        taskTitle: title,
        xp,
        occurredAt: r.occurredAt!,
      }
    })
    .filter((c): c is ReceivedCheer => c !== null)
}
