// Task service layer.
//
// All business logic lives here as plain functions that take `userId` + input
// and return typed results. Both the Start server functions (browser-facing,
// cookie-auth) and the REST API handlers (machine-facing, token-auth) call
// into these same functions — no logic duplication, no drift between the
// cookie path and the token path.
//
// Validation lives here too (title non-empty, difficulty enum, timeOfDay
// format, etc.) so any caller gets the same guarantees.
import { and, eq, isNotNull, isNull, lt, or } from 'drizzle-orm'
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
import { scheduleReminder } from '../boss'
import { scoreTask } from '../llm/scoreTask'

// ---------------------------------------------------------------------------
// Shared types
// ---------------------------------------------------------------------------

export interface CreateTaskInput {
  title: string
  notes?: string | null
  difficulty: Difficulty
  recurrence: Recurrence | null
  timeOfDay: string | null
  someday: boolean
}

export interface UpdateTaskInput {
  taskId: string
  title: string
  notes: string | null
  difficulty: Difficulty
  recurrence: Recurrence | null
  timeOfDay: string | null
}

export interface CreateTaskResult {
  id: string
  scored: { xp: number; tier: string; reasoning: string } | null
}

export interface TodayInstance {
  instanceId: string
  taskId: string
  title: string
  difficulty: Difficulty
  xpOverride: number | null
  dueAt: string
  timeOfDay: string | null
  snoozedUntil: string | null
}

export interface SomedayInstance {
  instanceId: string
  taskId: string
  title: string
  difficulty: Difficulty
  xpOverride: number | null
}

export interface TaskSummary {
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

export interface TaskDetail extends TaskSummary {
  active: boolean
  updatedAt: string
}

export interface ProgressionSummary {
  xp: number
  level: number
  currentStreak: number
  longestStreak: number
}

export type CompleteInstanceResult =
  | { alreadyHandled: true }
  | {
      alreadyHandled: false
      xp: number
      level: number
      currentStreak: number
    }

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

export async function getUserTimeZone(userId: string): Promise<string> {
  const row = await db.query.user.findFirst({
    where: eq(userTable.id, userId),
    columns: { timezone: true },
  })
  return row?.timezone ?? 'UTC'
}

function validateCreate(input: CreateTaskInput) {
  if (!input.title?.trim()) throw new Error('title is required')
  if (!['small', 'medium', 'large'].includes(input.difficulty)) {
    throw new Error('invalid difficulty')
  }
  if (input.timeOfDay) assertValidTimeOfDay(input.timeOfDay)
  if (input.someday && input.recurrence) {
    throw new Error('someday tasks cannot be recurring')
  }
}

function validateUpdate(input: UpdateTaskInput) {
  if (!input.taskId) throw new Error('taskId required')
  if (!input.title?.trim()) throw new Error('title is required')
  if (!['small', 'medium', 'large'].includes(input.difficulty)) {
    throw new Error('invalid difficulty')
  }
  if (input.timeOfDay) assertValidTimeOfDay(input.timeOfDay)
}

// ---------------------------------------------------------------------------
// Create / read / update / delete tasks
// ---------------------------------------------------------------------------

export async function createTask(
  userId: string,
  input: CreateTaskInput,
): Promise<CreateTaskResult> {
  validateCreate(input)
  const now = new Date()
  const timeZone = await getUserTimeZone(userId)

  const dueAt = firstDueAt({
    now,
    recurrence: input.recurrence,
    timeOfDay: input.someday ? null : input.timeOfDay,
    timeZone,
    someday: input.someday,
  })

  const scored = await scoreTask({
    title: input.title.trim(),
    notes: input.notes,
    difficultyHint: input.difficulty,
  })

  const result = await db.transaction(async (tx) => {
    const [task] = await tx
      .insert(tasks)
      .values({
        userId,
        title: input.title.trim(),
        notes: input.notes ?? null,
        difficulty: input.difficulty,
        xpOverride: scored?.xp ?? null,
        recurrence: input.recurrence,
        timeOfDay: input.someday ? null : input.timeOfDay,
      })
      .returning()

    const [inst] = await tx
      .insert(taskInstances)
      .values({ taskId: task.id, userId, dueAt })
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
}

export async function listAllTasks(userId: string): Promise<TaskSummary[]> {
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
    .where(and(eq(tasks.userId, userId), eq(tasks.active, true)))
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
}

export async function getTask(
  userId: string,
  taskId: string,
): Promise<TaskDetail> {
  if (!taskId) throw new Error('taskId required')
  const row = await db.query.tasks.findFirst({
    where: and(eq(tasks.id, taskId), eq(tasks.userId, userId)),
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
}

export async function updateTask(
  userId: string,
  input: UpdateTaskInput,
): Promise<{ id: string }> {
  validateUpdate(input)
  const result = await db
    .update(tasks)
    .set({
      title: input.title.trim(),
      notes: input.notes,
      difficulty: input.difficulty,
      recurrence: input.recurrence,
      timeOfDay: input.timeOfDay,
      updatedAt: new Date(),
    })
    .where(and(eq(tasks.id, input.taskId), eq(tasks.userId, userId)))
    .returning({ id: tasks.id })
  if (result.length === 0) throw new Error('task not found')
  return { id: result[0].id }
}

export async function deleteTask(
  userId: string,
  taskId: string,
): Promise<{ id: string }> {
  if (!taskId) throw new Error('taskId required')
  const result = await db
    .update(tasks)
    .set({ active: false, updatedAt: new Date() })
    .where(and(eq(tasks.id, taskId), eq(tasks.userId, userId)))
    .returning({ id: tasks.id })
  if (result.length === 0) throw new Error('task not found')
  return { id: result[0].id }
}

export async function snoozeTask(
  userId: string,
  taskId: string,
  until: string | null,
): Promise<{ id: string; until: string | null }> {
  if (!taskId) throw new Error('taskId required')
  if (until !== null) {
    const parsed = new Date(until)
    if (Number.isNaN(parsed.getTime())) throw new Error('invalid until date')
  }
  const untilDate = until ? new Date(until) : null
  const result = await db
    .update(tasks)
    .set({ snoozeUntil: untilDate, updatedAt: new Date() })
    .where(and(eq(tasks.id, taskId), eq(tasks.userId, userId)))
    .returning({ id: tasks.id })
  if (result.length === 0) throw new Error('task not found')
  return { id: result[0].id, until: untilDate?.toISOString() ?? null }
}

// ---------------------------------------------------------------------------
// Instances
// ---------------------------------------------------------------------------

export async function listTodayInstances(
  userId: string,
): Promise<TodayInstance[]> {
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
        eq(taskInstances.userId, userId),
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
}

export async function listSomedayInstances(
  userId: string,
): Promise<SomedayInstance[]> {
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
        eq(taskInstances.userId, userId),
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
}

export async function completeInstance(
  userId: string,
  instanceId: string,
): Promise<CompleteInstanceResult> {
  if (!instanceId) throw new Error('instanceId required')
  const now = new Date()
  const timeZone = await getUserTimeZone(userId)

  const txResult = await db.transaction(async (tx) => {
    const instance = await tx.query.taskInstances.findFirst({
      where: and(
        eq(taskInstances.id, instanceId),
        eq(taskInstances.userId, userId),
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
      userId,
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
      where: eq(progression.userId, userId),
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
        userId,
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
        .values({ taskId: task.id, userId, dueAt: nextDue })
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
  })

  if (txResult.alreadyHandled) return { alreadyHandled: true }

  if (txResult.materialized && txResult.materialized.dueAt > new Date()) {
    await scheduleReminder(
      { taskInstanceId: txResult.materialized.instanceId, kind: 'due' },
      txResult.materialized.dueAt,
    ).catch((e) => console.error('scheduleReminder failed', e))
  }

  return {
    alreadyHandled: false,
    xp: txResult.xp,
    level: txResult.level,
    currentStreak: txResult.currentStreak,
  }
}

export async function skipInstance(
  userId: string,
  instanceId: string,
): Promise<{ alreadyHandled: boolean }> {
  if (!instanceId) throw new Error('instanceId required')
  const now = new Date()
  const timeZone = await getUserTimeZone(userId)

  const txResult = await db.transaction(async (tx) => {
    const instance = await tx.query.taskInstances.findFirst({
      where: and(
        eq(taskInstances.id, instanceId),
        eq(taskInstances.userId, userId),
      ),
    })
    if (!instance) throw new Error('instance not found')
    const defaultMaterialized: { instanceId: string; dueAt: Date } | null = null
    if (instance.completedAt || instance.skippedAt) {
      return { alreadyHandled: true, materialized: defaultMaterialized }
    }

    const task = await tx.query.tasks.findFirst({
      where: eq(tasks.id, instance.taskId),
    })
    if (!task) throw new Error('task missing')

    await tx
      .update(taskInstances)
      .set({ skippedAt: now })
      .where(eq(taskInstances.id, instance.id))

    await tx.insert(events).values({
      userId,
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
        .values({ taskId: task.id, userId, dueAt: nextDue })
        .returning()
      materialized = { instanceId: inst.id, dueAt: nextDue }
    }

    return { alreadyHandled: false, materialized }
  })

  if (txResult.materialized && txResult.materialized.dueAt > new Date()) {
    await scheduleReminder(
      { taskInstanceId: txResult.materialized.instanceId, kind: 'due' },
      txResult.materialized.dueAt,
    ).catch((e) => console.error('scheduleReminder failed', e))
  }

  return { alreadyHandled: txResult.alreadyHandled }
}

export async function snoozeInstance(
  userId: string,
  instanceId: string,
  hours: number,
): Promise<{ snoozedUntil: string }> {
  if (!instanceId) throw new Error('instanceId required')
  if (!Number.isFinite(hours) || hours <= 0) {
    throw new Error('hours must be positive')
  }
  const until = new Date(Date.now() + hours * 3_600_000)
  const result = await db
    .update(taskInstances)
    .set({ snoozedUntil: until })
    .where(
      and(eq(taskInstances.id, instanceId), eq(taskInstances.userId, userId)),
    )
    .returning({ id: taskInstances.id })
  if (result.length === 0) throw new Error('instance not found')
  return { snoozedUntil: until.toISOString() }
}

// ---------------------------------------------------------------------------
// Progression & activity
// ---------------------------------------------------------------------------

export async function getProgression(
  userId: string,
): Promise<ProgressionSummary> {
  const row = await db.query.progression.findFirst({
    where: eq(progression.userId, userId),
  })
  if (!row) {
    return { xp: 0, level: 1, currentStreak: 0, longestStreak: 0 }
  }
  return {
    xp: row.xp,
    level: row.level,
    currentStreak: row.currentStreak,
    longestStreak: row.longestStreak,
  }
}

export async function listRecentActivity(userId: string): Promise<string[]> {
  const timeZone = await getUserTimeZone(userId)
  const since = new Date(Date.now() - 8 * 24 * 3_600_000)
  const rows = await db
    .select({ occurredAt: events.occurredAt })
    .from(events)
    .where(
      and(
        eq(events.userId, userId),
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
}
