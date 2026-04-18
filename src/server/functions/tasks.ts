import { and, eq, isNotNull, isNull, lt, or } from 'drizzle-orm'
import { createServerFn } from '@tanstack/react-start'
import { db } from '../db/client'
import {
  events,
  progression,
  taskInstances,
  tasks,
  user as userTable,
} from '../db/schema'
import type { Recurrence } from '../../domain/recurrence'
import { computeNextDue, firstDueAt } from '../../domain/recurrence'
import { assertValidTimeOfDay } from '../../domain/time'
import type { Difficulty, DomainEvent } from '../../domain/events'
import {
  INITIAL_PROGRESSION,
  applyEvent,
} from '../../domain/gamification'
import { authMiddleware } from '../middleware/auth'
import { scheduleReminder } from '../boss'
import { scoreTask } from '../llm/scoreTask'

interface CreateTaskInput {
  title: string
  notes?: string | null
  difficulty: Difficulty
  recurrence: Recurrence | null
  timeOfDay: string | null
  someday: boolean
}

async function loadUserTimeZone(userId: string): Promise<string> {
  const row = await db.query.user.findFirst({
    where: eq(userTable.id, userId),
    columns: { timezone: true },
  })
  return row?.timezone ?? 'UTC'
}

export const createTask = createServerFn({ method: 'POST' })
  .middleware([authMiddleware])
  .inputValidator((data: CreateTaskInput) => {
    if (!data.title?.trim()) throw new Error('title is required')
    if (!['small', 'medium', 'large'].includes(data.difficulty)) {
      throw new Error('invalid difficulty')
    }
    if (data.timeOfDay) assertValidTimeOfDay(data.timeOfDay)
    if (data.someday && data.recurrence) {
      throw new Error('someday tasks cannot be recurring')
    }
    return data
  })
  .handler(async ({ data, context }) => {
    const now = new Date()
    const timeZone = await loadUserTimeZone(context.userId)

    const dueAt = firstDueAt({
      now,
      recurrence: data.recurrence,
      timeOfDay: data.someday ? null : data.timeOfDay,
      timeZone,
      someday: data.someday,
    })

    const scored = await scoreTask({
      title: data.title.trim(),
      notes: data.notes,
      difficultyHint: data.difficulty,
    })

    const result = await db.transaction(async (tx) => {
      const [task] = await tx
        .insert(tasks)
        .values({
          userId: context.userId,
          title: data.title.trim(),
          notes: data.notes ?? null,
          difficulty: data.difficulty,
          xpOverride: scored?.xp ?? null,
          recurrence: data.recurrence,
          timeOfDay: data.someday ? null : data.timeOfDay,
        })
        .returning()

      const [inst] = await tx
        .insert(taskInstances)
        .values({
          taskId: task.id,
          userId: context.userId,
          dueAt,
        })
        .returning()

      return { id: task.id, instanceId: inst.id, dueAt: inst.dueAt }
    })

    if (result.dueAt && result.dueAt > new Date()) {
      await scheduleReminder(
        { taskInstanceId: result.instanceId, kind: 'due' },
        result.dueAt,
      ).catch((e) => console.error('scheduleReminder failed', e))
    }

    return {
      id: result.id,
      scored: scored
        ? { xp: scored.xp, tier: scored.tier, reasoning: scored.reasoning }
        : null,
    }
  })

interface TodayInstance {
  instanceId: string
  taskId: string
  title: string
  difficulty: Difficulty
  xpOverride: number | null
  dueAt: string
  timeOfDay: string | null
  snoozedUntil: string | null
}

interface SomedayInstance {
  instanceId: string
  taskId: string
  title: string
  difficulty: Difficulty
  xpOverride: number | null
}

export const listTodayInstances = createServerFn({ method: 'GET' })
  .middleware([authMiddleware])
  .handler(async ({ context }): Promise<TodayInstance[]> => {
    const now = new Date()
    const horizon = new Date(now.getTime() + 36 * 3_600_000)

    const rows = await db
      .select({
        instanceId: taskInstances.id,
        taskId: tasks.id,
        title: tasks.title,
        difficulty: tasks.difficulty,
        xpOverride: tasks.xpOverride,
        timeOfDay: tasks.timeOfDay,
        dueAt: taskInstances.dueAt,
        snoozedUntil: taskInstances.snoozedUntil,
      })
      .from(taskInstances)
      .innerJoin(tasks, eq(tasks.id, taskInstances.taskId))
      .where(
        and(
          eq(taskInstances.userId, context.userId),
          isNull(taskInstances.completedAt),
          isNull(taskInstances.skippedAt),
          isNotNull(taskInstances.dueAt),
          lt(taskInstances.dueAt, horizon),
          or(
            isNull(taskInstances.snoozedUntil),
            lt(taskInstances.snoozedUntil, now),
          ),
          eq(tasks.active, true),
          or(isNull(tasks.snoozeUntil), lt(tasks.snoozeUntil, now)),
        ),
      )
      .orderBy(taskInstances.dueAt)

    return rows.map((r) => ({
      instanceId: r.instanceId,
      taskId: r.taskId,
      title: r.title,
      difficulty: r.difficulty as Difficulty,
      xpOverride: r.xpOverride,
      dueAt: r.dueAt!.toISOString(),
      timeOfDay: r.timeOfDay,
      snoozedUntil: r.snoozedUntil?.toISOString() ?? null,
    }))
  })

export const listSomedayInstances = createServerFn({ method: 'GET' })
  .middleware([authMiddleware])
  .handler(async ({ context }): Promise<SomedayInstance[]> => {
    const rows = await db
      .select({
        instanceId: taskInstances.id,
        taskId: tasks.id,
        title: tasks.title,
        difficulty: tasks.difficulty,
        xpOverride: tasks.xpOverride,
        createdAt: tasks.createdAt,
      })
      .from(taskInstances)
      .innerJoin(tasks, eq(tasks.id, taskInstances.taskId))
      .where(
        and(
          eq(taskInstances.userId, context.userId),
          isNull(taskInstances.completedAt),
          isNull(taskInstances.skippedAt),
          isNull(taskInstances.dueAt),
          eq(tasks.active, true),
        ),
      )
      .orderBy(tasks.createdAt)

    return rows.map((r) => ({
      instanceId: r.instanceId,
      taskId: r.taskId,
      title: r.title,
      difficulty: r.difficulty as Difficulty,
      xpOverride: r.xpOverride,
    }))
  })

export const completeInstance = createServerFn({ method: 'POST' })
  .middleware([authMiddleware])
  .inputValidator((data: { instanceId: string }) => {
    if (!data.instanceId) throw new Error('instanceId required')
    return data
  })
  .handler(async ({ data, context }) => {
    const now = new Date()
    const timeZone = await loadUserTimeZone(context.userId)

    return db.transaction(async (tx) => {
      const instance = await tx.query.taskInstances.findFirst({
        where: and(
          eq(taskInstances.id, data.instanceId),
          eq(taskInstances.userId, context.userId),
        ),
      })
      if (!instance) throw new Error('instance not found')
      if (instance.completedAt || instance.skippedAt) {
        return { alreadyHandled: true as const }
      }

      const task = await tx.query.tasks.findFirst({
        where: eq(tasks.id, instance.taskId),
      })
      if (!task) throw new Error('task missing')

      await tx
        .update(taskInstances)
        .set({ completedAt: now })
        .where(eq(taskInstances.id, instance.id))

      const event: DomainEvent = {
        type: 'task.completed',
        taskId: task.id,
        instanceId: instance.id,
        difficulty: task.difficulty as Difficulty,
        xpOverride: task.xpOverride,
        dueAt: instance.dueAt,
        timeOfDay: task.timeOfDay,
        occurredAt: now,
      }

      await tx.insert(events).values({
        userId: context.userId,
        type: event.type,
        payload: {
          taskId: event.taskId,
          instanceId: event.instanceId,
          difficulty: event.difficulty,
          xpOverride: event.xpOverride,
          dueAt: event.dueAt?.toISOString() ?? null,
          timeOfDay: event.timeOfDay,
        },
        occurredAt: now,
      })

      const current = await tx.query.progression.findFirst({
        where: eq(progression.userId, context.userId),
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

      const next = applyEvent(prevState, event, { timeZone })

      await tx
        .insert(progression)
        .values({
          userId: context.userId,
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
            currentStreak: next.currentStreak,
            longestStreak: next.longestStreak,
            lastCompletionAt: next.lastCompletionAt,
            updatedAt: now,
          },
        })

      let materialized: { instanceId: string; dueAt: Date } | null = null
      if (task.recurrence && task.active && instance.dueAt) {
        const nextDue = computeNextDue({
          recurrence: task.recurrence,
          previousDueAt: instance.dueAt,
          completedAt: now,
          timeOfDay: task.timeOfDay,
          timeZone,
        })
        const [inst] = await tx
          .insert(taskInstances)
          .values({
            taskId: task.id,
            userId: context.userId,
            dueAt: nextDue,
          })
          .returning()
        materialized = { instanceId: inst.id, dueAt: nextDue }
      }

      return {
        alreadyHandled: false as const,
        xp: next.xp,
        level: next.level,
        currentStreak: next.currentStreak,
        materialized,
      }
    }).then(async (r) => {
      if (!r.alreadyHandled && r.materialized && r.materialized.dueAt > new Date()) {
        await scheduleReminder(
          { taskInstanceId: r.materialized.instanceId, kind: 'due' },
          r.materialized.dueAt,
        ).catch((e) => console.error('scheduleReminder failed', e))
      }
      if (r.alreadyHandled) return { alreadyHandled: true as const }
      return {
        alreadyHandled: false as const,
        xp: r.xp,
        level: r.level,
        currentStreak: r.currentStreak,
      }
    })
  })

export const skipInstance = createServerFn({ method: 'POST' })
  .middleware([authMiddleware])
  .inputValidator((data: { instanceId: string }) => {
    if (!data.instanceId) throw new Error('instanceId required')
    return data
  })
  .handler(async ({ data, context }) => {
    const now = new Date()
    const timeZone = await loadUserTimeZone(context.userId)

    return db.transaction(async (tx) => {
      const instance = await tx.query.taskInstances.findFirst({
        where: and(
          eq(taskInstances.id, data.instanceId),
          eq(taskInstances.userId, context.userId),
        ),
      })
      if (!instance) throw new Error('instance not found')
      if (instance.completedAt || instance.skippedAt) return { alreadyHandled: true }

      const task = await tx.query.tasks.findFirst({
        where: eq(tasks.id, instance.taskId),
      })
      if (!task) throw new Error('task missing')

      await tx
        .update(taskInstances)
        .set({ skippedAt: now })
        .where(eq(taskInstances.id, instance.id))

      await tx.insert(events).values({
        userId: context.userId,
        type: 'task.skipped',
        payload: { taskId: task.id, instanceId: instance.id },
        occurredAt: now,
      })

      let materialized: { instanceId: string; dueAt: Date } | null = null
      if (task.recurrence && task.active && instance.dueAt) {
        const nextDue = computeNextDue({
          recurrence: task.recurrence,
          previousDueAt: instance.dueAt,
          completedAt: now,
          timeOfDay: task.timeOfDay,
          timeZone,
        })
        const [inst] = await tx
          .insert(taskInstances)
          .values({
            taskId: task.id,
            userId: context.userId,
            dueAt: nextDue,
          })
          .returning()
        materialized = { instanceId: inst.id, dueAt: nextDue }
      }

      return { alreadyHandled: false, materialized }
    }).then(async (r) => {
      if (!r.alreadyHandled && r.materialized && r.materialized.dueAt > new Date()) {
        await scheduleReminder(
          { taskInstanceId: r.materialized.instanceId, kind: 'due' },
          r.materialized.dueAt,
        ).catch((e) => console.error('scheduleReminder failed', e))
      }
      return { alreadyHandled: r.alreadyHandled }
    })
  })

export const snoozeInstance = createServerFn({ method: 'POST' })
  .middleware([authMiddleware])
  .inputValidator((data: { instanceId: string; hours: number }) => {
    if (!data.instanceId) throw new Error('instanceId required')
    if (!Number.isFinite(data.hours) || data.hours <= 0) {
      throw new Error('hours must be positive')
    }
    return data
  })
  .handler(async ({ data, context }) => {
    const until = new Date(Date.now() + data.hours * 3_600_000)
    const result = await db
      .update(taskInstances)
      .set({ snoozedUntil: until })
      .where(
        and(
          eq(taskInstances.id, data.instanceId),
          eq(taskInstances.userId, context.userId),
        ),
      )
      .returning({ id: taskInstances.id })
    if (result.length === 0) throw new Error('instance not found')
    return { snoozedUntil: until.toISOString() }
  })

interface TaskSummary {
  id: string
  title: string
  notes: string | null
  difficulty: Difficulty
  xpOverride: number | null
  recurrence: Recurrence | null
  timeOfDay: string | null
  snoozeUntil: string | null
  createdAt: string
}

export const listAllTasks = createServerFn({ method: 'GET' })
  .middleware([authMiddleware])
  .handler(async ({ context }): Promise<TaskSummary[]> => {
    const rows = await db
      .select({
        id: tasks.id,
        title: tasks.title,
        notes: tasks.notes,
        difficulty: tasks.difficulty,
        xpOverride: tasks.xpOverride,
        recurrence: tasks.recurrence,
        timeOfDay: tasks.timeOfDay,
        snoozeUntil: tasks.snoozeUntil,
        createdAt: tasks.createdAt,
      })
      .from(tasks)
      .where(and(eq(tasks.userId, context.userId), eq(tasks.active, true)))
      .orderBy(tasks.createdAt)

    return rows.map((r) => ({
      id: r.id,
      title: r.title,
      notes: r.notes,
      difficulty: r.difficulty as Difficulty,
      xpOverride: r.xpOverride,
      recurrence: r.recurrence,
      timeOfDay: r.timeOfDay,
      snoozeUntil: r.snoozeUntil?.toISOString() ?? null,
      createdAt: r.createdAt.toISOString(),
    }))
  })

interface TaskDetail {
  id: string
  title: string
  notes: string | null
  difficulty: Difficulty
  xpOverride: number | null
  recurrence: Recurrence | null
  timeOfDay: string | null
  snoozeUntil: string | null
  active: boolean
  createdAt: string
  updatedAt: string
}

export const getTask = createServerFn({ method: 'GET' })
  .middleware([authMiddleware])
  .inputValidator((data: { taskId: string }) => {
    if (!data.taskId) throw new Error('taskId required')
    return data
  })
  .handler(async ({ data, context }): Promise<TaskDetail> => {
    const row = await db.query.tasks.findFirst({
      where: and(
        eq(tasks.id, data.taskId),
        eq(tasks.userId, context.userId),
      ),
    })
    if (!row) throw new Error('task not found')
    return {
      id: row.id,
      title: row.title,
      notes: row.notes,
      difficulty: row.difficulty as Difficulty,
      xpOverride: row.xpOverride,
      recurrence: row.recurrence,
      timeOfDay: row.timeOfDay,
      snoozeUntil: row.snoozeUntil?.toISOString() ?? null,
      active: row.active,
      createdAt: row.createdAt.toISOString(),
      updatedAt: row.updatedAt.toISOString(),
    }
  })

export const updateTask = createServerFn({ method: 'POST' })
  .middleware([authMiddleware])
  .inputValidator((data: {
    taskId: string
    title: string
    notes: string | null
    difficulty: Difficulty
    recurrence: Recurrence | null
    timeOfDay: string | null
  }) => {
    if (!data.taskId) throw new Error('taskId required')
    if (!data.title?.trim()) throw new Error('title is required')
    if (!['small', 'medium', 'large'].includes(data.difficulty)) {
      throw new Error('invalid difficulty')
    }
    if (data.timeOfDay) assertValidTimeOfDay(data.timeOfDay)
    return data
  })
  .handler(async ({ data, context }) => {
    const result = await db
      .update(tasks)
      .set({
        title: data.title.trim(),
        notes: data.notes,
        difficulty: data.difficulty,
        recurrence: data.recurrence,
        timeOfDay: data.timeOfDay,
        updatedAt: new Date(),
      })
      .where(
        and(eq(tasks.id, data.taskId), eq(tasks.userId, context.userId)),
      )
      .returning({ id: tasks.id })
    if (result.length === 0) throw new Error('task not found')
    return { id: result[0].id }
  })

export const deleteTask = createServerFn({ method: 'POST' })
  .middleware([authMiddleware])
  .inputValidator((data: { taskId: string }) => {
    if (!data.taskId) throw new Error('taskId required')
    return data
  })
  .handler(async ({ data, context }) => {
    const result = await db
      .update(tasks)
      .set({ active: false, updatedAt: new Date() })
      .where(and(eq(tasks.id, data.taskId), eq(tasks.userId, context.userId)))
      .returning({ id: tasks.id })
    if (result.length === 0) throw new Error('task not found')
    return { id: result[0].id }
  })

export const snoozeTask = createServerFn({ method: 'POST' })
  .middleware([authMiddleware])
  .inputValidator((data: { taskId: string; until: string | null }) => {
    if (!data.taskId) throw new Error('taskId required')
    if (data.until !== null) {
      const parsed = new Date(data.until)
      if (Number.isNaN(parsed.getTime())) throw new Error('invalid until date')
    }
    return data
  })
  .handler(async ({ data, context }) => {
    const until = data.until ? new Date(data.until) : null
    const result = await db
      .update(tasks)
      .set({ snoozeUntil: until, updatedAt: new Date() })
      .where(and(eq(tasks.id, data.taskId), eq(tasks.userId, context.userId)))
      .returning({ id: tasks.id })
    if (result.length === 0) throw new Error('task not found')
    return { id: result[0].id, until: until?.toISOString() ?? null }
  })

interface ProgressionSummary {
  xp: number
  level: number
  currentStreak: number
  longestStreak: number
}

export const getProgression = createServerFn({ method: 'GET' })
  .middleware([authMiddleware])
  .handler(async ({ context }): Promise<ProgressionSummary> => {
    const row = await db.query.progression.findFirst({
      where: eq(progression.userId, context.userId),
    })
    if (!row) {
      return {
        xp: 0,
        level: 1,
        currentStreak: 0,
        longestStreak: 0,
      }
    }
    return {
      xp: row.xp,
      level: row.level,
      currentStreak: row.currentStreak,
      longestStreak: row.longestStreak,
    }
  })

export const listRecentActivity = createServerFn({ method: 'GET' })
  .middleware([authMiddleware])
  .handler(async ({ context }): Promise<string[]> => {
    const timeZone = await loadUserTimeZone(context.userId)
    const since = new Date(Date.now() - 8 * 24 * 3_600_000)
    const rows = await db
      .select({ occurredAt: events.occurredAt })
      .from(events)
      .where(
        and(
          eq(events.userId, context.userId),
          eq(events.type, 'task.completed'),
          isNotNull(events.occurredAt),
        ),
      )
      .orderBy(events.occurredAt)

    const dayKeys = new Set<string>()
    const formatter = new Intl.DateTimeFormat('en-CA', {
      timeZone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    })
    for (const row of rows) {
      if (!row.occurredAt || row.occurredAt < since) continue
      dayKeys.add(formatter.format(row.occurredAt))
    }
    return Array.from(dayKeys).sort()
  })
