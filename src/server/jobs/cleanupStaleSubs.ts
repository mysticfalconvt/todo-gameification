import { gt } from 'drizzle-orm'
import { db } from '../db/client'
import { pushSubscriptions } from '../db/schema'

const FAILURE_THRESHOLD = 5

export async function cleanupStaleSubsHandler(): Promise<void> {
  await db
    .delete(pushSubscriptions)
    .where(gt(pushSubscriptions.failureCount, FAILURE_THRESHOLD))
}
