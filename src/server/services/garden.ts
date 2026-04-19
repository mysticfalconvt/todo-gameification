// Garden state builder. Replays the viewer's completion events through
// the pure reducer in src/domain/garden.ts, enriches each plant with
// display metadata from the user's category taxonomy, and returns
// everything the UI needs in one round-trip.
import { and, eq, inArray, isNotNull } from 'drizzle-orm'
import { db } from '../db/client'
import { events, tasks } from '../db/schema'
import {
  type Decoration,
  type GardenState,
  UNCATEGORIZED_KEY,
  growthStage,
  milestoneDecorations,
  mood,
  replayGarden,
} from '../../domain/garden'
import { getUserTimeZone } from './tasks'
import { listCategories } from './categories'

export interface GardenPlant {
  key: string
  categorySlug: string | null
  label: string
  color: string
  waterings: number
  currentStreak: number
  longestStreak: number
  lastWateredAt: string | null
  stage: ReturnType<typeof growthStage>
  mood: ReturnType<typeof mood>
  decorations: Decoration[]
}

export interface GardenView {
  plants: GardenPlant[]
  totalWaterings: number
  activePlantCount: number
}

export async function getGarden(userId: string): Promise<GardenView> {
  const timeZone = await getUserTimeZone(userId)

  // All completion events for this user, across all time. Volume is low
  // (dozens to hundreds per user in normal use); a single pull + in-
  // memory fold is cheaper than an aggregate query plus a join.
  const rows = await db
    .select({
      occurredAt: events.occurredAt,
      payload: events.payload,
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

  const taskIds = Array.from(
    new Set(
      rows
        .map((r) => {
          const p =
            r.payload && typeof r.payload === 'object'
              ? (r.payload as Record<string, unknown>)
              : {}
          return typeof p['taskId'] === 'string' ? p['taskId'] : null
        })
        .filter((v): v is string => Boolean(v)),
    ),
  )

  // Current task → category mapping. If a task gets re-categorized
  // later, past completions follow the new category. For a garden
  // that's the right behavior: the plant "is" the category, not a
  // snapshot of a historical bucket.
  const taskCatMap = new Map<string, string | null>()
  if (taskIds.length > 0) {
    const taskRows = await db
      .select({ id: tasks.id, categorySlug: tasks.categorySlug })
      .from(tasks)
      .where(inArray(tasks.id, taskIds))
    for (const t of taskRows) taskCatMap.set(t.id, t.categorySlug ?? null)
  }

  const gardenEvents = rows.map((r) => {
    const p =
      r.payload && typeof r.payload === 'object'
        ? (r.payload as Record<string, unknown>)
        : {}
    const taskId =
      typeof p['taskId'] === 'string' ? (p['taskId'] as string) : null
    const categorySlug = taskId ? taskCatMap.get(taskId) ?? null : null
    return {
      type: 'task.completed' as const,
      occurredAt: r.occurredAt!,
      categorySlug,
    }
  })

  const state: GardenState = replayGarden(gardenEvents, { timeZone })

  const cats = await listCategories(userId)
  const catBySlug = new Map(cats.map((c) => [c.slug, c]))
  const now = new Date()

  const plants: GardenPlant[] = Object.values(state.plants)
    .map((p) => {
      const cat = p.categorySlug ? catBySlug.get(p.categorySlug) : null
      return {
        key: p.key,
        categorySlug: p.categorySlug,
        label: cat?.label ?? 'Uncategorized',
        color: cat?.color ?? '#8f8f8f',
        waterings: p.waterings,
        currentStreak: p.currentStreak,
        longestStreak: p.longestStreak,
        lastWateredAt: p.lastWateredAt?.toISOString() ?? null,
        stage: growthStage(p.waterings),
        mood: mood(p.lastWateredAt, now),
        decorations: milestoneDecorations(p.waterings),
      }
    })
    // Show biggest plants first so progress is rewarding to scroll.
    .sort((a, b) => b.waterings - a.waterings || a.label.localeCompare(b.label))

  return {
    plants,
    totalWaterings: plants.reduce((acc, p) => acc + p.waterings, 0),
    activePlantCount: plants.filter((p) => p.waterings > 0).length,
  }
}

// Intentionally unused in the bulk return but re-exported so the UI
// can read key constants without importing the domain module twice.
export { UNCATEGORIZED_KEY }
