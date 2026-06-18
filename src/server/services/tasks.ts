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
  count,
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
  coachSummaries,
  events,
  householdMembers,
  progression,
  taskInstances,
  taskStepCompletions,
  taskSteps,
  tasks,
  userPrefs,
  user as userTable,
} from '../db/schema'
import type { Recurrence } from '../../domain/recurrence'
import {
  computeNextDue,
  expectedCompletionsPerWeek,
  firstDueAt,
} from '../../domain/recurrence'
import {
  assertHouseholdRole,
  getMyMembership,
  listHouseholdMembers,
} from './households'
import {
  assertValidTimeOfDay,
  assertValidWeekdayTimes,
  dayOfWeekInTz,
  resolveTimeOfDay,
  setTimeInTz,
  type WeekdayTimes,
} from '../../domain/time'
import type { Difficulty, DomainEvent } from '../../domain/events'
import { KID_TOKENS_EVERY_N_COMPLETIONS } from '../../domain/events'
import {
  INITIAL_PROGRESSION,
  applyEvent,
  baseXpForDifficulty,
  computeStepXp,
  parentBonusBaseXp,
  punctualityMultiplier,
  type Progression,
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
  // Optional per-weekday time overrides ('0'..'6' = Sun..Sat -> HH:MM). Only
  // meaningful alongside a base timeOfDay; a weekday absent from the map uses
  // timeOfDay. The editor uses this for "different time on weekends" on daily
  // tasks, but the scheduler honors any weekday pattern.
  timeByWeekday?: WeekdayTimes | null
  someday: boolean
  visibility?: TaskVisibility
  // Absolute due instant set by the client. When present, overrides
  // the default firstDueAt(now, recurrence, timeOfDay) computation.
  // Used by the "In N hours/minutes" picker so the first instance can
  // land at any moment (not just a same-day HH:MM), while still
  // letting `recurrence` drive later occurrences.
  dueAtOverride?: string | null
  // Discriminator for the punctuality curve at completion. Defaults to
  // 'hard' when missing. 'week_target' selects the soft early-bird/late
  // curve and is set by the "By a target day" form option.
  dueKind?: 'hard' | 'week_target'
  // Optional checklist steps to seed the task with. Empty/whitespace
  // titles are dropped. Each grants a slice of the parent's XP at
  // completion time (see computeStepXp).
  steps?: string[] | null
  // Household chore fields. When `householdId` is set, the task is
  // owned by the household; XP/streak at completion still go to the
  // completer (event.userId). `assignedToUserId` null + householdId set
  // means free-for-all (any member completes). Validation enforces
  // membership + role-based assignment rules.
  householdId?: string | null
  assignedToUserId?: string | null
  // Rotation strategy for recurring household chores.
  //   'fixed' (default) — assignedToUserId stays put.
  //   'round_robin'     — `rotationPool` is a non-empty list of
  //                       household userIds; each recurrence cycles
  //                       to the next one. Only valid when the task
  //                       is both household-scoped AND recurring;
  //                       only admins may create round-robin tasks.
  rotationStrategy?: 'fixed' | 'round_robin'
  rotationPool?: string[] | null
  // Group-targeted free-for-all. 'adults' = any adult may complete;
  // 'kids' = requested of the kids. Mutually exclusive with
  // `assignedToUserId` and round-robin. Admins and members may both set
  // it (kids/kiosk can't create chores at all).
  assigneeGroup?: 'adults' | 'kids' | null
}

export interface UpdateTaskInput {
  taskId: string
  title: string
  notes: string | null
  difficulty: Difficulty
  recurrence: Recurrence | null
  timeOfDay: string | null
  timeByWeekday?: WeekdayTimes | null
  visibility?: TaskVisibility
  // Affects only future instances (matching the existing edit-form copy).
  // The currently open instance keeps whatever due_kind it was created with.
  dueKind?: 'hard' | 'week_target'
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
  dueKind: 'hard' | 'week_target'
  householdId: string | null
  assignedToUserId: string | null
  assigneeGroup: 'adults' | 'kids' | null
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
  dueKind: 'hard' | 'week_target'
  lastCompletedAt: string | null
  hasOpenInstance: boolean
}

// List-view row: TaskSummary plus the soonest open instance's schedule, used
// by the tasks page's "Upcoming" filter and "Show in Today now" action.
export interface TaskListRow extends TaskSummary {
  openInstanceId: string | null
  nextDueAt: string | null
  // True when an open, dated instance exists that the Today list is currently
  // hiding because it's scheduled past today or snoozed into the future.
  upcoming: boolean
}

export interface TaskDetail extends TaskSummary {
  active: boolean
  updatedAt: string
  timeByWeekday: WeekdayTimes | null
  householdId: string | null
  assignedToUserId: string | null
  assigneeGroup: 'adults' | 'kids' | null
  rotationStrategy: 'fixed' | 'round_robin'
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
      // Kid (or future kiosk) clicked complete on a household chore.
      // The instance is now in pending-approval state — no event,
      // no XP — until an admin/member approves. The UI uses this to
      // show a "waiting for approval" toast instead of an XP gain.
      pendingApproval: true
    }
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

// The local HH:MM a user's quiet window ends, or null if none configured.
// Used to re-anchor "anytime" recurring tasks to the morning rather than
// re-surfacing them at whatever time of day they were created.
async function getUserQuietHoursEnd(userId: string): Promise<string | null> {
  const row = await db.query.user.findFirst({
    where: eq(userTable.id, userId),
    columns: { quietHoursEnd: true },
  })
  return row?.quietHoursEnd ?? null
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
  validateWeekdayTimes(input.timeByWeekday, input.timeOfDay)
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
  validateWeekdayTimes(input.timeByWeekday, input.timeOfDay)
  if (
    input.visibility !== undefined &&
    !TASK_VISIBILITY_VALUES.includes(input.visibility)
  ) {
    throw new Error('invalid visibility')
  }
}

// Per-weekday time overrides require a base timeOfDay to fall back to (a day
// not listed in the map uses it), and every entry must be a valid weekday->HH:MM.
function validateWeekdayTimes(
  map: WeekdayTimes | null | undefined,
  timeOfDay: string | null,
) {
  if (!map || Object.keys(map).length === 0) return
  if (!timeOfDay) {
    throw new Error('timeByWeekday requires a base timeOfDay')
  }
  assertValidWeekdayTimes(map)
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

  // Household validation. Kids can't create tasks at all. Any adult
  // (admin or member) can assign a chore to any household member, a role
  // group, or free-for-all. If householdId is set without assignedToUserId,
  // it's free-for-all.
  let householdId: string | null = null
  let assignedToUserId: string | null = null
  let assigneeGroup: 'adults' | 'kids' | null = null
  let rotationStrategy: 'fixed' | 'round_robin' = 'fixed'
  let rotationPool: string[] | null = null
  let lastAssigneeCursor: string | null = null
  if (input.householdId) {
    const mine = await db.query.householdMembers.findFirst({
      where: and(
        eq(householdMembers.userId, userId),
        eq(householdMembers.householdId, input.householdId),
      ),
      columns: { role: true },
    })
    if (!mine) throw new Error('You are not a member of that household.')
    if (mine.role === 'kid' || mine.role === 'kiosk') {
      throw new Error('Kids and kiosk accounts cannot create chores.')
    }
    householdId = input.householdId

    if (input.assigneeGroup) {
      // Group ("any adult" / "any kid") = a free-for-all restricted to a
      // role. Admins and members may both set it. Mutually exclusive
      // with a specific assignee and with round-robin; assignedToUserId
      // stays null (anyone in the group completes).
      if (input.assigneeGroup !== 'adults' && input.assigneeGroup !== 'kids') {
        throw new Error('Invalid assignee group.')
      }
      if (input.rotationStrategy === 'round_robin') {
        throw new Error('Round-robin and group assignment can’t be combined.')
      }
      if (input.assignedToUserId) {
        throw new Error('Pick either a specific person or a group, not both.')
      }
      assigneeGroup = input.assigneeGroup
    } else if (input.rotationStrategy === 'round_robin') {
      // Any adult (admin or member) may set up a round-robin rotation —
      // same as assigning a chore to a specific person. Kids/kiosk are
      // already blocked above.
      if (!input.recurrence) {
        throw new Error('Round-robin requires a recurring chore.')
      }
      const pool = (input.rotationPool ?? []).filter(
        (id, idx, arr) => arr.indexOf(id) === idx,
      )
      if (pool.length < 2) {
        throw new Error('Pick at least two people for the rotation.')
      }
      // Validate every pool member is in the household AND isn't a
      // kiosk (kiosks don't accumulate XP; rotating to one would be
      // a dead slot).
      const poolRows = await db
        .select({
          userId: householdMembers.userId,
          role: householdMembers.role,
        })
        .from(householdMembers)
        .where(
          and(
            eq(householdMembers.householdId, householdId),
            inArray(householdMembers.userId, pool),
          ),
        )
      if (poolRows.length !== pool.length) {
        throw new Error('Every rotation member must be in this household.')
      }
      if (poolRows.some((r) => r.role === 'kiosk')) {
        throw new Error('Kiosk accounts can’t be in the rotation.')
      }
      rotationStrategy = 'round_robin'
      rotationPool = pool
      // First instance goes to pool[0]; cursor stays pointing at the
      // current assignee so the next materialization advances cleanly.
      assignedToUserId = pool[0]
      lastAssigneeCursor = pool[0]
    } else if (input.assignedToUserId) {
      if (input.assignedToUserId === userId) {
        assignedToUserId = userId
      } else {
        // Any adult (admin or member) may assign a chore to any other
        // household member. We only validate the assignee actually
        // belongs to this household.
        const assignee = await db.query.householdMembers.findFirst({
          where: and(
            eq(householdMembers.userId, input.assignedToUserId),
            eq(householdMembers.householdId, householdId),
          ),
          columns: { userId: true },
        })
        if (!assignee) {
          throw new Error('Assignee is not a member of this household.')
        }
        assignedToUserId = input.assignedToUserId
      }
    }
  } else if (input.assignedToUserId) {
    throw new Error('assignedToUserId requires a householdId.')
  } else if (input.rotationStrategy === 'round_robin') {
    throw new Error('Round-robin rotation requires a household chore.')
  } else if (input.assigneeGroup) {
    throw new Error('Group assignment requires a household chore.')
  }

  // A weekday-time map only makes sense alongside a base time; drop it for
  // someday/anytime tasks so the column never holds an orphaned override.
  const effectiveTimeOfDay = input.someday ? null : input.timeOfDay
  const effectiveTimeByWeekday = effectiveTimeOfDay
    ? (input.timeByWeekday ?? null)
    : null

  const dueAt = input.dueAtOverride
    ? new Date(input.dueAtOverride)
    : firstDueAt({
        now,
        recurrence: input.recurrence,
        timeOfDay: effectiveTimeOfDay,
        timeByWeekday: effectiveTimeByWeekday,
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
    const dueKind: 'hard' | 'week_target' =
      input.dueKind === 'week_target' ? 'week_target' : 'hard'

    const [task] = await tx
      .insert(tasks)
      .values({
        userId,
        title: input.title.trim(),
        notes: input.notes ?? null,
        difficulty: input.difficulty,
        xpOverride: scored?.xp ?? null,
        recurrence: input.recurrence,
        timeOfDay: effectiveTimeOfDay,
        timeByWeekday: effectiveTimeByWeekday,
        categorySlug: categorization?.slug ?? null,
        visibility: input.visibility ?? 'friends',
        dueKind,
        householdId,
        assignedToUserId,
        assigneeGroup,
        rotationStrategy,
        rotationPool,
        lastAssigneeCursor,
      })
      .returning()

    const [inst] = await tx
      .insert(taskInstances)
      .values({
        taskId: task.id,
        userId,
        dueAt,
        dueKind,
        householdId,
        assignedToUserId,
        assigneeGroup,
      })
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

export async function listAllTasks(userId: string): Promise<TaskListRow[]> {
  const now = new Date()
  const timeZone = await getUserTimeZone(userId)
  // End of the user's local day — same horizon the Today list uses to decide
  // what's "later" vs "now" (see listTodayInstances).
  const todayLocal = formatInTimeZone(now, timeZone, 'yyyy-MM-dd')
  const [y, m, d] = todayLocal.split('-').map(Number)
  const tomorrowStr = `${new Date(Date.UTC(y, m - 1, d + 1))
    .toISOString()
    .slice(0, 10)} 00:00:00`
  const horizon = fromZonedTime(tomorrowStr, timeZone)

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
      dueKind: tasks.dueKind,
      lastCompletedAt: sql<Date | null>`(
        SELECT MAX(${taskInstances.completedAt})
        FROM ${taskInstances}
        WHERE ${taskInstances.taskId} = ${tasks.id}
          AND ${taskInstances.completedAt} IS NOT NULL
      )`,
    })
    .from(tasks)
    .where(and(eq(tasks.userId, userId), eq(tasks.active, true)))
    .orderBy(tasks.createdAt)

  // Open (not completed/skipped/claimed) instances for these tasks. We pick
  // the soonest per task so the "Show now" action targets the next occurrence.
  const openRows = await db
    .select({
      id: taskInstances.id,
      taskId: taskInstances.taskId,
      dueAt: taskInstances.dueAt,
      dueKind: taskInstances.dueKind,
      snoozedUntil: taskInstances.snoozedUntil,
    })
    .from(taskInstances)
    .innerJoin(tasks, eq(tasks.id, taskInstances.taskId))
    .where(
      and(
        eq(tasks.userId, userId),
        eq(tasks.active, true),
        isNull(taskInstances.completedAt),
        isNull(taskInstances.skippedAt),
        isNull(taskInstances.claimedAt),
      ),
    )

  const openByTask = new Map<string, (typeof openRows)[number]>()
  for (const o of openRows) {
    const cur = openByTask.get(o.taskId)
    if (!cur) {
      openByTask.set(o.taskId, o)
      continue
    }
    // Prefer the soonest dueAt; someday instances (null dueAt) sort last.
    const a = o.dueAt ? o.dueAt.getTime() : Infinity
    const b = cur.dueAt ? cur.dueAt.getTime() : Infinity
    if (a < b) openByTask.set(o.taskId, o)
  }

  return rows.map((r) => {
    const open = openByTask.get(r.id) ?? null
    const dueAt = open?.dueAt ?? null
    const snoozedUntil = open?.snoozedUntil ?? null
    const taskSnoozed = r.snoozeUntil != null && r.snoozeUntil >= now
    // Mirrors the Today filter inverted: a dated open instance the Today list
    // is hiding because it's scheduled past today, snoozed, or the whole task
    // is snoozed. Someday tasks (null dueAt) are not "upcoming."
    const upcoming =
      open !== null &&
      dueAt !== null &&
      ((dueAt >= horizon && open.dueKind !== 'week_target') ||
        (snoozedUntil !== null && snoozedUntil >= now) ||
        taskSnoozed)

    return {
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
      dueKind: r.dueKind as 'hard' | 'week_target',
      lastCompletedAt: r.lastCompletedAt
        ? new Date(r.lastCompletedAt).toISOString()
        : null,
      hasOpenInstance: open !== null,
      openInstanceId: open?.id ?? null,
      nextDueAt: dueAt ? dueAt.toISOString() : null,
      upcoming,
    }
  })
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
  const [latestCompletion] = await db
    .select({ completedAt: taskInstances.completedAt })
    .from(taskInstances)
    .where(
      and(
        eq(taskInstances.taskId, taskId),
        isNotNull(taskInstances.completedAt),
      ),
    )
    .orderBy(desc(taskInstances.completedAt))
    .limit(1)
  const [openInst] = await db
    .select({ id: taskInstances.id })
    .from(taskInstances)
    .where(
      and(
        eq(taskInstances.taskId, taskId),
        isNull(taskInstances.completedAt),
        isNull(taskInstances.skippedAt),
      ),
    )
    .limit(1)
  return {
    id: row.id,
    title: row.title,
    notes: row.notes,
    difficulty: row.difficulty as Difficulty,
    xpOverride: row.xpOverride,
    recurrence: row.recurrence,
    timeOfDay: row.timeOfDay,
    timeByWeekday: row.timeByWeekday ?? null,
    categorySlug: row.categorySlug,
    snoozeUntil: row.snoozeUntil?.toISOString() ?? null,
    active: row.active,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
    visibility: row.visibility as TaskVisibility,
    dueKind: row.dueKind as 'hard' | 'week_target',
    lastCompletedAt: latestCompletion?.completedAt
      ? latestCompletion.completedAt.toISOString()
      : null,
    hasOpenInstance: !!openInst,
    householdId: row.householdId,
    assignedToUserId: row.assignedToUserId,
    assigneeGroup: row.assigneeGroup,
    rotationStrategy: row.rotationStrategy as 'fixed' | 'round_robin',
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
    // Override map is meaningless without a base time; clear it if the task
    // becomes anytime/someday.
    timeByWeekday: input.timeOfDay ? (input.timeByWeekday ?? null) : null,
    updatedAt: new Date(),
  }
  if (input.visibility !== undefined) {
    setValues.visibility = input.visibility
  }
  if (input.dueKind !== undefined) {
    setValues.dueKind = input.dueKind === 'week_target' ? 'week_target' : 'hard'
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

// Wipe the user's current todo list while preserving history.
// Hard-deletes pending instances, then soft-deletes active tasks (active=false
// also stops recurring tasks from materializing new instances in
// completeInstance). Events / progression / tokens / categories untouched.
export async function resetTasks(
  userId: string,
): Promise<{ deletedInstances: number; deactivatedTasks: number }> {
  return db.transaction(async (tx) => {
    const deletedInstances = await tx
      .delete(taskInstances)
      .where(
        and(
          eq(taskInstances.userId, userId),
          isNull(taskInstances.completedAt),
          isNull(taskInstances.skippedAt),
        ),
      )
      .returning({ id: taskInstances.id })

    const deactivatedTasks = await tx
      .update(tasks)
      .set({ active: false, updatedAt: new Date() })
      .where(and(eq(tasks.userId, userId), eq(tasks.active, true)))
      .returning({ id: tasks.id })

    // Drop the cached coach blurb — its signature is for tasks that no
    // longer exist, and we don't want the next coach load to reference
    // them. The next read will regenerate against the empty list.
    await tx
      .delete(coachSummaries)
      .where(eq(coachSummaries.userId, userId))

    return {
      deletedInstances: deletedInstances.length,
      deactivatedTasks: deactivatedTasks.length,
    }
  })
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

// Move an existing personal task into a household. The point is to
// "promote" a task you've been doing personally for a while (with
// real completion history) so the rest of the family can see it on
// the household chore list — without losing the historical events.
//
// Historical task.completed events stay associated with the task by
// `payload.taskId`, but they don't get a `householdId` retroactively;
// they still count for the user's personal progression / stats. Only
// completions AFTER the move land in the household stats charts and
// activity feed. That's the right semantics: moving the task forward
// doesn't claim past work as "household activity."
//
// Owner-only operation. The new household must be one the owner is
// in. Kids/kiosks can't move tasks (they can't create chores
// either). assignee is optional — null = free-for-all; otherwise
// must be the caller (members) or any member (admins).
export async function moveTaskToHousehold(
  userId: string,
  input: {
    taskId: string
    householdId: string
    assignedToUserId?: string | null
    assigneeGroup?: 'adults' | 'kids' | null
  },
): Promise<{ id: string }> {
  if (!input.taskId) throw new Error('taskId required')
  if (!input.householdId) throw new Error('householdId required')

  return db.transaction(async (tx) => {
    const task = await tx.query.tasks.findFirst({
      where: and(eq(tasks.id, input.taskId), eq(tasks.userId, userId)),
    })
    if (!task) throw new Error('task not found')
    if (task.householdId) {
      throw new Error('That task is already in a household.')
    }

    const membership = await tx.query.householdMembers.findFirst({
      where: and(
        eq(householdMembers.userId, userId),
        eq(householdMembers.householdId, input.householdId),
      ),
      columns: { role: true },
    })
    if (!membership) {
      throw new Error('You are not a member of that household.')
    }
    if (membership.role === 'kid' || membership.role === 'kiosk') {
      throw new Error('Kids and kiosk accounts cannot move tasks.')
    }

    // Resolve assignee. Reuses the createTask rules.
    let assignedToUserId: string | null = null
    let assigneeGroup: 'adults' | 'kids' | null = null
    if (input.assigneeGroup) {
      // Group ("any adult" / "any kid") — free-for-all within a role.
      // Admins and members may both set it; mutually exclusive with a
      // specific assignee.
      if (input.assigneeGroup !== 'adults' && input.assigneeGroup !== 'kids') {
        throw new Error('Invalid assignee group.')
      }
      if (input.assignedToUserId) {
        throw new Error('Pick either a specific person or a group, not both.')
      }
      assigneeGroup = input.assigneeGroup
    } else if (input.assignedToUserId) {
      if (input.assignedToUserId === userId) {
        assignedToUserId = userId
      } else {
        // Any adult may assign to any household member (admin-only gate
        // removed); just validate the assignee is in the household.
        const assignee = await tx.query.householdMembers.findFirst({
          where: and(
            eq(householdMembers.userId, input.assignedToUserId),
            eq(householdMembers.householdId, input.householdId),
          ),
          columns: { userId: true },
        })
        if (!assignee) {
          throw new Error('Assignee is not a member of this household.')
        }
        assignedToUserId = input.assignedToUserId
      }
    }

    const now = new Date()
    await tx
      .update(tasks)
      .set({
        householdId: input.householdId,
        assignedToUserId,
        assigneeGroup,
        updatedAt: now,
      })
      .where(eq(tasks.id, task.id))

    // Mirror the move onto every open instance so the task appears
    // in the household chores list / week view immediately. Closed
    // (completed/skipped) instances stay as historical rows with
    // their original null household — those events are personal
    // history.
    await tx
      .update(taskInstances)
      .set({
        householdId: input.householdId,
        assignedToUserId,
        assigneeGroup,
      })
      .where(
        and(
          eq(taskInstances.taskId, task.id),
          isNull(taskInstances.completedAt),
          isNull(taskInstances.skippedAt),
        ),
      )

    return { id: task.id }
  })
}

// Change who an existing household chore is assigned to. Mirrors the
// assignee rules used by createTask / moveTaskToHousehold: any adult
// (admin or member) may assign to any household member, a role group, or
// free-for-all.
// Permission to reassign at all: the chore's creator OR a household
// admin. Round-robin chores are excluded — their assignee is driven by
// the rotation, so reassigning here would be undone on the next
// recurrence.
export async function reassignHouseholdTask(
  userId: string,
  input: {
    taskId: string
    assignedToUserId?: string | null
    assigneeGroup?: 'adults' | 'kids' | null
  },
): Promise<{ id: string }> {
  if (!input.taskId) throw new Error('taskId required')

  return db.transaction(async (tx) => {
    const task = await tx.query.tasks.findFirst({
      where: eq(tasks.id, input.taskId),
    })
    if (!task) throw new Error('task not found')
    if (!task.householdId) {
      throw new Error('That task is not a household chore.')
    }
    if (task.rotationStrategy === 'round_robin') {
      throw new Error(
        'Round-robin chores rotate automatically and can’t be reassigned here.',
      )
    }

    const membership = await tx.query.householdMembers.findFirst({
      where: and(
        eq(householdMembers.userId, userId),
        eq(householdMembers.householdId, task.householdId),
      ),
      columns: { role: true },
    })
    if (!membership) {
      throw new Error('You are not a member of this household.')
    }
    const isCreator = task.userId === userId
    const isAdmin = membership.role === 'admin'
    if (!isCreator && !isAdmin) {
      throw new Error(
        'Only the chore’s creator or a household admin can reassign it.',
      )
    }

    // Resolve the new assignment. Same rules as createTask.
    let assignedToUserId: string | null = null
    let assigneeGroup: 'adults' | 'kids' | null = null
    if (input.assigneeGroup) {
      if (input.assigneeGroup !== 'adults' && input.assigneeGroup !== 'kids') {
        throw new Error('Invalid assignee group.')
      }
      if (input.assignedToUserId) {
        throw new Error('Pick either a specific person or a group, not both.')
      }
      assigneeGroup = input.assigneeGroup
    } else if (input.assignedToUserId) {
      if (input.assignedToUserId === userId) {
        assignedToUserId = userId
      } else {
        // Any adult may reassign to any household member; just validate
        // the assignee belongs to this household.
        const assignee = await tx.query.householdMembers.findFirst({
          where: and(
            eq(householdMembers.userId, input.assignedToUserId),
            eq(householdMembers.householdId, task.householdId),
          ),
          columns: { userId: true },
        })
        if (!assignee) {
          throw new Error('Assignee is not a member of this household.')
        }
        assignedToUserId = input.assignedToUserId
      }
    }

    await tx
      .update(tasks)
      .set({ assignedToUserId, assigneeGroup, updatedAt: new Date() })
      .where(eq(tasks.id, task.id))

    // Mirror onto every open instance so the change shows up immediately
    // in today / household views. Closed instances stay as history.
    await tx
      .update(taskInstances)
      .set({ assignedToUserId, assigneeGroup })
      .where(
        and(
          eq(taskInstances.taskId, task.id),
          isNull(taskInstances.completedAt),
          isNull(taskInstances.skippedAt),
        ),
      )

    return { id: task.id }
  })
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

  // Build the per-user/household visibility predicate. Personal tasks
  // (household_id IS NULL) always show for their creator. When the
  // user is in a household and the merge toggle is on, also include
  // household chores assigned to them and unclaimed free-for-all chores.
  const prefsRow = await db.query.userPrefs.findFirst({
    where: eq(userPrefs.userId, userId),
    columns: { mergeHouseholdIntoToday: true },
  })
  const mergePref = prefsRow?.mergeHouseholdIntoToday ?? true
  const myMembership = mergePref
    ? await db.query.householdMembers.findFirst({
        where: eq(householdMembers.userId, userId),
        columns: { householdId: true, role: true },
      })
    : null
  // Unassigned household chores (specific assignee is null) show to the
  // viewer when the chore's group is open to their role: plain
  // free-for-all and "any kid" chores show to everyone; "any adult"
  // chores are hidden from kids (who also can't complete them).
  const openToMe =
    myMembership?.role === 'kid'
      ? and(
          isNull(taskInstances.assignedToUserId),
          or(
            isNull(taskInstances.assigneeGroup),
            eq(taskInstances.assigneeGroup, 'kids'),
          ),
        )
      : isNull(taskInstances.assignedToUserId)
  const visibility = myMembership
    ? or(
        and(eq(taskInstances.userId, userId), isNull(taskInstances.householdId)),
        and(
          eq(taskInstances.householdId, myMembership.householdId),
          or(eq(taskInstances.assignedToUserId, userId), openToMe),
        ),
      )
    : and(eq(taskInstances.userId, userId), isNull(taskInstances.householdId))

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
      dueKind: taskInstances.dueKind,
      snoozedUntil: taskInstances.snoozedUntil,
      createdAt: tasks.createdAt,
      householdId: taskInstances.householdId,
      assignedToUserId: taskInstances.assignedToUserId,
      assigneeGroup: taskInstances.assigneeGroup,
    })
    .from(taskInstances)
    .innerJoin(tasks, eq(tasks.id, taskInstances.taskId))
    .where(
      and(
        visibility,
        isNull(taskInstances.completedAt),
        isNull(taskInstances.skippedAt),
        // Pending kid-claims also drop out of Today so the kid sees
        // them disappear once they tap Complete (toast covers the
        // outcome) and adults aren't nagged by their own assigned
        // chores that are currently in review.
        isNull(taskInstances.claimedAt),
        isNotNull(taskInstances.dueAt),
        // Hard-deadline tasks appear only inside today's window or once
        // overdue. Week-target tasks live in the list from creation
        // through their target day (and remain visible after, as overdue)
        // so the user can pick them up early — that's the whole point.
        or(
          lt(taskInstances.dueAt, horizon),
          eq(taskInstances.dueKind, 'week_target'),
        ),
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
    dueKind: r.dueKind as 'hard' | 'week_target',
    householdId: r.householdId,
    assignedToUserId: r.assignedToUserId,
    assigneeGroup: r.assigneeGroup as 'adults' | 'kids' | null,
  }))
}

export interface HouseholdChoreRow {
  instanceId: string
  taskId: string
  title: string
  difficulty: Difficulty
  xpOverride: number | null
  dueAt: string | null
  dueKind: 'hard' | 'week_target'
  assignedToUserId: string | null
  assignedToHandle: string | null
  assignedToName: string | null
  assigneeGroup: 'adults' | 'kids' | null
  createdByUserId: string
  categorySlug: string | null
  recurring: boolean
}

// All open chores (not completed, not skipped) for a household, ordered
// by due date. Free-for-all chores have a null assignedToUserId. Caller
// must be a household member; permission is checked by the server-
// function layer via the household role helper.
export async function listHouseholdChores(
  viewerId: string,
  householdId: string,
): Promise<HouseholdChoreRow[]> {
  const m = await db.query.householdMembers.findFirst({
    where: and(
      eq(householdMembers.userId, viewerId),
      eq(householdMembers.householdId, householdId),
    ),
    columns: { userId: true },
  })
  if (!m) throw new Error('Not a member of this household.')

  const rows = await db
    .select({
      instanceId: taskInstances.id,
      taskId: tasks.id,
      title: tasks.title,
      difficulty: tasks.difficulty,
      xpOverride: tasks.xpOverride,
      instanceXpOverride: taskInstances.xpOverride,
      dueAt: taskInstances.dueAt,
      dueKind: taskInstances.dueKind,
      assignedToUserId: taskInstances.assignedToUserId,
      assignedToHandle: userTable.handle,
      assignedToName: userTable.name,
      assigneeGroup: taskInstances.assigneeGroup,
      createdByUserId: tasks.userId,
      categorySlug: tasks.categorySlug,
      recurrence: tasks.recurrence,
    })
    .from(taskInstances)
    .innerJoin(tasks, eq(tasks.id, taskInstances.taskId))
    .leftJoin(userTable, eq(userTable.id, taskInstances.assignedToUserId))
    .where(
      and(
        eq(taskInstances.householdId, householdId),
        isNull(taskInstances.completedAt),
        isNull(taskInstances.skippedAt),
        // Hide claimed-but-not-approved chores from the open list —
        // they live exclusively in the Pending review tab for adults.
        isNull(taskInstances.claimedAt),
        eq(tasks.active, true),
      ),
    )
    .orderBy(taskInstances.dueAt)

  return rows.map((r) => ({
    instanceId: r.instanceId,
    taskId: r.taskId,
    title: r.title,
    difficulty: r.difficulty as Difficulty,
    xpOverride: r.instanceXpOverride ?? r.xpOverride,
    dueAt: r.dueAt?.toISOString() ?? null,
    dueKind: r.dueKind as 'hard' | 'week_target',
    assignedToUserId: r.assignedToUserId,
    assignedToHandle: r.assignedToHandle,
    assignedToName: r.assignedToName,
    assigneeGroup: r.assigneeGroup as 'adults' | 'kids' | null,
    createdByUserId: r.createdByUserId,
    categorySlug: r.categorySlug,
    recurring: r.recurrence !== null,
  }))
}

export interface PendingApprovalRow {
  instanceId: string
  taskId: string
  title: string
  difficulty: Difficulty
  xpOverride: number | null
  dueAt: string | null
  claimedAt: string
  claimedByUserId: string
  claimedByName: string | null
  claimedByHandle: string | null
  assignedToUserId: string | null
  assignedToName: string | null
  assignedToHandle: string | null
  recurring: boolean
}

// Pending kid-claims awaiting adult approval. Returned only to
// non-kid household members — kids never see this list. Surfaced as
// the Pending review tab on /household.
export async function listPendingApprovals(
  viewerId: string,
  householdId: string,
): Promise<PendingApprovalRow[]> {
  const m = await db.query.householdMembers.findFirst({
    where: and(
      eq(householdMembers.userId, viewerId),
      eq(householdMembers.householdId, householdId),
    ),
    columns: { role: true },
  })
  if (!m) throw new Error('Not a household member.')
  if (m.role === 'kid' || m.role === 'kiosk') {
    // Kids and kiosks can't review pending claims — only admins and
    // members can approve/reject.
    return []
  }

  // Two-join shape: one for claimer, one for assignee (different users).
  // Drizzle alias trick — use a sub-select for the claimer to avoid
  // duplicate `user` aliases. We just run two passes: pull rows
  // (with assignee join) then enrich with claimer display info in JS.
  const rows = await db
    .select({
      id: taskInstances.id,
      taskId: tasks.id,
      title: tasks.title,
      difficulty: tasks.difficulty,
      xpOverride: tasks.xpOverride,
      instanceXpOverride: taskInstances.xpOverride,
      dueAt: taskInstances.dueAt,
      claimedAt: taskInstances.claimedAt,
      claimedByUserId: taskInstances.claimedByUserId,
      assignedToUserId: taskInstances.assignedToUserId,
      assigneeHandle: userTable.handle,
      assigneeName: userTable.name,
      recurrence: tasks.recurrence,
    })
    .from(taskInstances)
    .innerJoin(tasks, eq(tasks.id, taskInstances.taskId))
    .leftJoin(userTable, eq(userTable.id, taskInstances.assignedToUserId))
    .where(
      and(
        eq(taskInstances.householdId, householdId),
        isNotNull(taskInstances.claimedAt),
        isNull(taskInstances.completedAt),
        isNull(taskInstances.skippedAt),
        eq(tasks.active, true),
      ),
    )
    .orderBy(taskInstances.claimedAt)

  if (rows.length === 0) return []

  const claimerIds = Array.from(
    new Set(
      rows.map((r) => r.claimedByUserId).filter((x): x is string => !!x),
    ),
  )
  const claimerRows =
    claimerIds.length > 0
      ? await db
          .select({
            id: userTable.id,
            handle: userTable.handle,
            name: userTable.name,
          })
          .from(userTable)
          .where(inArray(userTable.id, claimerIds))
      : []
  const claimerById = new Map(claimerRows.map((u) => [u.id, u]))

  return rows.map((r) => {
    const claimer = r.claimedByUserId
      ? claimerById.get(r.claimedByUserId) ?? null
      : null
    return {
      instanceId: r.id,
      taskId: r.taskId,
      title: r.title,
      difficulty: r.difficulty as Difficulty,
      xpOverride: r.instanceXpOverride ?? r.xpOverride,
      dueAt: r.dueAt?.toISOString() ?? null,
      claimedAt: r.claimedAt!.toISOString(),
      claimedByUserId: r.claimedByUserId ?? '',
      claimedByName: claimer?.name ?? null,
      claimedByHandle: claimer?.handle ?? null,
      assignedToUserId: r.assignedToUserId,
      assignedToName: r.assigneeName,
      assignedToHandle: r.assigneeHandle,
      recurring: r.recurrence !== null,
    }
  })
}

// Approve a pending kid-claim — promotes it to a normal completion.
// XP and streak credit go to the claimer (the kid). Writes a
// task.completed event, materializes the next recurrence instance,
// updates progression. Mirrors the post-permission-gate portion of
// completeInstance.
export async function approveClaim(
  approverId: string,
  instanceId: string,
): Promise<CompleteInstanceResult> {
  if (!instanceId) throw new Error('instanceId required')
  const now = new Date()

  const txResult = await db.transaction(async (tx) => {
    const instance = await tx.query.taskInstances.findFirst({
      where: eq(taskInstances.id, instanceId),
    })
    if (!instance) throw new Error('instance not found')
    if (instance.completedAt || instance.skippedAt) {
      return { alreadyHandled: true as const }
    }
    if (!instance.claimedAt || !instance.claimedByUserId) {
      throw new Error('Nothing to approve — instance is not in a pending claim state.')
    }
    if (!instance.householdId) {
      throw new Error('Pending approval is a household-only flow.')
    }
    const membership = await tx.query.householdMembers.findFirst({
      where: and(
        eq(householdMembers.userId, approverId),
        eq(householdMembers.householdId, instance.householdId),
      ),
      columns: { role: true },
    })
    if (!membership) throw new Error('not a household member')
    if (membership.role === 'kid' || membership.role === 'kiosk') {
      throw new Error(
        'Only admins or members can approve a pending claim.',
      )
    }

    const task = await tx.query.tasks.findFirst({
      where: eq(tasks.id, instance.taskId),
    })
    if (!task) throw new Error('task missing')

    const xpRecipientId = instance.claimedByUserId

    // Promote the claim to a completion. Same race-safe predicate
    // protects against double-approve.
    const updated = await tx
      .update(taskInstances)
      .set({
        completedAt: now,
        completedByUserId: xpRecipientId,
        claimedAt: null,
        claimedByUserId: null,
      })
      .where(
        and(
          eq(taskInstances.id, instance.id),
          isNotNull(taskInstances.claimedAt),
          isNull(taskInstances.completedAt),
          isNull(taskInstances.skippedAt),
        ),
      )
      .returning({ id: taskInstances.id })
    if (updated.length === 0) {
      return { alreadyHandled: true as const }
    }

    const effectiveXpOverride = instance.xpOverride ?? task.xpOverride
    const dueKind: 'hard' | 'week_target' =
      instance.dueKind === 'week_target' ? 'week_target' : 'hard'
    const completedAs: 'assigned' | 'free_for_all' = instance.assignedToUserId
      ? 'assigned'
      : 'free_for_all'

    // Record the time that actually applied to this occurrence's weekday, so
    // punctuality scoring and timing stats compare against the right clock time
    // for per-weekday schedules (and replay stays deterministic).
    const recipientTimeZone = await getUserTimeZone(xpRecipientId)
    const scheduledTimeOfDay = task.timeOfDay
      ? resolveTimeOfDay(
          dayOfWeekInTz(instance.dueAt ?? now, recipientTimeZone),
          task.timeOfDay,
          task.timeByWeekday,
        )
      : null

    // The claimer is the kid, so this is where their chore-completion
    // tokens accrue (1 every Nth approved chore).
    const tokensEarned = await kidCompletionTokens(
      tx,
      xpRecipientId,
      instance.householdId,
    )

    const event: DomainEvent = {
      type: 'task.completed',
      taskId: task.id,
      instanceId: instance.id,
      difficulty: task.difficulty as Difficulty,
      xpOverride: effectiveXpOverride,
      dueAt: instance.dueAt,
      timeOfDay: scheduledTimeOfDay,
      dueKind,
      householdId: instance.householdId,
      assignedToUserId: instance.assignedToUserId,
      completedAs,
      tokensEarned,
      occurredAt: now,
    }
    await tx.insert(events).values({
      userId: xpRecipientId,
      type: event.type,
      payload: {
        taskId: event.taskId,
        instanceId: event.instanceId,
        difficulty: event.difficulty,
        xpOverride: event.xpOverride,
        dueAt: event.dueAt?.toISOString() ?? null,
        timeOfDay: event.timeOfDay,
        dueKind,
        householdId: event.householdId ?? null,
        assignedToUserId: event.assignedToUserId ?? null,
        completedAs: event.completedAs,
        tokensEarned: event.tokensEarned ?? 0,
      },
      occurredAt: now,
    })

    const current = await tx.query.progression.findFirst({
      where: eq(progression.userId, xpRecipientId),
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
    const next = applyEvent(prevState, event, { timeZone: recipientTimeZone })
    await tx
      .insert(progression)
      .values({
        userId: xpRecipientId,
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
        timeByWeekday: task.timeByWeekday,
        timeZone: recipientTimeZone,
        quietHoursEnd: await getUserQuietHoursEnd(xpRecipientId),
      })
      const snoozedUntil = nextDue > now ? nextDue : null
      const nextAssignee = await resolveNextRecurrenceAssignee(tx, task)
      const [inst] = await tx
        .insert(taskInstances)
        .values({
          taskId: task.id,
          userId: task.userId,
          dueAt: nextDue,
          snoozedUntil,
          householdId: task.householdId,
          assignedToUserId: nextAssignee,
          assigneeGroup: task.assigneeGroup,
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
  })

  if ('alreadyHandled' in txResult && txResult.alreadyHandled) {
    return { alreadyHandled: true }
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

// Reject a pending claim — clears claimedAt + claimedByUserId. The
// instance returns to its open state (and reappears in the kid's
// chore list / Today). No event is written; rejection is silent.
export async function rejectClaim(
  approverId: string,
  instanceId: string,
): Promise<{ ok: true } | { alreadyHandled: true }> {
  if (!instanceId) throw new Error('instanceId required')
  return db.transaction(async (tx) => {
    const instance = await tx.query.taskInstances.findFirst({
      where: eq(taskInstances.id, instanceId),
    })
    if (!instance) throw new Error('instance not found')
    if (!instance.claimedAt || !instance.householdId) {
      return { alreadyHandled: true as const }
    }
    const membership = await tx.query.householdMembers.findFirst({
      where: and(
        eq(householdMembers.userId, approverId),
        eq(householdMembers.householdId, instance.householdId),
      ),
      columns: { role: true },
    })
    if (!membership) throw new Error('not a household member')
    if (membership.role === 'kid' || membership.role === 'kiosk') {
      throw new Error('Only admins or members can reject a pending claim.')
    }
    await tx
      .update(taskInstances)
      .set({ claimedAt: null, claimedByUserId: null })
      .where(eq(taskInstances.id, instance.id))
    return { ok: true as const }
  })
}

// Weekly view of a household's chores. Returns every materialized
// instance in the 7-day window plus *projected* future occurrences for
// recurring tasks (via computeNextDue) so a Mon/Wed/Fri chore shows up
// on all three days even though only one open instance exists at a
// time.
//
// Projections have instanceId=null and are informational: the UI
// disables the complete button until the day rolls around and the
// instance actually materializes.
//
// after_completion recurrences are excluded from projection because
// their next due date depends on when the user finishes the current
// instance — we can only show what's already materialized.
export interface WeekChoreOccurrence {
  // null for a not-yet-materialized projection.
  instanceId: string | null
  taskId: string
  title: string
  difficulty: Difficulty
  xpOverride: number | null
  dueAt: string
  timeOfDay: string | null
  // ISO yyyy-MM-dd in the viewer's tz — the day "bucket" this
  // occurrence belongs to. Stable on the wire so the UI doesn't have
  // to re-derive timezone math.
  localDay: string
  assignedToUserId: string | null
  assignedToHandle: string | null
  assignedToName: string | null
  assigneeGroup: 'adults' | 'kids' | null
  recurring: boolean
  // null for projections and open instances; set to the completer's id
  // for instances that were already done in-window.
  completedAt: string | null
  completedByUserId: string | null
  skippedAt: string | null
}

const PROJECTION_MAX_ITERATIONS_PER_TASK = 30

export async function listHouseholdChoresWeek(
  viewerId: string,
  householdId: string,
  startDateLocal: string,
): Promise<WeekChoreOccurrence[]> {
  const m = await db.query.householdMembers.findFirst({
    where: and(
      eq(householdMembers.userId, viewerId),
      eq(householdMembers.householdId, householdId),
    ),
    columns: { userId: true },
  })
  if (!m) throw new Error('Not a member of this household.')

  const timeZone = await getUserTimeZone(viewerId)
  // So the week preview anchors "anytime" daily chores to the same morning
  // slot they'll actually materialize into (see computeNextDue).
  const quietHoursEnd = await getUserQuietHoursEnd(viewerId)

  // Resolve the week window as UTC instants. The start is local
  // midnight of startDateLocal in the viewer's tz; end is +7 days.
  if (!/^\d{4}-\d{2}-\d{2}$/.test(startDateLocal)) {
    throw new Error('startDateLocal must be yyyy-MM-dd')
  }
  const weekStart = fromZonedTime(`${startDateLocal} 00:00:00`, timeZone)
  const weekEnd = new Date(weekStart.getTime() + 7 * 24 * 3_600_000)

  // 1) Load every active task that belongs to this household.
  const taskRows = await db
    .select({
      id: tasks.id,
      title: tasks.title,
      difficulty: tasks.difficulty,
      xpOverride: tasks.xpOverride,
      timeOfDay: tasks.timeOfDay,
      timeByWeekday: tasks.timeByWeekday,
      recurrence: tasks.recurrence,
      assignedToUserId: tasks.assignedToUserId,
      assigneeGroup: tasks.assigneeGroup,
    })
    .from(tasks)
    .where(
      and(eq(tasks.householdId, householdId), eq(tasks.active, true)),
    )

  if (taskRows.length === 0) return []
  const taskIds = taskRows.map((t) => t.id)
  const taskById = new Map(taskRows.map((t) => [t.id, t]))

  // 2) Pull every instance for those tasks in the window (open,
  //    completed, or skipped). We need completed/skipped so the day
  //    shows "✓ done by Alice" rather than re-projecting an extra
  //    slot. Also pull instances slightly before the window so we can
  //    anchor projection from the most recent known occurrence.
  const lookback = new Date(weekStart.getTime() - 8 * 24 * 3_600_000)
  const instanceRows = await db
    .select({
      id: taskInstances.id,
      taskId: taskInstances.taskId,
      dueAt: taskInstances.dueAt,
      completedAt: taskInstances.completedAt,
      completedByUserId: taskInstances.completedByUserId,
      skippedAt: taskInstances.skippedAt,
      claimedAt: taskInstances.claimedAt,
      assignedToUserId: taskInstances.assignedToUserId,
      xpOverride: taskInstances.xpOverride,
    })
    .from(taskInstances)
    .where(
      and(
        inArray(taskInstances.taskId, taskIds),
        isNotNull(taskInstances.dueAt),
        gte(taskInstances.dueAt, lookback),
        lt(taskInstances.dueAt, weekEnd),
      ),
    )

  // Resolve assignee display info for every assignedToUserId we might
  // render (instance-level or task-level fallback).
  const assigneeIds = Array.from(
    new Set(
      [
        ...instanceRows.map((i) => i.assignedToUserId),
        ...taskRows.map((t) => t.assignedToUserId),
      ].filter((x): x is string => x !== null),
    ),
  )
  const assigneeRows =
    assigneeIds.length > 0
      ? await db
          .select({
            id: userTable.id,
            handle: userTable.handle,
            name: userTable.name,
          })
          .from(userTable)
          .where(inArray(userTable.id, assigneeIds))
      : []
  const assigneeById = new Map(assigneeRows.map((a) => [a.id, a]))

  function localDayKey(date: Date): string {
    return formatInTimeZone(date, timeZone, 'yyyy-MM-dd')
  }

  const out: WeekChoreOccurrence[] = []
  const instancesByTask = new Map<string, typeof instanceRows>()
  for (const inst of instanceRows) {
    const arr = instancesByTask.get(inst.taskId) ?? []
    arr.push(inst)
    instancesByTask.set(inst.taskId, arr)
  }

  // 3) Emit materialized instances within the window, with one
  //    exception: pending claims (claimedAt set but not yet
  //    completed/skipped) are hidden from the week view. They live
  //    exclusively in the Pending review tab so adults aren't seeing
  //    "kid says it's done" twice in two places.
  for (const inst of instanceRows) {
    if (!inst.dueAt) continue
    if (inst.dueAt < weekStart) continue
    if (inst.claimedAt && !inst.completedAt && !inst.skippedAt) continue
    const t = taskById.get(inst.taskId)
    if (!t) continue
    const assigneeId = inst.assignedToUserId
    const assignee = assigneeId ? assigneeById.get(assigneeId) : null
    out.push({
      instanceId: inst.id,
      taskId: t.id,
      title: t.title,
      difficulty: t.difficulty as Difficulty,
      xpOverride: inst.xpOverride ?? t.xpOverride,
      dueAt: inst.dueAt.toISOString(),
      timeOfDay: t.timeOfDay,
      localDay: localDayKey(inst.dueAt),
      assignedToUserId: assigneeId,
      assignedToHandle: assignee?.handle ?? null,
      assignedToName: assignee?.name ?? null,
      assigneeGroup: t.assigneeGroup,
      recurring: t.recurrence !== null,
      completedAt: inst.completedAt?.toISOString() ?? null,
      completedByUserId: inst.completedByUserId,
      skippedAt: inst.skippedAt?.toISOString() ?? null,
    })
  }

  // 4) For each recurring task (excluding after_completion), project
  //    future occurrences into the window. Skip slots that already have
  //    a materialized instance nearby (same local day + same hh:mm)
  //    so we don't double-count.
  for (const t of taskRows) {
    if (!t.recurrence) continue
    if (t.recurrence.type === 'after_completion') continue

    const taskInstancesArr = instancesByTask.get(t.id) ?? []
    const occupiedSlots = new Set(
      taskInstancesArr.map((i) =>
        i.dueAt ? `${localDayKey(i.dueAt)}T${formatInTimeZone(i.dueAt, timeZone, 'HH:mm')}` : '',
      ),
    )

    // Anchor: the latest known instance's dueAt (if any), or first
    // occurrence on/after the window start. computeNextDue advances
    // strictly one cycle, so we feed it the anchor and iterate.
    const latest = taskInstancesArr
      .map((i) => i.dueAt)
      .filter((d): d is Date => d instanceof Date)
      .sort((a, b) => b.getTime() - a.getTime())[0]

    let cursor: Date | null = latest ?? null
    if (!cursor) {
      // No instance to anchor from — find the first scheduled occurrence
      // on or after weekStart. firstDueAt expects `now`; pass weekStart -
      // 1ms so the result includes weekStart itself.
      const candidate = firstDueAt({
        now: new Date(weekStart.getTime() - 1),
        recurrence: t.recurrence,
        timeOfDay: t.timeOfDay,
        timeByWeekday: t.timeByWeekday,
        timeZone,
        someday: false,
      })
      if (candidate && candidate < weekEnd) {
        // Push it directly if it lands in-window — there's no materialized
        // instance to conflict with by definition (taskInstancesArr empty).
        if (candidate >= weekStart) {
          const slotKey = `${localDayKey(candidate)}T${formatInTimeZone(candidate, timeZone, 'HH:mm')}`
          if (!occupiedSlots.has(slotKey)) {
            out.push(buildProjection(t, candidate, assigneeById, timeZone))
            occupiedSlots.add(slotKey)
          }
        }
        cursor = candidate
      }
    }

    if (!cursor) continue

    for (let iter = 0; iter < PROJECTION_MAX_ITERATIONS_PER_TASK; iter++) {
      const next: Date = computeNextDue({
        recurrence: t.recurrence,
        previousDueAt: cursor,
        completedAt: cursor,
        timeOfDay: t.timeOfDay,
        timeByWeekday: t.timeByWeekday,
        timeZone,
        quietHoursEnd,
      })
      if (!next || next <= cursor) break
      cursor = next
      if (next >= weekEnd) break
      if (next < weekStart) continue
      const slotKey = `${localDayKey(next)}T${formatInTimeZone(next, timeZone, 'HH:mm')}`
      if (occupiedSlots.has(slotKey)) continue
      out.push(buildProjection(t, next, assigneeById, timeZone))
      occupiedSlots.add(slotKey)
    }
  }

  // 5) Sort by due time so the UI can group by day in one pass.
  out.sort((a, b) => a.dueAt.localeCompare(b.dueAt))
  return out
}

// Walk a rotation pool forward from `cursor` and return the next
// user id that's still a valid member of `validUserIds`. Wraps
// around. Returns null if no pool member is currently valid (e.g.
// they all left the household). Callers fall back to keeping the
// existing assignee in that edge case.
function nextRotationAssignee(
  pool: ReadonlyArray<string>,
  cursor: string | null,
  validUserIds: ReadonlySet<string>,
): string | null {
  if (pool.length === 0) return null
  const cursorIdx = cursor ? pool.indexOf(cursor) : -1
  for (let i = 1; i <= pool.length; i++) {
    const idx =
      ((cursorIdx === -1 ? -1 : cursorIdx) + i + pool.length) % pool.length
    const candidate = pool[idx]
    if (validUserIds.has(candidate)) return candidate
  }
  return null
}

// Resolve which user gets the next materialized instance of a
// recurring task. For fixed-strategy tasks (the default) this is
// just `task.assignedToUserId`. For round_robin, walk the rotation
// pool past `task.lastAssigneeCursor` and update the cursor on the
// parent task row so the *next* recurrence advances one more step.
// Falls back to the existing assignee if every pool member has left
// the household.
async function resolveNextRecurrenceAssignee(
  tx: Parameters<Parameters<typeof db.transaction>[0]>[0],
  task: {
    id: string
    householdId: string | null
    assignedToUserId: string | null
    rotationStrategy: 'fixed' | 'round_robin'
    rotationPool: string[] | null
    lastAssigneeCursor: string | null
  },
): Promise<string | null> {
  if (
    task.rotationStrategy !== 'round_robin' ||
    !task.rotationPool ||
    !task.householdId
  ) {
    return task.assignedToUserId
  }
  const members = await tx
    .select({ userId: householdMembers.userId })
    .from(householdMembers)
    .where(eq(householdMembers.householdId, task.householdId))
  const validIds = new Set(members.map((m) => m.userId))
  const next = nextRotationAssignee(
    task.rotationPool,
    task.lastAssigneeCursor,
    validIds,
  )
  if (!next) return task.assignedToUserId
  await tx
    .update(tasks)
    .set({ lastAssigneeCursor: next, updatedAt: new Date() })
    .where(eq(tasks.id, task.id))
  return next
}

function buildProjection(
  t: {
    id: string
    title: string
    difficulty: string
    xpOverride: number | null
    timeOfDay: string | null
    recurrence: Recurrence | null
    assignedToUserId: string | null
    assigneeGroup: 'adults' | 'kids' | null
  },
  dueAt: Date,
  assigneeById: Map<string, { id: string; handle: string; name: string }>,
  timeZone: string,
): WeekChoreOccurrence {
  const assignee = t.assignedToUserId
    ? assigneeById.get(t.assignedToUserId) ?? null
    : null
  return {
    instanceId: null,
    taskId: t.id,
    title: t.title,
    difficulty: t.difficulty as Difficulty,
    xpOverride: t.xpOverride,
    dueAt: dueAt.toISOString(),
    timeOfDay: t.timeOfDay,
    localDay: formatInTimeZone(dueAt, timeZone, 'yyyy-MM-dd'),
    assignedToUserId: t.assignedToUserId,
    assignedToHandle: assignee?.handle ?? null,
    assignedToName: assignee?.name ?? null,
    assigneeGroup: t.assigneeGroup,
    recurring: t.recurrence !== null,
    completedAt: null,
    completedByUserId: null,
    skippedAt: null,
  }
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

  return db.transaction(async (tx) => {
    const task = await tx.query.tasks.findFirst({
      where: eq(tasks.id, taskId),
      columns: { id: true, userId: true, householdId: true },
    })
    if (!task) throw new Error('task not found')

    // Latest completed instance for this task (any completer).
    const latest = await tx.query.taskInstances.findFirst({
      where: and(
        eq(taskInstances.taskId, taskId),
        isNotNull(taskInstances.completedAt),
      ),
      orderBy: (t, { desc: d }) => [d(t.completedAt)],
    })
    if (!latest) throw new Error('no completed instance to reopen')

    // Whose progression rolls back? Every credited recipient — one chore
    // can grant XP to several people ("we did it together"), so there may
    // be multiple task.completed events for this instance, each on a
    // different user. The events are the source of truth; the
    // completedByUserId stamp is just the primary anchor / legacy
    // fallback (older completions predate multi-credit and that column).
    const completionRows = await tx
      .select({ userId: events.userId })
      .from(events)
      .where(
        and(
          eq(events.type, 'task.completed'),
          sql`${events.payload}->>'instanceId' = ${latest.id}`,
        ),
      )
    const completerUserId = latest.completedByUserId ?? latest.userId
    const recipientIds =
      completionRows.length > 0
        ? Array.from(new Set(completionRows.map((r) => r.userId)))
        : [completerUserId]

    // Permission gate.
    //  - Personal task: only the task owner may reopen (existing rule).
    //  - Household chore: any credited recipient may reopen, AND any
    //    household admin may reopen (e.g. fixing a kid's accidental
    //    completion). The task creator is also allowed if they're a
    //    household admin via that path.
    let allowed = false
    if (!task.householdId) {
      allowed = task.userId === userId
    } else {
      if (recipientIds.includes(userId)) {
        allowed = true
      } else {
        const m = await tx.query.householdMembers.findFirst({
          where: and(
            eq(householdMembers.userId, userId),
            eq(householdMembers.householdId, task.householdId),
          ),
          columns: { role: true },
        })
        if (m?.role === 'admin') allowed = true
      }
    }
    if (!allowed) throw new Error('not authorized')

    // Drop the task.completed event for each recipient so the event log
    // stays the source of truth for progression, plus any cheer events
    // that landed on those completions (so cheer XP doesn't linger after
    // the original is gone).
    for (const recipientId of recipientIds) {
      await tx
        .delete(events)
        .where(
          and(
            eq(events.userId, recipientId),
            eq(events.type, 'task.cheered'),
            sql`${events.payload}->>'completionEventId' IN (
              SELECT id FROM ${events} WHERE ${events.userId} = ${recipientId}
                AND ${events.type} = 'task.completed'
                AND ${events.payload}->>'instanceId' = ${latest.id}
            )`,
          ),
        )
      await tx
        .delete(events)
        .where(
          and(
            eq(events.userId, recipientId),
            eq(events.type, 'task.completed'),
            sql`${events.payload}->>'instanceId' = ${latest.id}`,
          ),
        )
    }

    await tx
      .update(taskInstances)
      .set({ completedAt: null, completedByUserId: null })
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
            isNull(taskInstances.completedAt),
            isNull(taskInstances.skippedAt),
            gt(taskInstances.dueAt, latest.dueAt),
          ),
        )
    }

    for (const recipientId of recipientIds) {
      const recipientTimeZone = await getUserTimeZone(recipientId)
      await rebuildProgression(tx, recipientId, recipientTimeZone)
    }
    return { instanceId: latest.id }
  })
}

// "Do it again" — spawn a fresh open instance for a previously completed
// one-off task, preserving the prior completion event(s) and stats.
// Differs from reopenLastCompletion in that it does NOT touch the event
// log or rebuild progression; the new instance simply produces a new
// task.completed event when the user finishes it again.
export async function repeatTask(
  userId: string,
  taskId: string,
): Promise<{ instanceId: string; dueAt: Date | null }> {
  if (!taskId) throw new Error('taskId required')
  const timeZone = await getUserTimeZone(userId)
  const task = await db.query.tasks.findFirst({
    where: and(eq(tasks.id, taskId), eq(tasks.userId, userId)),
  })
  if (!task) throw new Error('task not found')
  if (task.recurrence) {
    throw new Error('Recurring tasks already auto-repeat on completion')
  }

  const open = await db
    .select({ id: taskInstances.id })
    .from(taskInstances)
    .where(
      and(
        eq(taskInstances.taskId, taskId),
        eq(taskInstances.userId, userId),
        isNull(taskInstances.completedAt),
        isNull(taskInstances.skippedAt),
      ),
    )
    .limit(1)
  if (open.length > 0) {
    throw new Error('Task already has an open instance')
  }

  const now = new Date()
  const dueAt = firstDueAt({
    now,
    recurrence: null,
    timeOfDay: task.timeOfDay,
    timeZone,
    someday: false,
  })

  const [inst] = await db
    .insert(taskInstances)
    .values({ taskId, userId, dueAt, dueKind: task.dueKind })
    .returning()

  if (dueAt && dueAt > now) {
    scheduleReminder(
      { taskInstanceId: inst.id, attempt: 1 },
      dueAt,
    ).catch((e) => console.error('scheduleReminder failed', e))
  }

  return { instanceId: inst.id, dueAt: inst.dueAt }
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
          dueKind: p['dueKind'] === 'week_target' ? 'week_target' : 'hard',
          // Preserve kid completion-tokens across replay (reopen rebuilds).
          tokensEarned:
            typeof p['tokensEarned'] === 'number'
              ? (p['tokensEarned'] as number)
              : 0,
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

// Kids earn arcade tokens by finishing chores instead of running focus
// sessions. Returns the tokens this completion grants the recipient: 1 on
// every KID_TOKENS_EVERY_N_COMPLETIONS-th chore for a kid, 0 for everyone
// else (adults earn tokens from focus time). Counts the recipient's prior
// task.completed events — this completion's row is not yet inserted, so the
// running tally drives the parity. Personal tasks (no household) never earn
// since only household members carry a 'kid' role.
async function kidCompletionTokens(
  tx: Parameters<Parameters<typeof db.transaction>[0]>[0],
  recipientId: string,
  householdId: string | null,
): Promise<number> {
  if (!householdId) return 0
  const membership = await tx.query.householdMembers.findFirst({
    where: and(
      eq(householdMembers.userId, recipientId),
      eq(householdMembers.householdId, householdId),
    ),
    columns: { role: true },
  })
  if (membership?.role !== 'kid') return 0
  const [row] = await tx
    .select({ n: count() })
    .from(events)
    .where(
      and(eq(events.userId, recipientId), eq(events.type, 'task.completed')),
    )
  const completionNumber = (row?.n ?? 0) + 1
  return completionNumber % KID_TOKENS_EVERY_N_COMPLETIONS === 0 ? 1 : 0
}

export interface AssignKidXpResult {
  xpAwarded: number
  tokensEarned: number
  newXp: number
  newLevel: number
}

// Manually grant a kid XP. Parents (admin/member) use this to reward
// off-app effort — it's modelled as an instant, already-completed chore so
// it reuses the whole event-sourced completion path: a `task.completed`
// event is written for the kid (events.userId = kid) and applied to their
// progression. The chosen amount is the *base* XP; like every completion it
// flows through the kid's streak multiplier (and counts toward their streak
// + arcade-token cadence). dueAt is null so punctuality is neutral (1.0).
export async function assignKidXp(
  assignerId: string,
  input: {
    kidUserId: string
    xp: number
    categorySlug?: string | null
    title?: string | null
  },
): Promise<AssignKidXpResult> {
  const xp = Math.trunc(input.xp)
  if (!Number.isFinite(xp) || xp < 1 || xp > 1000) {
    throw new Error('XP must be a whole number between 1 and 1000.')
  }
  if (!input.kidUserId) throw new Error('kidUserId required')

  // Assigner must be an adult (admin/member) in a household.
  const mine = await getMyMembership(assignerId)
  if (!mine || (mine.role !== 'admin' && mine.role !== 'member')) {
    throw new Error('Only household admins and members can assign points.')
  }
  const householdId = mine.householdId

  // Recipient must be a kid in the *same* household.
  const recipient = await db.query.householdMembers.findFirst({
    where: and(
      eq(householdMembers.userId, input.kidUserId),
      eq(householdMembers.householdId, householdId),
    ),
    columns: { role: true },
  })
  if (!recipient) throw new Error('Recipient is not in your household.')
  if (recipient.role !== 'kid') {
    throw new Error('Points can only be assigned to kids.')
  }

  const title = (input.title?.trim() || 'Bonus points').slice(0, 200)
  const categorySlug = input.categorySlug?.trim() || null
  const now = new Date()
  const recipientTimeZone = await getUserTimeZone(input.kidUserId)

  return db.transaction(async (tx) => {
    const [task] = await tx
      .insert(tasks)
      .values({
        userId: input.kidUserId,
        title,
        difficulty: 'medium',
        xpOverride: xp,
        categorySlug,
        active: false,
        householdId,
        assignedToUserId: input.kidUserId,
      })
      .returning({ id: tasks.id })

    const [instance] = await tx
      .insert(taskInstances)
      .values({
        taskId: task.id,
        userId: input.kidUserId,
        dueAt: null,
        completedAt: now,
        completedByUserId: input.kidUserId,
        householdId,
        assignedToUserId: input.kidUserId,
      })
      .returning({ id: taskInstances.id })

    const tokensEarned = await kidCompletionTokens(
      tx,
      input.kidUserId,
      householdId,
    )

    const event: DomainEvent = {
      type: 'task.completed',
      taskId: task.id,
      instanceId: instance.id,
      difficulty: 'medium',
      xpOverride: xp,
      dueAt: null,
      timeOfDay: null,
      dueKind: 'hard',
      householdId,
      assignedToUserId: input.kidUserId,
      completedAs: 'assigned',
      tokensEarned,
      occurredAt: now,
    }

    await tx.insert(events).values({
      userId: input.kidUserId,
      type: event.type,
      payload: {
        taskId: event.taskId,
        instanceId: event.instanceId,
        difficulty: event.difficulty,
        xpOverride: event.xpOverride,
        dueAt: null,
        timeOfDay: null,
        dueKind: 'hard',
        householdId,
        assignedToUserId: input.kidUserId,
        completedAs: 'assigned',
        tokensEarned,
      },
      occurredAt: now,
    })

    const current = await tx.query.progression.findFirst({
      where: eq(progression.userId, input.kidUserId),
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

    const next = applyEvent(prevState, event, { timeZone: recipientTimeZone })

    await tx
      .insert(progression)
      .values({
        userId: input.kidUserId,
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

    return {
      xpAwarded: next.xp - prevState.xp,
      tokensEarned,
      newXp: next.xp,
      newLevel: next.level,
    }
  })
}

export async function completeInstance(
  userId: string,
  instanceId: string,
  options: {
    force?: boolean
    // `creditUserIds` (plural) credits several household members for one
    // chore — "we did this together, so we both earn it." `creditUserId`
    // (singular) is kept for the public REST API / older callers and is
    // folded into the list below. Empty/absent → the natural recipient.
    creditUserId?: string
    creditUserIds?: string[]
  } = {},
): Promise<CompleteInstanceResult> {
  if (!instanceId) throw new Error('instanceId required')
  const now = new Date()
  const timeZone = await getUserTimeZone(userId)

  // Normalize singular + plural credit inputs into a deduped list.
  const requestedCredits =
    options.creditUserIds && options.creditUserIds.length > 0
      ? Array.from(new Set(options.creditUserIds))
      : options.creditUserId
        ? [options.creditUserId]
        : []

  const txResult = await db.transaction(async (tx) => {
    // Fetch without a user filter so household chores can be completed
    // by their assignee (or any household member, for free-for-all).
    // The permission gate below decides if this caller is allowed.
    const instance = await tx.query.taskInstances.findFirst({
      where: eq(taskInstances.id, instanceId),
    })
    if (!instance) throw new Error('instance not found')
    if (instance.completedAt || instance.skippedAt) {
      return { alreadyHandled: true as const }
    }
    if (instance.claimedAt) {
      // Already in pending-approval state — admins use approveClaim /
      // rejectClaim to resolve. Surface as alreadyHandled so the
      // calling UI can show a friendly "already submitted" toast.
      return { alreadyHandled: true as const }
    }

    // Permission gate + XP recipient(s).
    //  - Personal task: only the owner may complete; XP goes to them.
    //  - Household chore assigned to viewer (or free-for-all): viewer
    //    must be a member; XP goes to the viewer (the completer) by
    //    default, OR to the explicitly chosen recipient(s) from the
    //    dialog. Several people can be credited for one chore — each
    //    earns the full reward.
    //  - Household chore assigned to *someone else*: only adults
    //    (admin/member) may complete "on behalf"; kids are blocked.
    //    Default credit goes to the assignee; the caller can override
    //    with any combination of household members.
    let recipients: string[]
    if (!instance.householdId) {
      if (instance.userId !== userId) throw new Error('not authorized')
      if (requestedCredits.some((id) => id !== userId)) {
        throw new Error('Cannot reassign credit on a personal task.')
      }
      recipients = [userId]
    } else {
      const membership = await tx.query.householdMembers.findFirst({
        where: and(
          eq(householdMembers.userId, userId),
          eq(householdMembers.householdId, instance.householdId),
        ),
        columns: { role: true },
      })
      if (!membership) throw new Error('not a household member')
      // Group-targeted chores are a free-for-all restricted to a role.
      // An "any adult" chore is off-limits to kids; an "any kid" chore
      // stays open to everyone (a kid completes via the claim queue
      // below; an adult may still complete on a kid's behalf).
      if (instance.assigneeGroup === 'adults' && membership.role === 'kid') {
        throw new Error('This chore is for adults.')
      }
      const isAssigneeOrFFA =
        !instance.assignedToUserId ||
        instance.assignedToUserId === userId
      if (!isAssigneeOrFFA && membership.role === 'kid') {
        throw new Error("Kids can only complete their own chores.")
      }

      // Two managed-account models for completion:
      //
      //   kid    — claims into the review queue. The kid tap means
      //            "I did it"; an admin / member approves to grant XP.
      //            No event, no XP at click time.
      //
      //   kiosk  — credit-picker on every tap. The kiosk IS the
      //            shared device; anyone in the family uses it.
      //            At least one recipient is mandatory (UI dialog
      //            enforces), and the completion happens immediately
      //            with those users as the XP recipients. No review
      //            queue, since an adult is presumably at the iPad
      //            picking the actual doer(s).
      if (membership.role === 'kid') {
        const claimed = await tx
          .update(taskInstances)
          .set({ claimedAt: now, claimedByUserId: userId })
          .where(
            and(
              eq(taskInstances.id, instance.id),
              isNull(taskInstances.completedAt),
              isNull(taskInstances.skippedAt),
              isNull(taskInstances.claimedAt),
            ),
          )
          .returning({ id: taskInstances.id })
        if (claimed.length === 0) {
          return { alreadyHandled: true as const }
        }
        return { pendingApproval: true as const }
      }

      if (membership.role === 'kiosk' && requestedCredits.length === 0) {
        throw new Error(
          'Pick who did this chore from the dialog before completing.',
        )
      }

      if (requestedCredits.length > 0) {
        // Any adult (admin / member / kiosk) may credit any combination
        // of household members — the doer vouches for everyone who
        // pitched in (same trust model as completing "on behalf"). We
        // only verify each recipient actually belongs to this household.
        const memberRows = await tx.query.householdMembers.findMany({
          where: and(
            eq(householdMembers.householdId, instance.householdId),
            inArray(householdMembers.userId, requestedCredits),
          ),
          columns: { userId: true },
        })
        const found = new Set(memberRows.map((m) => m.userId))
        const missing = requestedCredits.find((id) => !found.has(id))
        if (missing) {
          throw new Error('Credit recipient is not in this household.')
        }
        recipients = requestedCredits
      } else {
        // Default natural recipient: viewer for FFA / own; assignee
        // when an adult completes on behalf.
        recipients = [
          instance.assignedToUserId && instance.assignedToUserId !== userId
            ? instance.assignedToUserId
            : userId,
        ]
      }
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

    // Race-safe completion: only the first updater wins. For free-for-
    // all chores, two clients can hit this simultaneously; the predicate
    // `completed_at IS NULL` ensures exactly one succeeds. We stamp the
    // primary recipient onto the instance (NOT necessarily the physical
    // clicker) as a convenience anchor for reopen's permission check.
    // When several people are credited, reopen finds the full set from
    // the events themselves (one task.completed per recipient).
    const primaryRecipientId = recipients[0]
    const updated = await tx
      .update(taskInstances)
      .set({ completedAt: now, completedByUserId: primaryRecipientId })
      .where(
        and(
          eq(taskInstances.id, instance.id),
          isNull(taskInstances.completedAt),
          isNull(taskInstances.skippedAt),
        ),
      )
      .returning({ id: taskInstances.id })
    if (updated.length === 0) {
      return { alreadyHandled: true as const }
    }

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

    const dueKind: 'hard' | 'week_target' =
      instance.dueKind === 'week_target' ? 'week_target' : 'hard'

    const completedAs: 'personal' | 'assigned' | 'free_for_all' =
      !instance.householdId
        ? 'personal'
        : instance.assignedToUserId
          ? 'assigned'
          : 'free_for_all'

    // One task.completed event per credited recipient — each earns the
    // full reward and advances their own streak independently. For a
    // solo completion `recipients` is a single id, so this is the same
    // single insert/upsert as before. We keep the primary recipient's
    // resulting progression to return for the completion toast.
    let primaryNext: Progression | null = null
    for (const recipientId of recipients) {
      // Read the recipient's timezone for the punctuality curve. For
      // self-completion this matches `timeZone` (loaded earlier). For
      // on-behalf-of, it could differ (e.g. parent in PST completing a
      // chore for a kid traveling in EST); pull the recipient's tz so the
      // streak boundary is computed in *their* day.
      const recipientTimeZone =
        recipientId === userId
          ? timeZone
          : await getUserTimeZone(recipientId)

      // The clock time that applied to this occurrence's weekday (per-weekday
      // schedules vary it), so punctuality + timing stats use the right target.
      const scheduledTimeOfDay = task.timeOfDay
        ? resolveTimeOfDay(
            dayOfWeekInTz(instance.dueAt ?? now, recipientTimeZone),
            task.timeOfDay,
            task.timeByWeekday,
          )
        : null

      // Kid recipients earn an arcade token every Nth completion (adults: 0).
      const tokensEarned = await kidCompletionTokens(
        tx,
        recipientId,
        instance.householdId,
      )

      const event: DomainEvent = {
        type: 'task.completed',
        taskId: task.id,
        instanceId: instance.id,
        difficulty: task.difficulty as Difficulty,
        xpOverride: parentXpOverride,
        dueAt: instance.dueAt,
        timeOfDay: scheduledTimeOfDay,
        dueKind,
        householdId: instance.householdId,
        assignedToUserId: instance.assignedToUserId,
        completedAs,
        tokensEarned,
        occurredAt: now,
      }

      // event.userId = the XP recipient. For personal tasks and most
      // household completions, this equals the clicking user. For
      // "complete on behalf" (an adult clicking a chore assigned to
      // someone else), it's the assignee. applyEvent operates on whoever
      // is in event.userId, so XP/streak land on the right account.
      await tx.insert(events).values({
        userId: recipientId,
        type: event.type,
        payload: {
          taskId: event.taskId,
          instanceId: event.instanceId,
          difficulty: event.difficulty,
          xpOverride: event.xpOverride,
          dueAt: event.dueAt?.toISOString() ?? null,
          timeOfDay: event.timeOfDay,
          dueKind,
          householdId: event.householdId ?? null,
          assignedToUserId: event.assignedToUserId ?? null,
          completedAs: event.completedAs,
          tokensEarned: event.tokensEarned ?? 0,
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
            tokens: current.tokens,
            lastCompletionAt: current.lastCompletionAt,
          }
        : INITIAL_PROGRESSION

      const next = applyEvent(prevState, event, { timeZone: recipientTimeZone })
      if (recipientId === primaryRecipientId) primaryNext = next

      await tx
        .insert(progression)
        .values({
          userId: recipientId,
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

    // Non-null: the primary id is always one of `recipients`.
    const next = primaryNext!

    let materialized: { instanceId: string; dueAt: Date } | null = null
    if (task.recurrence && task.active && instance.dueAt) {
      const nextDue = computeNextDue({
        recurrence: task.recurrence,
        previousDueAt: instance.dueAt,
        completedAt: now,
        timeOfDay: task.timeOfDay,
        timeByWeekday: task.timeByWeekday,
        timeZone,
        quietHoursEnd: await getUserQuietHoursEnd(userId),
      })
      // Hide the rematerialized instance from today/today-queries until
      // its next due time. Without this an "anytime + repeat 2h after
      // completion" task reappears instantly because nextDue is still
      // today (< horizon). snoozedUntil is the existing per-instance
      // gate the today query already respects.
      const snoozedUntil = nextDue > now ? nextDue : null
      // Next instance inherits household + assignment from the parent
      // task (NOT from the just-completed instance), so reassigning a
      // chore takes effect the next time it materializes. Free-for-all
      // chores stay free-for-all across recurrences. Round-robin tasks
      // advance one slot in the rotation (resolveNextRecurrenceAssignee
      // also bumps task.lastAssigneeCursor).
      const nextAssignee = await resolveNextRecurrenceAssignee(tx, task)
      const [inst] = await tx
        .insert(taskInstances)
        .values({
          taskId: task.id,
          userId: task.userId,
          dueAt: nextDue,
          snoozedUntil,
          householdId: task.householdId,
          assignedToUserId: nextAssignee,
          assigneeGroup: task.assigneeGroup,
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
  })

  if ('alreadyHandled' in txResult && txResult.alreadyHandled) {
    return { alreadyHandled: true }
  }
  if ('pendingApproval' in txResult && txResult.pendingApproval) {
    return { pendingApproval: true }
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

// Permission gate for instance lifecycle ops (skip/defer/snooze). The
// rules mirror completeInstance: personal tasks only the owner; household
// chores require membership and either explicit assignment match or
// free-for-all. Pre-loads the instance so callers don't re-query.
async function loadInstanceForLifecycle(
  tx: Parameters<Parameters<typeof db.transaction>[0]>[0],
  userId: string,
  instanceId: string,
): Promise<typeof taskInstances.$inferSelect> {
  const instance = await tx.query.taskInstances.findFirst({
    where: eq(taskInstances.id, instanceId),
  })
  if (!instance) throw new Error('instance not found')
  if (!instance.householdId) {
    if (instance.userId !== userId) throw new Error('not authorized')
  } else {
    const m = await tx.query.householdMembers.findFirst({
      where: and(
        eq(householdMembers.userId, userId),
        eq(householdMembers.householdId, instance.householdId),
      ),
      columns: { role: true },
    })
    if (!m) throw new Error('not a household member')
    if (instance.assignedToUserId && instance.assignedToUserId !== userId) {
      throw new Error('this chore is assigned to another member')
    }
  }
  return instance
}

export async function skipInstance(
  userId: string,
  instanceId: string,
): Promise<{ alreadyHandled: boolean }> {
  if (!instanceId) throw new Error('instanceId required')
  const now = new Date()
  const timeZone = await getUserTimeZone(userId)

  const txResult = await db.transaction(async (tx) => {
    const instance = await loadInstanceForLifecycle(tx, userId, instanceId)
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
        timeByWeekday: task.timeByWeekday,
        timeZone,
      })
      const snoozedUntil = nextDue > now ? nextDue : null
      const nextAssignee = await resolveNextRecurrenceAssignee(tx, task)
      const [inst] = await tx
        .insert(taskInstances)
        .values({
          taskId: task.id,
          userId: task.userId,
          dueAt: nextDue,
          snoozedUntil,
          householdId: task.householdId,
          assignedToUserId: nextAssignee,
          assigneeGroup: task.assigneeGroup,
        })
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
    const instance = await loadInstanceForLifecycle(tx, userId, instanceId)
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

// Pull an upcoming instance into "now" so it shows in Today immediately —
// e.g. a chore scheduled later this week that you (or a household kid) want
// to start early. Clears any per-instance snooze and the parent task's
// snooze, and moves dueAt to now so it clears the Today horizon. For a
// household free-for-all chore this makes it visible to every member.
export async function surfaceInstanceNow(
  userId: string,
  instanceId: string,
): Promise<{ dueAt: string }> {
  if (!instanceId) throw new Error('instanceId required')
  const now = new Date()
  const timeZone = await getUserTimeZone(userId)
  return db.transaction(async (tx) => {
    const instance = await loadInstanceForLifecycle(tx, userId, instanceId)
    if (instance.completedAt || instance.skippedAt) {
      throw new Error('instance already handled')
    }
    const task = await tx.query.tasks.findFirst({
      where: eq(tasks.id, instance.taskId),
      columns: { timeOfDay: true, timeByWeekday: true },
    })
    // Time-sensitive tasks keep their clock time (just moved to today), so the
    // displayed time — and the next recurrence computed from this dueAt — stay
    // on the original schedule. "Anytime" tasks just surface at the moment.
    const newDueAt = task?.timeOfDay
      ? setTimeInTz(
          now,
          resolveTimeOfDay(
            dayOfWeekInTz(now, timeZone),
            task.timeOfDay,
            task.timeByWeekday,
          ),
          timeZone,
        )
      : now
    await tx
      .update(taskInstances)
      .set({ dueAt: newDueAt, snoozedUntil: null })
      .where(eq(taskInstances.id, instanceId))
    // Lift a task-level snooze too, otherwise the Today query still hides it.
    await tx
      .update(tasks)
      .set({ snoozeUntil: null })
      .where(
        and(eq(tasks.id, instance.taskId), isNotNull(tasks.snoozeUntil)),
      )
    return { dueAt: newDueAt.toISOString() }
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
  return db.transaction(async (tx) => {
    await loadInstanceForLifecycle(tx, userId, instanceId)
    await tx
      .update(taskInstances)
      .set({ snoozedUntil: until })
      .where(eq(taskInstances.id, instanceId))
    return { snoozedUntil: until.toISOString() }
  })
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
    // Who completed it — set only for household chores (so the dialog can show
    // "Bob · Jun 5"). Null/omitted for personal tasks.
    by: { name: string; color: string | null } | null
  }>
  // Present only for household chores. The top-level totals (completionCount,
  // totalXp, cadence, timingOffset) are household-wide when this is set; this
  // block breaks the same completions down per person.
  household: {
    rotation: 'fixed' | 'round_robin'
    perPerson: Array<{
      userId: string
      name: string
      handle: string
      color: string | null
      completions: number
      xp: number
      // Their own on/before-due rate. Null when none of their completions
      // carried a dueAt.
      onTimePct: number | null
      lastCompletedAt: string | null
    }>
  } | null
  // Frequency/consistency stats for repeating tasks. Null for one-off tasks
  // (no recurrence rule to measure against).
  cadence: {
    perWeek: number
    perMonth: number
    // % of completions done on or before their scheduled due day. Null when no
    // completion in the window carried a dueAt to compare against.
    onTime: { pct: number; comparable: number } | null
    expectedPerWeek: number | null
    // Actual perWeek vs expectedPerWeek, capped at 100. Null when the rule has
    // no fixed cadence (after_completion) or no completions yet.
    consistencyPct: number | null
    avgGapDays: number | null
    // Most-recent run of consecutive on-time completions.
    currentStreak: number
    bestDayOfWeek: { weekday: number; count: number } | null
  } | null
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
      householdId: tasks.householdId,
      rotationStrategy: tasks.rotationStrategy,
    })
    .from(tasks)
    .where(eq(tasks.id, taskId))
    .limit(1)
    .then((rows) => rows[0] ?? null)

  // For a household chore, any member can view the stats and completions are
  // counted household-wide (by payload.householdId) so a rotating chore shows
  // the whole household's rhythm — not just the viewer's slice. For a personal
  // task, only the owner can view and only their own completions count.
  const householdId = taskRow?.householdId ?? null
  if (householdId) {
    await assertHouseholdRole(userId, householdId, [
      'admin',
      'member',
      'kid',
      'kiosk',
    ])
  } else if (taskRow && taskRow.ownerId !== userId) {
    throw new Error('task not found')
  }

  const rows = await db
    .select({
      userId: events.userId,
      payload: events.payload,
      occurredAt: events.occurredAt,
    })
    .from(events)
    .where(
      and(
        eq(events.type, 'task.completed'),
        isNotNull(events.occurredAt),
        gte(events.occurredAt, since),
        householdId
          ? sql`${events.payload}->>'householdId' = ${householdId}`
          : eq(events.userId, userId),
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
    userId: string
  }> = []
  let completionCount = 0
  let totalXp = 0
  let hasAnyScheduled = false

  // Per-person breakdown for household chores, keyed by the completer's userId
  // (events.userId). Empty for personal tasks. Names are resolved after the loop.
  const perPerson = new Map<
    string,
    {
      completions: number
      xp: number
      onTimeComparable: number
      onTimeCount: number
      lastMs: number
    }
  >()

  // Cadence accumulators (only meaningful for recurring tasks). rows are
  // ascending by occurredAt, so firstOccurredMs is the earliest completion and
  // the gap/streak logic can read them in chronological order.
  let firstOccurredMs: number | null = null
  let lastOccurredMs: number | null = null
  let gapSumMs = 0
  let gapCount = 0
  const weekdayCounts = new Array<number>(7).fill(0)
  let onTimeComparable = 0
  let onTimeCount = 0
  // On-time flag (done on/before due day) per completion that had a comparable
  // dueAt, in chronological order — the current streak is its trailing run.
  const onTimeFlags: boolean[] = []

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
      userId: r.userId,
    })

    const person = perPerson.get(r.userId) ?? {
      completions: 0,
      xp: 0,
      onTimeComparable: 0,
      onTimeCount: 0,
      lastMs: 0,
    }
    person.completions += 1
    person.xp += xp
    person.lastMs = r.occurredAt.getTime()
    perPerson.set(r.userId, person)

    // Cadence bookkeeping. dayKey is the local calendar day (yyyy-MM-dd) — parse
    // it back as UTC midnight to read its weekday without a second tz formatter.
    const occMs = r.occurredAt.getTime()
    if (firstOccurredMs === null) firstOccurredMs = occMs
    if (lastOccurredMs !== null) {
      gapSumMs += occMs - lastOccurredMs
      gapCount += 1
    }
    lastOccurredMs = occMs
    const weekday = new Date(`${dayKey}T00:00:00Z`).getUTCDay()
    if (weekday >= 0 && weekday <= 6) weekdayCounts[weekday] += 1

    const dueRaw = typeof p['dueAt'] === 'string' ? (p['dueAt'] as string) : null
    if (dueRaw) {
      const dueDate = new Date(dueRaw)
      if (!Number.isNaN(dueDate.getTime())) {
        const dueDayKey = dayFmt.format(dueDate)
        const onTime = dayKey <= dueDayKey
        onTimeComparable += 1
        if (onTime) onTimeCount += 1
        onTimeFlags.push(onTime)
        person.onTimeComparable += 1
        if (onTime) person.onTimeCount += 1
      }
    }

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

  // Cadence stats — only for recurring tasks. Rates use a single span: the
  // window start for a fixed window, or the first completion for all-time
  // (floored at 1 day so a same-day task doesn't divide by ~0).
  let cadence: TaskStats['cadence'] = null
  if (taskRow?.recurrence) {
    const now = Date.now()
    const effectiveStartMs = allTime
      ? (firstOccurredMs ?? now)
      : since.getTime()
    const spanDays = Math.max(1, (now - effectiveStartMs) / 86_400_000)
    const perWeek = completionCount / (spanDays / 7)
    const perMonth = completionCount / (spanDays / 30.44)

    const expectedPerWeek = expectedCompletionsPerWeek(taskRow.recurrence)
    const consistencyPct =
      expectedPerWeek && expectedPerWeek > 0
        ? Math.round(Math.min(100, (perWeek / expectedPerWeek) * 100))
        : null

    // Trailing run of on-time completions, newest first.
    let currentStreak = 0
    for (let i = onTimeFlags.length - 1; i >= 0; i--) {
      if (onTimeFlags[i]) currentStreak += 1
      else break
    }

    let bestDayOfWeek: { weekday: number; count: number } | null = null
    for (let d = 0; d < 7; d++) {
      if (weekdayCounts[d] > 0 && (!bestDayOfWeek || weekdayCounts[d] > bestDayOfWeek.count)) {
        bestDayOfWeek = { weekday: d, count: weekdayCounts[d] }
      }
    }

    cadence = {
      perWeek,
      perMonth,
      onTime:
        onTimeComparable > 0
          ? {
              pct: Math.round((onTimeCount / onTimeComparable) * 100),
              comparable: onTimeComparable,
            }
          : null,
      expectedPerWeek,
      consistencyPct: completionCount > 0 ? consistencyPct : null,
      avgGapDays:
        gapCount > 0
          ? Math.round((gapSumMs / gapCount / 86_400_000) * 10) / 10
          : null,
      currentStreak,
      bestDayOfWeek,
    }
  }

  // Household per-person breakdown + name map for "who completed it" labels.
  let household: TaskStats['household'] = null
  const nameByUser = new Map<
    string,
    { name: string; color: string | null }
  >()
  if (householdId) {
    const members = await listHouseholdMembers(userId, householdId)
    const memberById = new Map(members.map((m) => [m.userId, m]))
    for (const m of members) {
      nameByUser.set(m.userId, { name: m.name, color: m.color })
    }
    const perPersonRows = Array.from(perPerson.entries())
      .map(([uid, agg]) => {
        const m = memberById.get(uid)
        if (m && !nameByUser.has(uid)) {
          nameByUser.set(uid, { name: m.name, color: m.color })
        }
        return {
          userId: uid,
          name: m?.name ?? 'Former member',
          handle: m?.handle ?? '',
          color: m?.color ?? null,
          completions: agg.completions,
          xp: agg.xp,
          onTimePct:
            agg.onTimeComparable > 0
              ? Math.round((agg.onTimeCount / agg.onTimeComparable) * 100)
              : null,
          lastCompletedAt:
            agg.lastMs > 0 ? new Date(agg.lastMs).toISOString() : null,
        }
      })
      .sort((a, b) => b.completions - a.completions)
    household = {
      rotation:
        taskRow?.rotationStrategy === 'round_robin' ? 'round_robin' : 'fixed',
      perPerson: perPersonRows,
    }
  }

  const recentCompletions = recent
    .slice(-15)
    .reverse()
    .map((r) => ({
      instanceId: r.instanceId,
      occurredAt: r.occurredAt,
      xp: r.xp,
      by: householdId ? (nameByUser.get(r.userId) ?? null) : null,
    }))

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
    recentCompletions,
    household,
    cadence,
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
      timeOfDay: task.timeOfDay
        ? resolveTimeOfDay(
            dayOfWeekInTz(instance.dueAt ?? now, timeZone),
            task.timeOfDay,
            task.timeByWeekday,
          )
        : null,
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
