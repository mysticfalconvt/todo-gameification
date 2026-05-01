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
import {
  and,
  desc,
  eq,
  gt,
  gte,
  inArray,
  isNotNull,
  isNull,
  lt,
  or,
  sql,
} from 'drizzle-orm'
import { formatInTimeZone, fromZonedTime } from 'date-fns-tz'
import { db } from '../db/client'
import {
  events,
  progression,
  taskInstances,
  taskStepCompletions,
  taskSteps,
  tasks,
  user as userTable,
} from '../db/schema'
import type { Recurrence } from '../../domain/recurrence'
import { computeNextDue, firstDueAt } from '../../domain/recurrence'
import { assertValidTimeOfDay, setTimeInTz } from '../../domain/time'
import type { Difficulty, DomainEvent } from '../../domain/events'
import {
  INITIAL_PROGRESSION,
  applyEvent,
  baseXpForDifficulty,
  computeStepXp,
  parentBonusBaseXp,
  punctualityMultiplier,
} from '../../domain/gamification'
import { scheduleReminder } from '../boss'
import { scoreTask } from '../llm/scoreTask'
import { categorizeTask } from '../llm/categorizeTask'
import { listCategories } from './categories'

// ---------------------------------------------------------------------------
// Shared types
// ---------------------------------------------------------------------------

export type TaskVisibility = 'private' | 'friends' | 'public'
export const TASK_VISIBILITY_VALUES: readonly TaskVisibility[] = [
  'private',
  'friends',
  'public',
] as const

export interface CreateTaskInput {
  title: string
  notes?: string | null
  difficulty: Difficulty
  recurrence: Recurrence | null
  timeOfDay: string | null
  someday: boolean
  visibility?: TaskVisibility
  // Absolute due instant set by the client. When present, overrides
  // the default firstDueAt(now, recurrence, timeOfDay) computation.
  // Used by the "In N hours/minutes" picker so the first instance can
  // land at any moment (not just a same-day HH:MM), while still
  // letting `recurrence` drive later occurrences.
  dueAtOverride?: string | null
  // Optional checklist steps to seed the task with. Empty/whitespace
  // titles are dropped. Each grants a slice of the parent's XP at
  // completion time (see computeStepXp).
  steps?: string[] | null
}

export interface UpdateTaskInput {
  taskId: string
  title: string
  notes: string | null
  difficulty: Difficulty
  recurrence: Recurrence | null
  timeOfDay: string | null
  visibility?: TaskVisibility
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
  createdAt: string
  stepsTotal: number
  stepsCompleted: number
}

export interface SomedayInstance {
  instanceId: string
  taskId: string
  title: string
  difficulty: Difficulty
  xpOverride: number | null
  categorySlug: string | null
  createdAt: string
  stepsTotal: number
  stepsCompleted: number
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
  visibility: TaskVisibility
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
  tokens: number
}

export type CompleteInstanceResult =
  | { alreadyHandled: true }
  | { requiresConfirm: true; uncheckedSteps: number }
  | {
      alreadyHandled: false
      requiresConfirm?: false
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

// Pulls the user's recent AI-scored tasks as calibration examples for the
// score LLM. Dedupes by lowercased title so the model sees variety, not
// the same chore repeated. `excludeTaskId` is used when re-analyzing an
// existing task — we don't want its own prior score leaking into its new
// prompt.
async function loadRecentScoredExamples(
  userId: string,
  opts: { excludeTaskId?: string; limit?: number } = {},
): Promise<Array<{ title: string; xp: number }>> {
  const limit = Math.min(opts.limit ?? 15, 40)
  const rows = await db
    .select({
      id: tasks.id,
      title: tasks.title,
      xpOverride: tasks.xpOverride,
      updatedAt: tasks.updatedAt,
    })
    .from(tasks)
    .where(and(eq(tasks.userId, userId), isNotNull(tasks.xpOverride)))
    .orderBy(desc(tasks.updatedAt))
    .limit(80)

  const out: Array<{ title: string; xp: number }> = []
  const seen = new Set<string>()
  for (const r of rows) {
    if (opts.excludeTaskId && r.id === opts.excludeTaskId) continue
    if (r.xpOverride == null) continue
    const key = r.title.trim().toLowerCase()
    if (seen.has(key)) continue
    seen.add(key)
    out.push({ title: r.title, xp: r.xpOverride })
    if (out.length >= limit) break
  }
  return out
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
  if (
    input.visibility !== undefined &&
    !TASK_VISIBILITY_VALUES.includes(input.visibility)
  ) {
    throw new Error('invalid visibility')
  }
}

function validateUpdate(input: UpdateTaskInput) {
  if (!input.taskId) throw new Error('taskId required')
  if (!input.title?.trim()) throw new Error('title is required')
  if (!['small', 'medium', 'large'].includes(input.difficulty)) {
    throw new Error('invalid difficulty')
  }
  if (input.timeOfDay) assertValidTimeOfDay(input.timeOfDay)
  if (
    input.visibility !== undefined &&
    !TASK_VISIBILITY_VALUES.includes(input.visibility)
  ) {
    throw new Error('invalid visibility')
  }
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

  const dueAt = input.dueAtOverride
    ? new Date(input.dueAtOverride)
    : firstDueAt({
        now,
        recurrence: input.recurrence,
        timeOfDay: input.someday ? null : input.timeOfDay,
        timeZone,
        someday: input.someday,
      })

  const [categories, recentScores] = await Promise.all([
    listCategories(userId),
    loadRecentScoredExamples(userId),
  ])

  // Two separate LLM calls in parallel — score and categorize independently.
  // Keeping them split keeps each schema tight and reduces the chance of
  // malformed structured output.
  const [scored, categorization] = await Promise.all([
    scoreTask({
      title: input.title.trim(),
      notes: input.notes,
      difficultyHint: input.difficulty,
      recentScores,
      userId,
    }),
    categorizeTask({
      title: input.title.trim(),
      notes: input.notes,
      categories: categories.map((c) => ({
        slug: c.slug,
        label: c.label,
        description: c.description,
      })),
      userId,
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
        visibility: input.visibility ?? 'friends',
      })
      .returning()

    const [inst] = await tx
      .insert(taskInstances)
      .values({ taskId: task.id, userId, dueAt })
      .returning()

    const cleanedSteps = (input.steps ?? [])
      .map((s) => s.trim())
      .filter((s) => s.length > 0)
    if (cleanedSteps.length > 0) {
      await tx.insert(taskSteps).values(
        cleanedSteps.map((title, position) => ({
          taskId: task.id,
          userId,
          title,
          position,
        })),
      )
    }

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
      visibility: tasks.visibility,
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
    visibility: r.visibility as TaskVisibility,
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
    visibility: row.visibility as TaskVisibility,
  }
}

export async function updateTask(
  userId: string,
  input: UpdateTaskInput,
): Promise<{ id: string }> {
  validateUpdate(input)
  const setValues: Record<string, unknown> = {
    title: input.title.trim(),
    notes: input.notes,
    difficulty: input.difficulty,
    recurrence: input.recurrence,
    timeOfDay: input.timeOfDay,
    updatedAt: new Date(),
  }
  if (input.visibility !== undefined) {
    setValues.visibility = input.visibility
  }
  const result = await db
    .update(tasks)
    .set(setValues)
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

// Narrow patch for the bulk-select UI. Avoids round-tripping a full
// task's title/difficulty/recurrence payload just to flip its category.
// slug=null clears the category (→ uncategorized).
export async function setTaskCategory(
  userId: string,
  taskId: string,
  slug: string | null,
): Promise<{ id: string }> {
  if (!taskId) throw new Error('taskId required')
  const result = await db
    .update(tasks)
    .set({ categorySlug: slug, updatedAt: new Date() })
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
    description: c.description,
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
        userId,
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

  const [categories, recentScores] = await Promise.all([
    listCategories(userId),
    loadRecentScoredExamples(userId, { excludeTaskId: taskId }),
  ])

  // Two separate LLM calls, run in parallel.
  const [scored, categorization] = await Promise.all([
    scoreTask({
      title: row.title,
      notes: row.notes,
      difficultyHint: row.difficulty as Difficulty,
      recentScores,
      userId,
    }),
    categorizeTask({
      title: row.title,
      notes: row.notes,
      categories: categories.map((c) => ({
        slug: c.slug,
        label: c.label,
        description: c.description,
      })),
      userId,
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

// One-shot heal for tasks whose pending instance got pushed a day ahead
// by the old 36-hour-horizon bug: a user checked off tomorrow's instance
// yesterday, computeNextDue then scheduled the day-after-tomorrow's,
// and the user's "today" list is now empty even though the habit is due.
//
// Only shifts instances where the most recent completion's local-day is
// exactly one day before that instance's dueAt local-day. That's the
// narrow signature of the bug; legit "complete tonight for tomorrow 6am"
// is also matched but happens rarely — and if we shift a tomorrow task
// back to today, the user will just re-complete it.
async function repairDriftedRecurring(
  userId: string,
  timeZone: string,
  endOfTodayLocal: Date,
): Promise<void> {
  const rows = await db
    .select({
      instanceId: taskInstances.id,
      taskId: tasks.id,
      instanceDueAt: taskInstances.dueAt,
      timeOfDay: tasks.timeOfDay,
      recurrence: tasks.recurrence,
    })
    .from(taskInstances)
    .innerJoin(tasks, eq(tasks.id, taskInstances.taskId))
    .where(
      and(
        eq(taskInstances.userId, userId),
        isNull(taskInstances.completedAt),
        isNull(taskInstances.skippedAt),
        isNotNull(taskInstances.dueAt),
        gte(taskInstances.dueAt, endOfTodayLocal),
        eq(tasks.active, true),
        isNotNull(tasks.timeOfDay),
      ),
    )

  for (const row of rows) {
    if (!row.recurrence || !row.timeOfDay || !row.instanceDueAt) continue
    // Cap shift distance — don't touch instances scheduled more than a
    // week out; those are almost certainly intentional.
    const daysAhead =
      (row.instanceDueAt.getTime() - endOfTodayLocal.getTime()) /
      86_400_000
    if (daysAhead > 7) continue

    const latestCompleted = await db.query.taskInstances.findFirst({
      where: and(
        eq(taskInstances.taskId, row.taskId),
        isNotNull(taskInstances.completedAt),
      ),
      orderBy: (t, { desc: d }) => [d(t.completedAt)],
    })
    if (!latestCompleted?.completedAt || !latestCompleted.dueAt) continue

    const completedLocalDay = new Intl.DateTimeFormat('en-CA', {
      timeZone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    }).format(latestCompleted.completedAt)
    const dueLocalDay = new Intl.DateTimeFormat('en-CA', {
      timeZone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    }).format(latestCompleted.dueAt)
    if (completedLocalDay >= dueLocalDay) continue // completed on/after due day — normal

    // Drift confirmed. Shift the pending instance to today at its
    // task's timeOfDay in the user's tz.
    const newDueAt = setTimeInTz(new Date(), row.timeOfDay, timeZone)
    await db
      .update(taskInstances)
      .set({ dueAt: newDueAt })
      .where(eq(taskInstances.id, row.instanceId))
    console.info(
      `[repair] shifted instance ${row.instanceId} from ${row.instanceDueAt.toISOString()} → ${newDueAt.toISOString()}`,
    )
  }
}

export async function listTodayInstances(
  userId: string,
): Promise<TodayInstance[]> {
  const now = new Date()
  const timeZone = await getUserTimeZone(userId)
  // Horizon is the end of the user's local day (i.e., tomorrow's
  // local midnight). This means:
  // - A daily task you complete at 6pm doesn't re-appear in "today"
  //   the moment its next instance (tomorrow 6pm) is materialized.
  // - A task due tomorrow morning doesn't show up in tonight's list.
  // Overdue instances (dueAt in the past) still pass because the
  // filter is strictly "dueAt < horizon".
  const todayLocal = formatInTimeZone(now, timeZone, 'yyyy-MM-dd')
  const [y, m, d] = todayLocal.split('-').map(Number)
  const tomorrowStr = `${new Date(Date.UTC(y, m - 1, d + 1))
    .toISOString()
    .slice(0, 10)} 00:00:00`
  const horizon = fromZonedTime(tomorrowStr, timeZone)

  // Self-heal any tasks that drifted a day ahead from the old 36h
  // horizon bug. Best-effort — if it errors we still render today.
  try {
    await repairDriftedRecurring(userId, timeZone, horizon)
  } catch (err) {
    console.error('[repairDriftedRecurring] failed:', err)
  }

  const rows = await db
    .select({
      instanceId: taskInstances.id,
      taskId: tasks.id,
      title: tasks.title,
      difficulty: tasks.difficulty,
      xpOverride: tasks.xpOverride,
      instanceXpOverride: taskInstances.xpOverride,
      categorySlug: tasks.categorySlug,
      timeOfDay: tasks.timeOfDay,
      dueAt: taskInstances.dueAt,
      snoozedUntil: taskInstances.snoozedUntil,
      createdAt: tasks.createdAt,
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

  const stepCounts = await loadStepCounts(
    rows.map((r) => ({ taskId: r.taskId, instanceId: r.instanceId })),
  )

  return rows.map((r) => ({
    instanceId: r.instanceId,
    taskId: r.taskId,
    title: r.title,
    difficulty: r.difficulty as Difficulty,
    xpOverride: r.instanceXpOverride ?? r.xpOverride,
    categorySlug: r.categorySlug,
    dueAt: r.dueAt!.toISOString(),
    timeOfDay: r.timeOfDay,
    snoozedUntil: r.snoozedUntil?.toISOString() ?? null,
    createdAt: r.createdAt.toISOString(),
    stepsTotal: stepCounts.get(r.taskId)?.total ?? 0,
    stepsCompleted: stepCounts.get(r.taskId)?.completedByInstance.get(r.instanceId) ?? 0,
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

  const stepCounts = await loadStepCounts(
    rows.map((r) => ({ taskId: r.taskId, instanceId: r.instanceId })),
  )

  return rows.map((r) => ({
    instanceId: r.instanceId,
    taskId: r.taskId,
    title: r.title,
    difficulty: r.difficulty as Difficulty,
    xpOverride: r.xpOverride,
    categorySlug: r.categorySlug,
    createdAt: r.createdAt.toISOString(),
    stepsTotal: stepCounts.get(r.taskId)?.total ?? 0,
    stepsCompleted: stepCounts.get(r.taskId)?.completedByInstance.get(r.instanceId) ?? 0,
  }))
}

// Manual recovery for a wrong checkoff. Finds the most recently
// completed instance for this task, un-completes it, deletes the
// matching task.completed event from the log, and rebuilds progression
// by replaying the surviving events from scratch. Full replay is the
// only way to stay consistent with streak calculations without drifting
// slowly over many undo/redo cycles.
export async function reopenLastCompletion(
  userId: string,
  taskId: string,
): Promise<{ instanceId: string }> {
  if (!taskId) throw new Error('taskId required')
  const timeZone = await getUserTimeZone(userId)

  return db.transaction(async (tx) => {
    // Ownership gate.
    const task = await tx.query.tasks.findFirst({
      where: and(eq(tasks.id, taskId), eq(tasks.userId, userId)),
      columns: { id: true },
    })
    if (!task) throw new Error('task not found')

    const latest = await tx.query.taskInstances.findFirst({
      where: and(
        eq(taskInstances.taskId, taskId),
        eq(taskInstances.userId, userId),
        isNotNull(taskInstances.completedAt),
      ),
      orderBy: (t, { desc: d }) => [d(t.completedAt)],
    })
    if (!latest) throw new Error('no completed instance to reopen')

    // Drop the corresponding task.completed event so the event log
    // stays the source of truth for progression. We match on
    // payload.instanceId which is unique per completion.
    await tx
      .delete(events)
      .where(
        and(
          eq(events.userId, userId),
          eq(events.type, 'task.completed'),
          sql`${events.payload}->>'instanceId' = ${latest.id}`,
        ),
      )
    // Also revoke any cheer events that landed on this completion so
    // XP from cheers doesn't linger after the original is gone.
    await tx
      .delete(events)
      .where(
        and(
          eq(events.userId, userId),
          eq(events.type, 'task.cheered'),
          sql`${events.payload}->>'completionEventId' IN (
            SELECT id FROM ${events} WHERE ${events.userId} = ${userId}
              AND ${events.type} = 'task.completed'
              AND ${events.payload}->>'instanceId' = ${latest.id}
          )`,
        ),
      )

    await tx
      .update(taskInstances)
      .set({ completedAt: null })
      .where(eq(taskInstances.id, latest.id))

    // Also roll back the "next instance" that was materialized when
    // this one got completed. A recurring task auto-created a future
    // instance; reopening the current one should also remove the
    // speculative follow-up so we don't end up with duplicates.
    if (latest.dueAt) {
      await tx
        .delete(taskInstances)
        .where(
          and(
            eq(taskInstances.taskId, taskId),
            eq(taskInstances.userId, userId),
            isNull(taskInstances.completedAt),
            isNull(taskInstances.skippedAt),
            gt(taskInstances.dueAt, latest.dueAt),
          ),
        )
    }

    await rebuildProgression(tx, userId, timeZone)
    return { instanceId: latest.id }
  })
}

// Replay all surviving events for this user through applyEvent and
// write the result to the progression table. Used after reopening a
// completion so XP/streak stay consistent with the event log.
async function rebuildProgression(
  tx: Parameters<Parameters<typeof db.transaction>[0]>[0],
  userId: string,
  timeZone: string,
): Promise<void> {
  const rows = await tx
    .select({
      type: events.type,
      payload: events.payload,
      occurredAt: events.occurredAt,
    })
    .from(events)
    .where(eq(events.userId, userId))
    .orderBy(events.occurredAt)

  let state = INITIAL_PROGRESSION
  for (const r of rows) {
    if (!r.occurredAt) continue
    const p =
      r.payload && typeof r.payload === 'object'
        ? (r.payload as Record<string, unknown>)
        : {}
    const occurredAt = r.occurredAt
    if (r.type === 'task.completed') {
      state = applyEvent(
        state,
        {
          type: 'task.completed',
          taskId: typeof p['taskId'] === 'string' ? (p['taskId'] as string) : '',
          instanceId:
            typeof p['instanceId'] === 'string'
              ? (p['instanceId'] as string)
              : '',
          difficulty:
            (typeof p['difficulty'] === 'string'
              ? (p['difficulty'] as Difficulty)
              : 'medium') as Difficulty,
          xpOverride:
            typeof p['xpOverride'] === 'number'
              ? (p['xpOverride'] as number)
              : null,
          dueAt:
            typeof p['dueAt'] === 'string'
              ? new Date(p['dueAt'] as string)
              : null,
          timeOfDay:
            typeof p['timeOfDay'] === 'string'
              ? (p['timeOfDay'] as string)
              : null,
          occurredAt,
        },
        { timeZone },
      )
    } else if (r.type === 'task.cheered') {
      state = applyEvent(
        state,
        {
          type: 'task.cheered',
          completionEventId:
            typeof p['completionEventId'] === 'string'
              ? (p['completionEventId'] as string)
              : '',
          giverUserId:
            typeof p['giverUserId'] === 'string'
              ? (p['giverUserId'] as string)
              : '',
          xp: typeof p['xp'] === 'number' ? (p['xp'] as number) : 0,
          occurredAt,
        },
        { timeZone },
      )
    } else if (r.type === 'friend.added') {
      state = applyEvent(
        state,
        {
          type: 'friend.added',
          otherUserId:
            typeof p['otherUserId'] === 'string'
              ? (p['otherUserId'] as string)
              : '',
          xp: typeof p['xp'] === 'number' ? (p['xp'] as number) : 0,
          occurredAt,
        },
        { timeZone },
      )
    } else if (r.type === 'focus.started') {
      // No-op for progression projection.
    } else if (r.type === 'focus.completed') {
      const durationMin =
        p['durationMin'] === 5 ||
        p['durationMin'] === 10 ||
        p['durationMin'] === 15 ||
        p['durationMin'] === 25 ||
        p['durationMin'] === 50
          ? (p['durationMin'] as 5 | 10 | 15 | 25 | 50)
          : 25
      state = applyEvent(
        state,
        {
          type: 'focus.completed',
          durationMin,
          taskInstanceId:
            typeof p['taskInstanceId'] === 'string'
              ? (p['taskInstanceId'] as string)
              : null,
          tokensEarned:
            typeof p['tokensEarned'] === 'number'
              ? (p['tokensEarned'] as number)
              : 0,
          xpEarned:
            typeof p['xpEarned'] === 'number' ? (p['xpEarned'] as number) : 0,
          occurredAt,
        },
        { timeZone },
      )
    } else if (r.type === 'game.played') {
      const result =
        p['result'] && typeof p['result'] === 'object'
          ? (p['result'] as Record<string, unknown>)
          : {}
      state = applyEvent(
        state,
        {
          type: 'game.played',
          gameId: typeof p['gameId'] === 'string' ? (p['gameId'] as string) : '',
          tokenCost:
            typeof p['tokenCost'] === 'number' ? (p['tokenCost'] as number) : 0,
          xpReward:
            typeof p['xpReward'] === 'number' ? (p['xpReward'] as number) : 0,
          result: {
            won: result['won'] === true,
            score: typeof result['score'] === 'number' ? (result['score'] as number) : null,
          },
          occurredAt,
        },
        { timeZone },
      )
    } else if (r.type === 'tokens.granted') {
      state = applyEvent(
        state,
        {
          type: 'tokens.granted',
          amount: typeof p['amount'] === 'number' ? (p['amount'] as number) : 0,
          reason: typeof p['reason'] === 'string' ? (p['reason'] as string) : null,
          grantedBy:
            typeof p['grantedBy'] === 'string' ? (p['grantedBy'] as string) : '',
          occurredAt,
        },
        { timeZone },
      )
    } else if (r.type === 'task.step.completed') {
      state = applyEvent(
        state,
        {
          type: 'task.step.completed',
          taskId: typeof p['taskId'] === 'string' ? (p['taskId'] as string) : '',
          stepId: typeof p['stepId'] === 'string' ? (p['stepId'] as string) : '',
          instanceId:
            typeof p['instanceId'] === 'string'
              ? (p['instanceId'] as string)
              : '',
          xpEarned:
            typeof p['xpEarned'] === 'number' ? (p['xpEarned'] as number) : 0,
          occurredAt,
        },
        { timeZone },
      )
    } else if (r.type === 'task.step.uncompleted') {
      state = applyEvent(
        state,
        {
          type: 'task.step.uncompleted',
          taskId: typeof p['taskId'] === 'string' ? (p['taskId'] as string) : '',
          stepId: typeof p['stepId'] === 'string' ? (p['stepId'] as string) : '',
          instanceId:
            typeof p['instanceId'] === 'string'
              ? (p['instanceId'] as string)
              : '',
          xpRefunded:
            typeof p['xpRefunded'] === 'number'
              ? (p['xpRefunded'] as number)
              : 0,
          occurredAt,
        },
        { timeZone },
      )
    }
  }

  const now = new Date()
  await tx
    .insert(progression)
    .values({
      userId,
      xp: state.xp,
      level: state.level,
      currentStreak: state.currentStreak,
      longestStreak: state.longestStreak,
      tokens: state.tokens,
      lastCompletionAt: state.lastCompletionAt,
    })
    .onConflictDoUpdate({
      target: progression.userId,
      set: {
        xp: state.xp,
        level: state.level,
        currentStreak: state.currentStreak,
        longestStreak: state.longestStreak,
        tokens: state.tokens,
        lastCompletionAt: state.lastCompletionAt,
        updatedAt: now,
      },
    })
}

export async function completeInstance(
  userId: string,
  instanceId: string,
  options: { force?: boolean } = {},
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

    // If the task has steps and any are unchecked on this instance,
    // require an explicit `force` from the caller before we complete
    // the parent. The UI uses this to surface a confirm modal.
    const stepRows = await tx
      .select({ id: taskSteps.id })
      .from(taskSteps)
      .where(eq(taskSteps.taskId, task.id))
    const totalSteps = stepRows.length
    if (totalSteps > 0 && !options.force) {
      const completedRows = await tx
        .select({ stepId: taskStepCompletions.stepId })
        .from(taskStepCompletions)
        .where(eq(taskStepCompletions.instanceId, instance.id))
      const unchecked = totalSteps - completedRows.length
      if (unchecked > 0) {
        return {
          requiresConfirm: true as const,
          uncheckedSteps: unchecked,
        }
      }
    }

    await tx
      .update(taskInstances)
      .set({ completedAt: now })
      .where(eq(taskInstances.id, instance.id))

    // When the task has steps, the parent only grants a 25% completion
    // bonus on top of whatever XP the steps already awarded. Without
    // steps, behavior is unchanged. An instance-level xpOverride wins
    // over the task default — that's how "Move to tomorrow" applies its
    // -30% penalty without touching the task itself.
    const effectiveXpOverride = instance.xpOverride ?? task.xpOverride
    const parentXpOverride =
      totalSteps > 0
        ? parentBonusBaseXp(
            baseXpForDifficulty(
              task.difficulty as Difficulty,
              effectiveXpOverride,
            ),
          )
        : effectiveXpOverride

    const event: DomainEvent = {
      type: 'task.completed',
      taskId: task.id,
      instanceId: instance.id,
      difficulty: task.difficulty as Difficulty,
      xpOverride: parentXpOverride,
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
          tokens: current.tokens,
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
        tokens: next.tokens,
        lastCompletionAt: next.lastCompletionAt,
      })
      .onConflictDoUpdate({
        target: progression.userId,
        set: {
          xp: next.xp,
          level: next.level,
          currentStreak: next.currentStreak,
          longestStreak: next.longestStreak,
          tokens: next.tokens,
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
      // Hide the rematerialized instance from today/today-queries until
      // its next due time. Without this an "anytime + repeat 2h after
      // completion" task reappears instantly because nextDue is still
      // today (< horizon). snoozedUntil is the existing per-instance
      // gate the today query already respects.
      const snoozedUntil = nextDue > now ? nextDue : null
      const [inst] = await tx
        .insert(taskInstances)
        .values({ taskId: task.id, userId, dueAt: nextDue, snoozedUntil })
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

  if ('alreadyHandled' in txResult && txResult.alreadyHandled) {
    return { alreadyHandled: true }
  }
  if ('requiresConfirm' in txResult && txResult.requiresConfirm) {
    return {
      requiresConfirm: true,
      uncheckedSteps: txResult.uncheckedSteps,
    }
  }

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
      const snoozedUntil = nextDue > now ? nextDue : null
      const [inst] = await tx
        .insert(taskInstances)
        .values({ taskId: task.id, userId, dueAt: nextDue, snoozedUntil })
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

// "Move to tomorrow": shifts the instance's dueAt to tomorrow at the
// task's timeOfDay (or 9:00 if anytime), parks snoozedUntil at the same
// moment so it leaves today's list, and stamps a per-instance xpOverride
// at 70% of whatever base would have applied (compounds across repeated
// defers — repeat-deferring loses more XP each time).
const DEFER_PENALTY = 0.7
const DEFAULT_DEFER_TIME_OF_DAY = '09:00'

export async function deferInstanceToTomorrow(
  userId: string,
  instanceId: string,
): Promise<{ deferredUntil: string; xpOverride: number }> {
  if (!instanceId) throw new Error('instanceId required')
  const now = new Date()
  const timeZone = await getUserTimeZone(userId)

  return await db.transaction(async (tx) => {
    const instance = await tx.query.taskInstances.findFirst({
      where: and(
        eq(taskInstances.id, instanceId),
        eq(taskInstances.userId, userId),
      ),
    })
    if (!instance) throw new Error('instance not found')
    if (instance.completedAt || instance.skippedAt) {
      throw new Error('instance already handled')
    }

    const task = await tx.query.tasks.findFirst({
      where: eq(tasks.id, instance.taskId),
    })
    if (!task) throw new Error('task missing')

    const tomorrowDate = formatInTimeZone(
      new Date(now.getTime() + 86_400_000),
      timeZone,
      'yyyy-MM-dd',
    )
    const tod = task.timeOfDay ?? DEFAULT_DEFER_TIME_OF_DAY
    const newDueAt = fromZonedTime(`${tomorrowDate} ${tod}:00`, timeZone)

    const currentBase = baseXpForDifficulty(
      task.difficulty as Difficulty,
      instance.xpOverride ?? task.xpOverride,
    )
    const newOverride = Math.max(1, Math.round(currentBase * DEFER_PENALTY))

    await tx
      .update(taskInstances)
      .set({
        dueAt: newDueAt,
        snoozedUntil: newDueAt,
        xpOverride: newOverride,
      })
      .where(eq(taskInstances.id, instance.id))

    return {
      deferredUntil: newDueAt.toISOString(),
      xpOverride: newOverride,
    }
  })
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
    return { xp: 0, level: 1, currentStreak: 0, longestStreak: 0, tokens: 0 }
  }
  return {
    xp: row.xp,
    level: row.level,
    currentStreak: row.currentStreak,
    longestStreak: row.longestStreak,
    tokens: row.tokens,
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
  // Aggregate distribution of completion time relative to scheduled timeOfDay,
  // across all tasks that had a scheduled time. 10-minute buckets spanning
  // ±180 minutes (37 buckets). offsetMin is the bucket center in minutes
  // (negative = completed early, positive = late).
  timingOffset: {
    buckets: Array<{ offsetMin: number; count: number }>
    totalScheduled: number
    avgOffsetMin: number
    withinThirtyCount: number
  }
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
  const timeFmt = new Intl.DateTimeFormat('en-US', {
    timeZone,
    hour: '2-digit',
    minute: '2-digit',
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

  const OFFSET_RANGE_MIN = 180
  const OFFSET_BUCKET_SIZE = 10
  const offsetBuckets = new Map<number, number>()
  for (let b = -OFFSET_RANGE_MIN; b <= OFFSET_RANGE_MIN; b += OFFSET_BUCKET_SIZE) {
    offsetBuckets.set(b, 0)
  }
  let timingTotal = 0
  let offsetSum = 0
  let withinThirty = 0

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

    const scheduledTod =
      typeof p['timeOfDay'] === 'string' ? (p['timeOfDay'] as string) : null
    if (scheduledTod) {
      const [schedHStr, schedMStr] = scheduledTod.split(':')
      const schedH = Number.parseInt(schedHStr ?? '', 10)
      const schedM = Number.parseInt(schedMStr ?? '', 10)
      if (Number.isFinite(schedH) && Number.isFinite(schedM)) {
        const parts = timeFmt.formatToParts(r.occurredAt)
        const actualH = Number.parseInt(
          parts.find((x) => x.type === 'hour')?.value ?? '',
          10,
        )
        const actualM = Number.parseInt(
          parts.find((x) => x.type === 'minute')?.value ?? '',
          10,
        )
        if (Number.isFinite(actualH) && Number.isFinite(actualM)) {
          const scheduledMin = schedH * 60 + schedM
          const actualMin = (actualH % 24) * 60 + actualM
          // Wrap to [-720, 720] so a 23:00 task finished at 01:00 reads as
          // +120 minutes late, not −1320.
          let offset = actualMin - scheduledMin
          if (offset > 720) offset -= 1440
          else if (offset < -720) offset += 1440
          const clamped = Math.max(
            -OFFSET_RANGE_MIN,
            Math.min(OFFSET_RANGE_MIN, offset),
          )
          const bucket =
            Math.round(clamped / OFFSET_BUCKET_SIZE) * OFFSET_BUCKET_SIZE
          offsetBuckets.set(bucket, (offsetBuckets.get(bucket) ?? 0) + 1)
          timingTotal += 1
          offsetSum += offset
          if (Math.abs(offset) <= 30) withinThirty += 1
        }
      }
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

  const timingBuckets = Array.from(offsetBuckets.entries())
    .sort((a, b) => a[0] - b[0])
    .map(([offsetMin, count]) => ({ offsetMin, count }))

  return {
    days: allTime ? fillDays : (days as number),
    xpByDay: xpSeries,
    weekday,
    hour,
    topTasks,
    timingOffset: {
      buckets: timingBuckets,
      totalScheduled: timingTotal,
      avgOffsetMin:
        timingTotal > 0 ? Math.round(offsetSum / timingTotal) : 0,
      withinThirtyCount: withinThirty,
    },
  }
}

export interface TaskStats {
  days: number
  task: {
    id: string
    title: string
    timeOfDay: string | null
    difficulty: string | null
    recurrence: string | null
    categorySlug: string | null
    exists: boolean
  }
  completionCount: number
  totalXp: number
  xpByDay: Array<{ date: string; xp: number; count: number }>
  timingOffset: {
    buckets: Array<{ offsetMin: number; count: number }>
    totalScheduled: number
    avgOffsetMin: number
    withinThirtyCount: number
  } | null
  recentCompletions: Array<{
    instanceId: string | null
    occurredAt: string
    xp: number
  }>
}

export async function getTaskStats(
  userId: string,
  taskId: string,
  days: number | 'all',
): Promise<TaskStats> {
  const timeZone = await getUserTimeZone(userId)
  const allTime = days === 'all'
  const since = allTime
    ? new Date(0)
    : new Date(Date.now() - (days as number) * 24 * 3_600_000)

  const taskRow = await db
    .select({
      id: tasks.id,
      title: tasks.title,
      timeOfDay: tasks.timeOfDay,
      difficulty: tasks.difficulty,
      recurrence: tasks.recurrence,
      categorySlug: tasks.categorySlug,
      ownerId: tasks.userId,
    })
    .from(tasks)
    .where(eq(tasks.id, taskId))
    .limit(1)
    .then((rows) => rows[0] ?? null)

  if (taskRow && taskRow.ownerId !== userId) {
    throw new Error('task not found')
  }

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
        sql`${events.payload}->>'taskId' = ${taskId}`,
      ),
    )
    .orderBy(events.occurredAt)

  const dayFmt = new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  })
  const timeFmt = new Intl.DateTimeFormat('en-US', {
    timeZone,
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  })

  const OFFSET_RANGE_MIN = 180
  const OFFSET_BUCKET_SIZE = 10
  const offsetBuckets = new Map<number, number>()
  for (let b = -OFFSET_RANGE_MIN; b <= OFFSET_RANGE_MIN; b += OFFSET_BUCKET_SIZE) {
    offsetBuckets.set(b, 0)
  }
  let timingTotal = 0
  let offsetSum = 0
  let withinThirty = 0

  const xpByDay = new Map<string, { xp: number; count: number }>()
  const recent: Array<{
    instanceId: string | null
    occurredAt: string
    xp: number
  }> = []
  let completionCount = 0
  let totalXp = 0
  let hasAnyScheduled = false

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
    const instanceId =
      typeof p['instanceId'] === 'string' ? (p['instanceId'] as string) : null

    completionCount += 1
    totalXp += xp

    const dayKey = dayFmt.format(r.occurredAt)
    const bucket = xpByDay.get(dayKey) ?? { xp: 0, count: 0 }
    bucket.xp += xp
    bucket.count += 1
    xpByDay.set(dayKey, bucket)

    recent.push({
      instanceId,
      occurredAt: r.occurredAt.toISOString(),
      xp,
    })

    const scheduledTod =
      typeof p['timeOfDay'] === 'string' ? (p['timeOfDay'] as string) : null
    if (scheduledTod) {
      hasAnyScheduled = true
      const [schedHStr, schedMStr] = scheduledTod.split(':')
      const schedH = Number.parseInt(schedHStr ?? '', 10)
      const schedM = Number.parseInt(schedMStr ?? '', 10)
      if (Number.isFinite(schedH) && Number.isFinite(schedM)) {
        const parts = timeFmt.formatToParts(r.occurredAt)
        const actualH = Number.parseInt(
          parts.find((x) => x.type === 'hour')?.value ?? '',
          10,
        )
        const actualM = Number.parseInt(
          parts.find((x) => x.type === 'minute')?.value ?? '',
          10,
        )
        if (Number.isFinite(actualH) && Number.isFinite(actualM)) {
          const scheduledMin = schedH * 60 + schedM
          const actualMin = (actualH % 24) * 60 + actualM
          let offset = actualMin - scheduledMin
          if (offset > 720) offset -= 1440
          else if (offset < -720) offset += 1440
          const clamped = Math.max(
            -OFFSET_RANGE_MIN,
            Math.min(OFFSET_RANGE_MIN, offset),
          )
          const b =
            Math.round(clamped / OFFSET_BUCKET_SIZE) * OFFSET_BUCKET_SIZE
          offsetBuckets.set(b, (offsetBuckets.get(b) ?? 0) + 1)
          timingTotal += 1
          offsetSum += offset
          if (Math.abs(offset) <= 30) withinThirty += 1
        }
      }
    }
  }

  // Fill every day in the window so the xp-by-day line has no gaps.
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

  const timingBuckets = Array.from(offsetBuckets.entries())
    .sort((a, b) => a[0] - b[0])
    .map(([offsetMin, count]) => ({ offsetMin, count }))

  // Fall back to the event payload's timeOfDay if the task row is gone, so
  // a deleted task's timing curve still makes sense.
  let resolvedTimeOfDay: string | null = taskRow?.timeOfDay ?? null
  if (!resolvedTimeOfDay) {
    for (const r of rows) {
      const p =
        r.payload && typeof r.payload === 'object'
          ? (r.payload as Record<string, unknown>)
          : {}
      if (typeof p['timeOfDay'] === 'string') {
        resolvedTimeOfDay = p['timeOfDay'] as string
        break
      }
    }
  }

  const lastTitle =
    taskRow?.title ??
    (rows.length > 0 ? '(deleted task)' : '(unknown task)')

  return {
    days: allTime ? fillDays : (days as number),
    task: {
      id: taskId,
      title: lastTitle,
      timeOfDay: resolvedTimeOfDay,
      difficulty: taskRow?.difficulty ?? null,
      recurrence: taskRow?.recurrence?.type ?? null,
      categorySlug: taskRow?.categorySlug ?? null,
      exists: !!taskRow,
    },
    completionCount,
    totalXp,
    xpByDay: xpSeries,
    timingOffset: hasAnyScheduled
      ? {
          buckets: timingBuckets,
          totalScheduled: timingTotal,
          avgOffsetMin:
            timingTotal > 0 ? Math.round(offsetSum / timingTotal) : 0,
          withinThirtyCount: withinThirty,
        }
      : null,
    // Most recent 15, newest first.
    recentCompletions: recent.slice(-15).reverse(),
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

// ---------------------------------------------------------------------------
// Subtask checklist
// ---------------------------------------------------------------------------

export interface TaskStep {
  id: string
  taskId: string
  title: string
  position: number
  completedAt: string | null
  xpEarned: number | null
}

// Batch step-count loader for the today/someday list queries. One pair
// of small SELECTs instead of N+1.
async function loadStepCounts(
  pairs: Array<{ taskId: string; instanceId: string }>,
): Promise<Map<string, { total: number; completedByInstance: Map<string, number> }>> {
  const result = new Map<
    string,
    { total: number; completedByInstance: Map<string, number> }
  >()
  if (pairs.length === 0) return result

  const taskIds = Array.from(new Set(pairs.map((p) => p.taskId)))
  const instanceIds = Array.from(new Set(pairs.map((p) => p.instanceId)))

  const totals = await db
    .select({ taskId: taskSteps.taskId, id: taskSteps.id })
    .from(taskSteps)
    .where(inArray(taskSteps.taskId, taskIds))
  for (const row of totals) {
    const entry = result.get(row.taskId)
    if (entry) entry.total += 1
    else
      result.set(row.taskId, {
        total: 1,
        completedByInstance: new Map(),
      })
  }

  const completed = await db
    .select({
      instanceId: taskStepCompletions.instanceId,
      taskId: taskSteps.taskId,
    })
    .from(taskStepCompletions)
    .innerJoin(taskSteps, eq(taskStepCompletions.stepId, taskSteps.id))
    .where(inArray(taskStepCompletions.instanceId, instanceIds))
  for (const row of completed) {
    let entry = result.get(row.taskId)
    if (!entry) {
      entry = { total: 0, completedByInstance: new Map() }
      result.set(row.taskId, entry)
    }
    entry.completedByInstance.set(
      row.instanceId,
      (entry.completedByInstance.get(row.instanceId) ?? 0) + 1,
    )
  }

  return result
}

async function assertTaskOwned(
  userId: string,
  taskId: string,
): Promise<void> {
  const row = await db.query.tasks.findFirst({
    where: and(eq(tasks.id, taskId), eq(tasks.userId, userId)),
    columns: { id: true },
  })
  if (!row) throw new Error('task not found')
}

async function loadStepWithOwnership(
  userId: string,
  stepId: string,
): Promise<{
  id: string
  taskId: string
  title: string
}> {
  const row = await db.query.taskSteps.findFirst({
    where: and(eq(taskSteps.id, stepId), eq(taskSteps.userId, userId)),
    columns: { id: true, taskId: true, title: true },
  })
  if (!row) throw new Error('step not found')
  return row
}

export async function listTaskSteps(
  userId: string,
  taskId: string,
  instanceId: string | null,
): Promise<TaskStep[]> {
  await assertTaskOwned(userId, taskId)
  const stepRows = await db
    .select({
      id: taskSteps.id,
      taskId: taskSteps.taskId,
      title: taskSteps.title,
      position: taskSteps.position,
    })
    .from(taskSteps)
    .where(eq(taskSteps.taskId, taskId))
    .orderBy(taskSteps.position, taskSteps.createdAt)

  const completionByStep = new Map<string, { completedAt: Date; xpEarned: number }>()
  if (instanceId && stepRows.length > 0) {
    const completions = await db
      .select({
        stepId: taskStepCompletions.stepId,
        completedAt: taskStepCompletions.completedAt,
        xpEarned: taskStepCompletions.xpEarned,
      })
      .from(taskStepCompletions)
      .where(eq(taskStepCompletions.instanceId, instanceId))
    for (const c of completions) {
      completionByStep.set(c.stepId, {
        completedAt: c.completedAt,
        xpEarned: c.xpEarned,
      })
    }
  }

  return stepRows.map((s) => {
    const c = completionByStep.get(s.id)
    return {
      id: s.id,
      taskId: s.taskId,
      title: s.title,
      position: s.position,
      completedAt: c?.completedAt.toISOString() ?? null,
      xpEarned: c?.xpEarned ?? null,
    }
  })
}

export async function addTaskStep(
  userId: string,
  taskId: string,
  title: string,
): Promise<{ id: string; position: number }> {
  await assertTaskOwned(userId, taskId)
  const trimmed = title.trim()
  if (!trimmed) throw new Error('title is required')

  return db.transaction(async (tx) => {
    const existing = await tx
      .select({ position: taskSteps.position })
      .from(taskSteps)
      .where(eq(taskSteps.taskId, taskId))
    const nextPosition =
      existing.length === 0
        ? 0
        : Math.max(...existing.map((r) => r.position)) + 1
    const [row] = await tx
      .insert(taskSteps)
      .values({
        taskId,
        userId,
        title: trimmed,
        position: nextPosition,
      })
      .returning({ id: taskSteps.id, position: taskSteps.position })
    return { id: row.id, position: row.position }
  })
}

export async function renameTaskStep(
  userId: string,
  stepId: string,
  title: string,
): Promise<{ id: string }> {
  const trimmed = title.trim()
  if (!trimmed) throw new Error('title is required')
  const step = await loadStepWithOwnership(userId, stepId)
  await db
    .update(taskSteps)
    .set({ title: trimmed, updatedAt: new Date() })
    .where(eq(taskSteps.id, step.id))
  return { id: step.id }
}

export async function reorderTaskSteps(
  userId: string,
  taskId: string,
  orderedIds: string[],
): Promise<{ ok: true }> {
  await assertTaskOwned(userId, taskId)
  await db.transaction(async (tx) => {
    const owned = await tx
      .select({ id: taskSteps.id })
      .from(taskSteps)
      .where(eq(taskSteps.taskId, taskId))
    const ownedSet = new Set(owned.map((r) => r.id))
    for (const id of orderedIds) {
      if (!ownedSet.has(id)) throw new Error('step does not belong to task')
    }
    const now = new Date()
    for (let i = 0; i < orderedIds.length; i++) {
      await tx
        .update(taskSteps)
        .set({ position: i, updatedAt: now })
        .where(eq(taskSteps.id, orderedIds[i]))
    }
  })
  return { ok: true }
}

export async function deleteTaskStep(
  userId: string,
  stepId: string,
): Promise<{ id: string }> {
  const step = await loadStepWithOwnership(userId, stepId)
  // Cascade through task_step_completions handled at the FK level.
  await db.delete(taskSteps).where(eq(taskSteps.id, step.id))
  return { id: step.id }
}

export type ToggleStepResult =
  | {
      completedAt: string
      xpEarned: number
      progression: ProgressionSummary
    }
  | {
      completedAt: null
      xpRefunded: number
      progression: ProgressionSummary
    }

// Toggle a step on/off for a given task instance. On check, computes XP
// from the parent's base XP / current step count modulated by streak +
// punctuality, persists to task_step_completions and emits a
// task.step.completed event. On uncheck, deletes the row and emits a
// compensating task.step.uncompleted event with the exact prior xpEarned.
export async function toggleTaskStep(
  userId: string,
  stepId: string,
  instanceId: string,
): Promise<ToggleStepResult> {
  if (!instanceId) throw new Error('instanceId required')
  const now = new Date()
  const timeZone = await getUserTimeZone(userId)

  return db.transaction(async (tx) => {
    const step = await tx.query.taskSteps.findFirst({
      where: and(eq(taskSteps.id, stepId), eq(taskSteps.userId, userId)),
    })
    if (!step) throw new Error('step not found')

    const instance = await tx.query.taskInstances.findFirst({
      where: and(
        eq(taskInstances.id, instanceId),
        eq(taskInstances.userId, userId),
      ),
    })
    if (!instance) throw new Error('instance not found')
    if (instance.taskId !== step.taskId) {
      throw new Error('step does not belong to instance')
    }

    const task = await tx.query.tasks.findFirst({
      where: eq(tasks.id, step.taskId),
    })
    if (!task) throw new Error('task missing')

    const existing = await tx.query.taskStepCompletions.findFirst({
      where: and(
        eq(taskStepCompletions.instanceId, instanceId),
        eq(taskStepCompletions.stepId, stepId),
      ),
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
          tokens: current.tokens,
          lastCompletionAt: current.lastCompletionAt,
        }
      : INITIAL_PROGRESSION

    if (existing) {
      // Uncheck: refund the exact XP we recorded on check.
      const refund = existing.xpEarned
      await tx
        .delete(taskStepCompletions)
        .where(
          and(
            eq(taskStepCompletions.instanceId, instanceId),
            eq(taskStepCompletions.stepId, stepId),
          ),
        )
      const event: DomainEvent = {
        type: 'task.step.uncompleted',
        taskId: task.id,
        stepId: step.id,
        instanceId,
        xpRefunded: refund,
        occurredAt: now,
      }
      await tx.insert(events).values({
        userId,
        type: event.type,
        payload: {
          taskId: event.taskId,
          stepId: event.stepId,
          instanceId: event.instanceId,
          xpRefunded: event.xpRefunded,
        },
        occurredAt: now,
      })
      const next = applyEvent(prevState, event, { timeZone })
      await writeProgression(tx, userId, next, now)
      return {
        completedAt: null,
        xpRefunded: refund,
        progression: progressionSummary(next),
      } as const
    }

    // Check: compute XP using parent's base / current step count.
    const totalRows = await tx
      .select({ id: taskSteps.id })
      .from(taskSteps)
      .where(eq(taskSteps.taskId, task.id))
    const totalSteps = totalRows.length

    const punctuality = punctualityMultiplier({
      dueAt: instance.dueAt,
      completedAt: now,
      timeOfDay: task.timeOfDay,
      timeZone,
    })

    const xpEarned = computeStepXp({
      parentBaseXp: baseXpForDifficulty(
        task.difficulty as Difficulty,
        instance.xpOverride ?? task.xpOverride,
      ),
      totalSteps,
      currentStreak: prevState.currentStreak,
      punctuality,
    })

    await tx.insert(taskStepCompletions).values({
      instanceId,
      stepId,
      userId,
      completedAt: now,
      xpEarned,
    })

    const event: DomainEvent = {
      type: 'task.step.completed',
      taskId: task.id,
      stepId: step.id,
      instanceId,
      xpEarned,
      occurredAt: now,
    }
    await tx.insert(events).values({
      userId,
      type: event.type,
      payload: {
        taskId: event.taskId,
        stepId: event.stepId,
        instanceId: event.instanceId,
        xpEarned: event.xpEarned,
      },
      occurredAt: now,
    })
    const next = applyEvent(prevState, event, { timeZone })
    await writeProgression(tx, userId, next, now)
    return {
      completedAt: now.toISOString(),
      xpEarned,
      progression: progressionSummary(next),
    } as const
  })
}

function progressionSummary(state: {
  xp: number
  level: number
  currentStreak: number
  longestStreak: number
  tokens: number
}): ProgressionSummary {
  return {
    xp: state.xp,
    level: state.level,
    currentStreak: state.currentStreak,
    longestStreak: state.longestStreak,
    tokens: state.tokens,
  }
}

async function writeProgression(
  tx: Parameters<Parameters<typeof db.transaction>[0]>[0],
  userId: string,
  next: {
    xp: number
    level: number
    currentStreak: number
    longestStreak: number
    tokens: number
    lastCompletionAt: Date | null
  },
  now: Date,
): Promise<void> {
  await tx
    .insert(progression)
    .values({
      userId,
      xp: next.xp,
      level: next.level,
      currentStreak: next.currentStreak,
      longestStreak: next.longestStreak,
      tokens: next.tokens,
      lastCompletionAt: next.lastCompletionAt,
    })
    .onConflictDoUpdate({
      target: progression.userId,
      set: {
        xp: next.xp,
        level: next.level,
        currentStreak: next.currentStreak,
        longestStreak: next.longestStreak,
        tokens: next.tokens,
        lastCompletionAt: next.lastCompletionAt,
        updatedAt: now,
      },
    })
}
