import { eq } from 'drizzle-orm'
import { createServerFn } from '@tanstack/react-start'
import { db } from '../db/client'
import { user as userTable } from '../db/schema'
import { authMiddleware } from '../middleware/auth'

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
