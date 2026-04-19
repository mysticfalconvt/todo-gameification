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
import { and, eq, gte, inArray, isNotNull, isNull, lt, or } from 'drizzle-orm'
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
import { categorizeTask } from '../llm/categorizeTask'
import { listCategories } from './categories'

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
  categorization: { slug: string; reasoning: string } | null
}

export interface TodayInstance {
  instanceId: string
  taskId: string
  title: string
  difficulty: Difficulty
  xpOverride: number | null
  categorySlug: string | null
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
  categorySlug: string | null
}

export interface TaskSummary {
  id: string
  title: string
  notes: string | null
  difficulty: Difficulty
  xpOverride: number | null
  recurrence: Recurrence | null
  timeOfDay: string | null
  categorySlug: string | null
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

  const categories = await listCategories(userId)

  // Two separate LLM calls in parallel — score and categorize independently.
  // Keeping them split keeps each schema tight and reduces the chance of
  // malformed structured output.
  const [scored, categorization] = await Promise.all([
    scoreTask({
      title: input.title.trim(),
      notes: input.notes,
      difficultyHint: input.difficulty,
    }),
    categorizeTask({
      title: input.title.trim(),
      notes: input.notes,
      categories: categories.map((c) => ({ slug: c.slug, label: c.label })),
    }),
  ])

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
        categorySlug: categorization?.slug ?? null,
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
      { taskInstanceId: result.instanceId, attempt: 1 },
      result.dueAt,
    ).catch((e) => console.error('scheduleReminder failed', e))
  }

  return {
    id: result.id,
    scored: scored
      ? { xp: scored.xp, tier: scored.tier, reasoning: scored.reasoning }
      : null,
    categorization: categorization
      ? { slug: categorization.slug, reasoning: categorization.reasoning }
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
      categorySlug: tasks.categorySlug,
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
    categorySlug: r.categorySlug,
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
    categorySlug: row.categorySlug,
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

export async function countUncategorizedTasks(
  userId: string,
): Promise<number> {
  const rows = await db
    .select({ id: tasks.id })
    .from(tasks)
    .where(
      and(
        eq(tasks.userId, userId),
        eq(tasks.active, true),
        isNull(tasks.categorySlug),
      ),
    )
  return rows.length
}

export interface BackfillResult {
  attempted: number
  assigned: number
  skipped: number
}

export async function backfillCategories(
  userId: string,
): Promise<BackfillResult> {
  const categories = await listCategories(userId)
  if (categories.length === 0) {
    return { attempted: 0, assigned: 0, skipped: 0 }
  }
  const categoryList = categories.map((c) => ({
    slug: c.slug,
    label: c.label,
  }))

  const pending = await db
    .select({
      id: tasks.id,
      title: tasks.title,
      notes: tasks.notes,
    })
    .from(tasks)
    .where(
      and(
        eq(tasks.userId, userId),
        eq(tasks.active, true),
        isNull(tasks.categorySlug),
      ),
    )

  let assigned = 0
  let skipped = 0

  // One task at a time — the LM Studio instance is a single-tenant box, so
  // parallel calls would starve everything else hitting it. A single backfill
  // of 20 tasks takes ~30–60s; that's fine as a one-shot.
  for (const t of pending) {
    try {
      const categorization = await categorizeTask({
        title: t.title,
        notes: t.notes,
        categories: categoryList,
      })
      if (!categorization) {
        skipped += 1
        continue
      }
      await db
        .update(tasks)
        .set({ categorySlug: categorization.slug, updatedAt: new Date() })
        .where(and(eq(tasks.id, t.id), eq(tasks.userId, userId)))
      assigned += 1
    } catch (err) {
      console.error('backfill failed for task', t.id, err)
      skipped += 1
    }
  }

  return { attempted: pending.length, assigned, skipped }
}

export async function reanalyzeTask(
  userId: string,
  taskId: string,
): Promise<{
  id: string
  xpOverride: number | null
  categorySlug: string | null
  scored: { xp: number; tier: string; reasoning: string } | null
  categorization: { slug: string; reasoning: string } | null
}> {
  if (!taskId) throw new Error('taskId required')
  const row = await db.query.tasks.findFirst({
    where: and(eq(tasks.id, taskId), eq(tasks.userId, userId)),
  })
  if (!row) throw new Error('task not found')

  const categories = await listCategories(userId)

  // Two separate LLM calls, run in parallel.
  const [scored, categorization] = await Promise.all([
    scoreTask({
      title: row.title,
      notes: row.notes,
      difficultyHint: row.difficulty as Difficulty,
    }),
    categorizeTask({
      title: row.title,
      notes: row.notes,
      categories: categories.map((c) => ({ slug: c.slug, label: c.label })),
    }),
  ])

  const setValues: Record<string, unknown> = { updatedAt: new Date() }
  if (scored) setValues.xpOverride = scored.xp
  if (categorization) setValues.categorySlug = categorization.slug

  if (Object.keys(setValues).length > 1) {
    await db
      .update(tasks)
      .set(setValues)
      .where(and(eq(tasks.id, taskId), eq(tasks.userId, userId)))
  }

  return {
    id: row.id,
    xpOverride: scored?.xp ?? row.xpOverride,
    categorySlug: categorization?.slug ?? row.categorySlug,
    scored: scored
      ? { xp: scored.xp, tier: scored.tier, reasoning: scored.reasoning }
      : null,
    categorization: categorization
      ? { slug: categorization.slug, reasoning: categorization.reasoning }
      : null,
  }
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
      categorySlug: tasks.categorySlug,
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
    categorySlug: r.categorySlug,
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
      categorySlug: tasks.categorySlug,
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
    categorySlug: r.categorySlug,
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
      { taskInstanceId: txResult.materialized.instanceId, attempt: 1 },
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
      { taskInstanceId: txResult.materialized.instanceId, attempt: 1 },
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

export interface HistoryEntry {
  instanceId: string
  taskId: string | null
  title: string
  xp: number
  completedAt: string
}

export interface HistoryDay {
  date: string // YYYY-MM-DD in user tz
  totalXp: number
  items: HistoryEntry[]
}

export async function listCompletionHistory(
  userId: string,
  days = 30,
): Promise<HistoryDay[]> {
  const timeZone = await getUserTimeZone(userId)
  const since = new Date(Date.now() - days * 24 * 3_600_000)

  const rows = await db
    .select({
      payload: events.payload,
      occurredAt: events.occurredAt,
    })
    .from(events)
    .where(
      and(
        eq(events.userId, userId),
        eq(events.type, 'task.completed'),
        isNotNull(events.occurredAt),
      ),
    )
    .orderBy(events.occurredAt)

  type Row = (typeof rows)[number]

  const recent = rows.filter((r) => r.occurredAt && r.occurredAt >= since)

  const taskIds = Array.from(
    new Set(
      recent
        .map((r) => {
          const p =
            r.payload && typeof r.payload === 'object'
              ? (r.payload as Record<string, unknown>)
              : {}
          return typeof p['taskId'] === 'string' ? (p['taskId'] as string) : null
        })
        .filter((v): v is string => Boolean(v)),
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

  const formatter = new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  })

  const byDay = new Map<string, HistoryDay>()
  // Reverse: newest first
  for (const r of [...recent].reverse()) {
    if (!r.occurredAt) continue
    const day = formatter.format(r.occurredAt)
    const p =
      r.payload && typeof r.payload === 'object'
        ? (r.payload as Record<string, unknown>)
        : {}
    const taskId =
      typeof p['taskId'] === 'string' ? (p['taskId'] as string) : null
    const instanceId =
      typeof p['instanceId'] === 'string' ? (p['instanceId'] as string) : ''
    const xpOverride =
      typeof p['xpOverride'] === 'number' ? (p['xpOverride'] as number) : null
    const difficulty = typeof p['difficulty'] === 'string' ? p['difficulty'] : null
    const base =
      xpOverride ??
      (difficulty === 'small' ? 10 : difficulty === 'large' ? 60 : 25)
    const entry: HistoryEntry = {
      instanceId,
      taskId,
      title: taskId ? titleMap.get(taskId) ?? '(deleted)' : '(unknown)',
      xp: base,
      completedAt: r.occurredAt.toISOString(),
    }
    const existing = byDay.get(day)
    if (existing) {
      existing.items.push(entry)
      existing.totalXp += entry.xp
    } else {
      byDay.set(day, { date: day, totalXp: entry.xp, items: [entry] })
    }
  }

  // Newest date first
  return Array.from(byDay.values()).sort((a, b) =>
    a.date < b.date ? 1 : a.date > b.date ? -1 : 0,
  )

  // Silence unused-local warning on Row (helps future typing).
  void ({} as Row)
}

export interface CategoryCount {
  slug: string | null
  count: number
}

/**
 * Per-category counts for the /tasks histogram. "active" counts currently
 * active tasks; "completed" counts task.completed events in the last 30 days,
 * resolved to the owning task's CURRENT category (so if a task was
 * re-categorized recently its historical completions follow the new slug).
 */
export async function categoryCounts(
  userId: string,
  scope: 'active' | 'completed',
): Promise<CategoryCount[]> {
  const counts = new Map<string | null, number>()
  const bump = (slug: string | null) =>
    counts.set(slug, (counts.get(slug) ?? 0) + 1)

  if (scope === 'active') {
    const rows = await db
      .select({ categorySlug: tasks.categorySlug })
      .from(tasks)
      .where(and(eq(tasks.userId, userId), eq(tasks.active, true)))
    for (const r of rows) bump(r.categorySlug)
  } else {
    const since = new Date(Date.now() - 30 * 24 * 3_600_000)
    const completions = await db
      .select({ payload: events.payload })
      .from(events)
      .where(
        and(
          eq(events.userId, userId),
          eq(events.type, 'task.completed'),
          isNotNull(events.occurredAt),
          gte(events.occurredAt, since),
        ),
      )
    const taskIds = Array.from(
      new Set(
        completions
          .map((e) => {
            const p =
              e.payload && typeof e.payload === 'object'
                ? (e.payload as Record<string, unknown>)
                : {}
            return typeof p['taskId'] === 'string'
              ? (p['taskId'] as string)
              : null
          })
          .filter((v): v is string => Boolean(v)),
      ),
    )
    const catByTask = new Map<string, string | null>()
    if (taskIds.length > 0) {
      const titled = await db
        .select({ id: tasks.id, categorySlug: tasks.categorySlug })
        .from(tasks)
        .where(inArray(tasks.id, taskIds))
      for (const t of titled) catByTask.set(t.id, t.categorySlug)
    }
    for (const e of completions) {
      const p =
        e.payload && typeof e.payload === 'object'
          ? (e.payload as Record<string, unknown>)
          : {}
      const tid = typeof p['taskId'] === 'string' ? (p['taskId'] as string) : null
      if (!tid) continue
      if (!catByTask.has(tid)) continue
      bump(catByTask.get(tid) ?? null)
    }
  }

  return Array.from(counts.entries()).map(([slug, count]) => ({ slug, count }))
}

export interface Stats {
  days: number
  xpByDay: Array<{ date: string; xp: number; count: number }>
  weekday: number[] // 0=Sun..6=Sat
  hour: number[] // 0..23
  topTasks: Array<{ taskId: string | null; title: string; count: number }>
}

const MAX_ALL_TIME_DAYS = 365 * 10 // safety cap on the filled series

export async function getStats(
  userId: string,
  days: number | 'all',
): Promise<Stats> {
  const timeZone = await getUserTimeZone(userId)
  const allTime = days === 'all'
  const since = allTime
    ? new Date(0)
    : new Date(Date.now() - (days as number) * 24 * 3_600_000)

  const rows = await db
    .select({
      payload: events.payload,
      occurredAt: events.occurredAt,
    })
    .from(events)
    .where(
      and(
        eq(events.userId, userId),
        eq(events.type, 'task.completed'),
        isNotNull(events.occurredAt),
        gte(events.occurredAt, since),
      ),
    )

  const dayFmt = new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  })
  const weekdayFmt = new Intl.DateTimeFormat('en-US', {
    timeZone,
    weekday: 'short',
  })
  const hourFmt = new Intl.DateTimeFormat('en-US', {
    timeZone,
    hour: 'numeric',
    hour12: false,
  })

  const weekdayIndex: Record<string, number> = {
    Sun: 0,
    Mon: 1,
    Tue: 2,
    Wed: 3,
    Thu: 4,
    Fri: 5,
    Sat: 6,
  }

  const xpByDay = new Map<string, { xp: number; count: number }>()
  const weekday = [0, 0, 0, 0, 0, 0, 0]
  const hour = new Array<number>(24).fill(0)
  const taskCounts = new Map<string, number>()

  for (const r of rows) {
    if (!r.occurredAt) continue
    const p =
      r.payload && typeof r.payload === 'object'
        ? (r.payload as Record<string, unknown>)
        : {}
    const xpOverride =
      typeof p['xpOverride'] === 'number' ? (p['xpOverride'] as number) : null
    const difficulty = typeof p['difficulty'] === 'string' ? p['difficulty'] : null
    const xp =
      xpOverride ??
      (difficulty === 'small' ? 10 : difficulty === 'large' ? 60 : 25)

    const dayKey = dayFmt.format(r.occurredAt)
    const bucket = xpByDay.get(dayKey) ?? { xp: 0, count: 0 }
    bucket.xp += xp
    bucket.count += 1
    xpByDay.set(dayKey, bucket)

    const wd = weekdayIndex[weekdayFmt.format(r.occurredAt)] ?? 0
    weekday[wd] += 1

    const hourStr = hourFmt.format(r.occurredAt)
    const hourNum = Number.parseInt(hourStr, 10)
    if (Number.isFinite(hourNum) && hourNum >= 0 && hourNum < 24) {
      hour[hourNum] += 1
    }

    const taskId = typeof p['taskId'] === 'string' ? (p['taskId'] as string) : null
    if (taskId) {
      taskCounts.set(taskId, (taskCounts.get(taskId) ?? 0) + 1)
    }
  }

  // Fill every day in the window so the line chart doesn't have gaps.
  // For "all time" we start from the earliest event so we don't fill years of
  // empty days for a user who signed up last week.
  let fillDays: number
  if (allTime) {
    let earliest = Date.now()
    for (const r of rows) {
      if (r.occurredAt && r.occurredAt.getTime() < earliest) {
        earliest = r.occurredAt.getTime()
      }
    }
    const spanMs = Math.max(0, Date.now() - earliest)
    fillDays = Math.min(
      MAX_ALL_TIME_DAYS,
      Math.max(1, Math.ceil(spanMs / 86_400_000) + 1),
    )
  } else {
    fillDays = days as number
  }

  const xpSeries: Array<{ date: string; xp: number; count: number }> = []
  for (let i = fillDays - 1; i >= 0; i--) {
    const d = new Date(Date.now() - i * 24 * 3_600_000)
    const key = dayFmt.format(d)
    const bucket = xpByDay.get(key) ?? { xp: 0, count: 0 }
    xpSeries.push({ date: key, xp: bucket.xp, count: bucket.count })
  }

  // Top tasks by count.
  const topIds = Array.from(taskCounts.entries())
    .sort((a, b) => b[1] - a[1])
    .slice(0, 5)
  const topTitles = new Map<string, string>()
  if (topIds.length > 0) {
    const idRows = await db
      .select({ id: tasks.id, title: tasks.title })
      .from(tasks)
      .where(inArray(tasks.id, topIds.map(([id]) => id)))
    for (const r of idRows) topTitles.set(r.id, r.title)
  }
  const topTasks = topIds.map(([taskId, count]) => ({
    taskId,
    title: topTitles.get(taskId) ?? '(deleted task)',
    count,
  }))

  return {
    days: allTime ? fillDays : (days as number),
    xpByDay: xpSeries,
    weekday,
    hour,
    topTasks,
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
