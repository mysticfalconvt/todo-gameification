// Integration-test helpers.
//
// We run contract tests against the real dev Postgres (same DATABASE_URL
// as the dev server), but every test creates its own uniquely-IDd user
// and cleans up after, so your own dev data is untouched. An explicit
// prod guard prevents these helpers from ever destroying real user data
// if something accidentally sets NODE_ENV=production.
import { randomBytes } from 'node:crypto'
import { eq, inArray } from 'drizzle-orm'
import { db } from '../server/db/client'
import {
  apiTokens,
  emailSendLog,
  events,
  friendships,
  llmCallLog,
  progression,
  pushSubscriptions,
  taskInstances,
  tasks,
  user,
  userCategories,
  userPrefs,
} from '../server/db/schema'

function assertNotProd() {
  if (process.env.NODE_ENV === 'production') {
    throw new Error(
      '[test/helpers] refusing to run against a production database',
    )
  }
}

function randomSuffix(): string {
  return randomBytes(6).toString('hex')
}

export interface TestUser {
  id: string
  email: string
  name: string
  handle: string
}

// Inserts a minimal user row bypassing Better Auth's sign-up flow. Good
// enough for service-level contract tests that only care about the
// downstream app tables.
export async function createTestUser(
  overrides: Partial<TestUser> = {},
): Promise<TestUser> {
  assertNotProd()
  const suffix = randomSuffix()
  const tu: TestUser = {
    id: overrides.id ?? `testuser_${suffix}`,
    email: overrides.email ?? `test_${suffix}@example.test`,
    name: overrides.name ?? `Test ${suffix}`,
    handle: overrides.handle ?? `test_${suffix}`.slice(0, 20),
  }
  await db.insert(user).values({
    id: tu.id,
    email: tu.email,
    name: tu.name,
    handle: tu.handle,
    emailVerified: true,
    timezone: 'UTC',
  })
  return tu
}

// Hard-deletes a test user and every app-table row that references them.
// The user table's FKs take care of session/account/tasks/userCategories/
// apiTokens/friendships/userPrefs; the rest (events/progression/push_subs
// and friendships referencing this user via FK of either side) are
// wiped explicitly.
export async function cleanupTestUser(userId: string): Promise<void> {
  assertNotProd()
  await Promise.all([
    db.delete(events).where(eq(events.userId, userId)),
    db.delete(progression).where(eq(progression.userId, userId)),
    db.delete(pushSubscriptions).where(eq(pushSubscriptions.userId, userId)),
  ])
  // user FK cascade handles: session, account, tasks (→ task_instances via
  // taskId cascade), user_categories, api_tokens, friendships, user_prefs.
  await db.delete(user).where(eq(user.id, userId))
}

// Convenience: run fn with a fresh user and always clean up.
export async function withTestUser<T>(
  fn: (u: TestUser) => Promise<T>,
  overrides?: Partial<TestUser>,
): Promise<T> {
  const u = await createTestUser(overrides)
  try {
    return await fn(u)
  } finally {
    await cleanupTestUser(u.id)
  }
}

// Multi-user variant for tests that need two or more actors (friendship,
// leaderboard, privacy gates).
export async function withTestUsers<T>(
  count: number,
  fn: (users: TestUser[]) => Promise<T>,
): Promise<T> {
  assertNotProd()
  const users: TestUser[] = []
  for (let i = 0; i < count; i++) users.push(await createTestUser())
  try {
    return await fn(users)
  } finally {
    await Promise.all(users.map((u) => cleanupTestUser(u.id)))
  }
}

// Global cleanup used in rare cases where a test aborts mid-way and
// leaves orphan test_ rows behind. Safe to call between suites.
export async function sweepOrphanTestUsers(): Promise<void> {
  assertNotProd()
  const rows = await db
    .select({ id: user.id })
    .from(user)
    .where(eq(user.emailVerified, true))
  const ids = rows
    .map((r) => r.id)
    .filter((id) => id.startsWith('testuser_'))
  if (ids.length === 0) return
  await Promise.all([
    db.delete(events).where(inArray(events.userId, ids)),
    db.delete(progression).where(inArray(progression.userId, ids)),
    db.delete(pushSubscriptions).where(inArray(pushSubscriptions.userId, ids)),
  ])
  await db.delete(user).where(inArray(user.id, ids))
}

// Referenced just so tsc doesn't drop unused imports when schemas shift.
void apiTokens
void taskInstances
void tasks
void userCategories
void userPrefs
void friendships
void emailSendLog
void llmCallLog
