import { asc, eq } from 'drizzle-orm'
import { createServerFn } from '@tanstack/react-start'
import { db } from '../db/client'
import { events, user as userTable, userPrefs } from '../db/schema'
import { authMiddleware } from '../middleware/auth'
import {
  handleExists,
  isValidHandle,
  normalizeHandle,
} from '../services/handles'

const VISIBILITY_VALUES = ['public', 'friends', 'private'] as const
type Visibility = (typeof VISIBILITY_VALUES)[number]

export const updateTimezone = createServerFn({ method: 'POST' })
  .middleware([authMiddleware])
  .inputValidator((data: { timezone: string }) => {
    if (!data.timezone || data.timezone.length > 64) {
      throw new Error('invalid timezone')
    }
    try {
      Intl.DateTimeFormat(undefined, { timeZone: data.timezone })
    } catch {
      throw new Error('unknown IANA timezone')
    }
    return data
  })
  .handler(async ({ data, context }) => {
    const row = await db.query.user.findFirst({
      where: eq(userTable.id, context.userId),
      columns: { timezone: true },
    })
    if (row?.timezone === data.timezone) {
      return { changed: false, timezone: data.timezone }
    }
    await db
      .update(userTable)
      .set({ timezone: data.timezone, updatedAt: new Date() })
      .where(eq(userTable.id, context.userId))
    return { changed: true, timezone: data.timezone }
  })

// Returns the viewer's handle, profile visibility, and sharing prefs. The
// prefs row is created lazily on first write; reads fall back to defaults.
export const getProfile = createServerFn({ method: 'GET' })
  .middleware([authMiddleware])
  .handler(async ({ context }) => {
    const [userRow, prefsRow] = await Promise.all([
      db.query.user.findFirst({
        where: eq(userTable.id, context.userId),
        columns: {
          handle: true,
          profileVisibility: true,
          gardenVisibility: true,
          name: true,
          quietHoursStart: true,
          quietHoursEnd: true,
        },
      }),
      db.query.userPrefs.findFirst({
        where: eq(userPrefs.userId, context.userId),
      }),
    ])
    return {
      handle: userRow?.handle ?? '',
      profileVisibility: (userRow?.profileVisibility ?? 'friends') as Visibility,
      gardenVisibility: (userRow?.gardenVisibility ?? 'friends') as Visibility,
      shareProgression: prefsRow?.shareProgression ?? true,
      shareActivity: prefsRow?.shareActivity ?? true,
      shareTaskTitles: prefsRow?.shareTaskTitles ?? false,
      quietHoursStart: userRow?.quietHoursStart ?? null,
      quietHoursEnd: userRow?.quietHoursEnd ?? null,
    }
  })

export const updateQuietHours = createServerFn({ method: 'POST' })
  .middleware([authMiddleware])
  .inputValidator(
    (data: { start: string | null; end: string | null }) => {
      const parsed = (v: string | null): string | null => {
        if (v === null || v === '') return null
        if (!/^\d{2}:\d{2}$/.test(v)) {
          throw new Error('Time must be HH:MM.')
        }
        const [h, m] = v.split(':').map(Number)
        if (h < 0 || h > 23 || m < 0 || m > 59) {
          throw new Error('Time must be between 00:00 and 23:59.')
        }
        return v
      }
      return { start: parsed(data.start), end: parsed(data.end) }
    },
  )
  .handler(async ({ data, context }) => {
    // Allow setting both or clearing both; a half-set window makes no sense.
    const normalized =
      data.start && data.end
        ? { start: data.start, end: data.end }
        : { start: null, end: null }
    await db
      .update(userTable)
      .set({
        quietHoursStart: normalized.start,
        quietHoursEnd: normalized.end,
        updatedAt: new Date(),
      })
      .where(eq(userTable.id, context.userId))
    return normalized
  })

export const updateHandle = createServerFn({ method: 'POST' })
  .middleware([authMiddleware])
  .inputValidator((data: { handle: string }) => {
    const normalized = normalizeHandle(data.handle)
    if (!isValidHandle(normalized)) {
      throw new Error(
        'Handle must be 3–20 characters, lowercase letters, numbers, or underscores.',
      )
    }
    return { handle: normalized }
  })
  .handler(async ({ data, context }) => {
    const existing = await db.query.user.findFirst({
      where: eq(userTable.id, context.userId),
      columns: { handle: true },
    })
    if (existing?.handle === data.handle) {
      return { changed: false, handle: data.handle }
    }
    if (await handleExists(data.handle, context.userId)) {
      throw new Error('That handle is already taken.')
    }
    await db
      .update(userTable)
      .set({ handle: data.handle, updatedAt: new Date() })
      .where(eq(userTable.id, context.userId))
    return { changed: true, handle: data.handle }
  })

export const updateProfileVisibility = createServerFn({ method: 'POST' })
  .middleware([authMiddleware])
  .inputValidator((data: { visibility: string }) => {
    if (!VISIBILITY_VALUES.includes(data.visibility as Visibility)) {
      throw new Error('invalid visibility')
    }
    return { visibility: data.visibility as Visibility }
  })
  .handler(async ({ data, context }) => {
    await db
      .update(userTable)
      .set({ profileVisibility: data.visibility, updatedAt: new Date() })
      .where(eq(userTable.id, context.userId))
    return { visibility: data.visibility }
  })

export const updateGardenVisibility = createServerFn({ method: 'POST' })
  .middleware([authMiddleware])
  .inputValidator((data: { visibility: string }) => {
    if (!VISIBILITY_VALUES.includes(data.visibility as Visibility)) {
      throw new Error('invalid visibility')
    }
    return { visibility: data.visibility as Visibility }
  })
  .handler(async ({ data, context }) => {
    await db
      .update(userTable)
      .set({ gardenVisibility: data.visibility, updatedAt: new Date() })
      .where(eq(userTable.id, context.userId))
    return { visibility: data.visibility }
  })

export const updatePrefs = createServerFn({ method: 'POST' })
  .middleware([authMiddleware])
  .inputValidator(
    (data: {
      shareProgression?: boolean
      shareActivity?: boolean
      shareTaskTitles?: boolean
    }) => {
      return {
        shareProgression:
          typeof data.shareProgression === 'boolean'
            ? data.shareProgression
            : undefined,
        shareActivity:
          typeof data.shareActivity === 'boolean'
            ? data.shareActivity
            : undefined,
        shareTaskTitles:
          typeof data.shareTaskTitles === 'boolean'
            ? data.shareTaskTitles
            : undefined,
      }
    },
  )
  .handler(async ({ data, context }) => {
    const existing = await db.query.userPrefs.findFirst({
      where: eq(userPrefs.userId, context.userId),
    })
    const next = {
      shareProgression: data.shareProgression ?? existing?.shareProgression ?? true,
      shareActivity: data.shareActivity ?? existing?.shareActivity ?? true,
      shareTaskTitles:
        data.shareTaskTitles ?? existing?.shareTaskTitles ?? false,
    }
    if (existing) {
      await db
        .update(userPrefs)
        .set(next)
        .where(eq(userPrefs.userId, context.userId))
    } else {
      await db.insert(userPrefs).values({ userId: context.userId, ...next })
    }
    return next
  })

// Reports the age of the viewer's event history so UI toggles can hide
// windows that would just render empty data. Returns the first event
// timestamp (any type) and a convenience daysOfHistory integer.
export const getDataAvailability = createServerFn({ method: 'GET' })
  .middleware([authMiddleware])
  .handler(async ({ context }) => {
    const row = await db
      .select({ occurredAt: events.occurredAt })
      .from(events)
      .where(eq(events.userId, context.userId))
      .orderBy(asc(events.occurredAt))
      .limit(1)
    const firstEventAt = row[0]?.occurredAt ?? null
    const daysOfHistory = firstEventAt
      ? Math.floor(
          (Date.now() - firstEventAt.getTime()) / (24 * 60 * 60 * 1000),
        )
      : 0
    return {
      firstEventAt: firstEventAt?.toISOString() ?? null,
      daysOfHistory,
    }
  })
