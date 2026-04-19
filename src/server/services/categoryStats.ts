// Cross-user category histogram with privacy + visibility gating.
//
// Returns ready-to-render bars using the target user's own category
// taxonomy (labels + colors), counting their own tasks. Private-visibility
// tasks are excluded so sharing a category histogram doesn't leak counts
// from tasks the target wanted hidden.
import { and, eq, gte, inArray, isNotNull } from 'drizzle-orm'
import { db } from '../db/client'
import {
  events,
  tasks,
  userPrefs,
} from '../db/schema'
import { canView } from './social'
import { listCategories } from './categories'

export type CategoryScope = 'active' | 'completed'

export interface CategoryHistogramBar {
  slug: string | null
  label: string
  color: string
  count: number
}

export interface CategoryHistogramResult {
  userId: string
  canView: boolean
  shared: boolean
  bars: CategoryHistogramBar[]
  total: number
}

export async function getCategoryHistogramForUser(
  viewerId: string,
  targetUserId: string,
  scope: CategoryScope,
): Promise<CategoryHistogramResult> {
  const isSelf = viewerId === targetUserId
  const allowed = isSelf ? true : await canView(viewerId, targetUserId)
  if (!allowed) {
    return {
      userId: targetUserId,
      canView: false,
      shared: false,
      bars: [],
      total: 0,
    }
  }

  // Respect the target's share-activity pref for non-self viewers. Even if
  // the profile is public / friends-visible, a user who opted out of
  // activity sharing shouldn't have their categories surfaced.
  if (!isSelf) {
    const prefs = await db.query.userPrefs.findFirst({
      where: eq(userPrefs.userId, targetUserId),
    })
    if (prefs && prefs.shareActivity === false) {
      return {
        userId: targetUserId,
        canView: true,
        shared: false,
        bars: [],
        total: 0,
      }
    }
  }

  const counts = new Map<string | null, number>()
  const bump = (slug: string | null) =>
    counts.set(slug, (counts.get(slug) ?? 0) + 1)

  if (scope === 'active') {
    // Non-self viewers never see private tasks — they effectively don't
    // exist for the histogram. Self sees everything.
    const rows = await db
      .select({
        categorySlug: tasks.categorySlug,
        visibility: tasks.visibility,
      })
      .from(tasks)
      .where(and(eq(tasks.userId, targetUserId), eq(tasks.active, true)))
    for (const r of rows) {
      if (!isSelf && r.visibility === 'private') continue
      bump(r.categorySlug)
    }
  } else {
    // completed: pull completion events in the last 30d, then resolve to
    // tasks to pick up the category + visibility. The category slug on the
    // task itself is authoritative even if it's been re-categorized since
    // the completion — good enough for a "recent activity" view.
    const since = new Date(Date.now() - 30 * 24 * 3_600_000)
    const completions = await db
      .select({ payload: events.payload })
      .from(events)
      .where(
        and(
          eq(events.userId, targetUserId),
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
    if (taskIds.length > 0) {
      const taskRows = await db
        .select({
          id: tasks.id,
          categorySlug: tasks.categorySlug,
          visibility: tasks.visibility,
        })
        .from(tasks)
        .where(inArray(tasks.id, taskIds))
      const meta = new Map(taskRows.map((t) => [t.id, t]))
      for (const e of completions) {
        const p =
          e.payload && typeof e.payload === 'object'
            ? (e.payload as Record<string, unknown>)
            : {}
        const taskId =
          typeof p['taskId'] === 'string' ? (p['taskId'] as string) : null
        if (!taskId) {
          bump(null)
          continue
        }
        const row = meta.get(taskId)
        if (!row) {
          bump(null)
          continue
        }
        if (!isSelf && row.visibility === 'private') continue
        bump(row.categorySlug)
      }
    }
  }

  const cats = await listCategories(targetUserId)
  const bars: CategoryHistogramBar[] = cats.map((cat) => ({
    slug: cat.slug,
    label: cat.label,
    color: cat.color,
    count: counts.get(cat.slug) ?? 0,
  }))
  const uncategorized = counts.get(null) ?? 0
  if (uncategorized > 0) {
    bars.push({
      slug: null,
      label: 'Uncategorized',
      color: '#8f8f8f',
      count: uncategorized,
    })
  }

  return {
    userId: targetUserId,
    canView: true,
    shared: true,
    bars: bars.filter((b) => b.count > 0),
    total: bars.reduce((acc, b) => acc + b.count, 0),
  }
}
