// New-user bootstrap. Called from auth.ts databaseHooks.user.create.after
// and is idempotent — safe to re-run. Keeps existing users in step with
// what new signups get (also backfilled retroactively via migrations
// 0017_arcade_onboarding.sql and 0018_onboarding_category_backfill.sql).
//
// When adding a new arcade game, also add a task spec below so new users
// discover it on signup (and ship a migration for existing users — see
// CLAUDE.md "Arcade games: onboarding migration").
import { and, eq, sql } from 'drizzle-orm'
import { db } from '../db/client'
import {
  events,
  progression,
  taskInstances,
  tasks,
  userCategories,
} from '../db/schema'

const ONBOARDING_REASON = 'onboarding:arcade-welcome'
const TOKEN_GRANT = 2
const ONBOARDING_CATEGORY = 'other'

interface OnboardingTaskSpec {
  externalRef: string
  title: string
  notes: string
}

const ONBOARDING_TASKS: OnboardingTaskSpec[] = [
  {
    externalRef: 'onboarding-try-wordle',
    title: 'Try the Wordle game',
    notes:
      'Head to the arcade and spend a token on Wordle — guess a 5-letter word in 6 tries. Fewer guesses = more XP.',
  },
  {
    externalRef: 'onboarding-try-memory-flip',
    title: 'Try the Memory Flip game',
    notes:
      'Head to the arcade and spend a token on Memory Flip — match 6 pairs before 6 mismatches.',
  },
]

// Same set categories.ts seeds lazily. Keep in sync with DEFAULT_CATEGORIES
// there — duplicated here because we want new users to have the taxonomy
// available the moment the bootstrap runs (so the onboarding tasks can
// reference category 'other').
const DEFAULT_CATEGORIES = [
  { slug: 'home', label: 'Home', color: '#4fb8b2', sortOrder: 0 },
  { slug: 'health', label: 'Health', color: '#e07a5f', sortOrder: 1 },
  { slug: 'work', label: 'Work', color: '#6a9bd8', sortOrder: 2 },
  { slug: 'admin', label: 'Admin', color: '#9a7fcf', sortOrder: 3 },
  { slug: 'social', label: 'Social', color: '#f2c14e', sortOrder: 4 },
  { slug: 'errands', label: 'Errands', color: '#6fab7a', sortOrder: 5 },
  { slug: 'self-care', label: 'Self-care', color: '#c187c5', sortOrder: 6 },
  { slug: 'other', label: 'Other', color: '#8f8f8f', sortOrder: 7 },
]

async function seedCategoriesIfEmpty(userId: string): Promise<void> {
  const existing = await db.query.userCategories.findFirst({
    where: eq(userCategories.userId, userId),
  })
  if (existing) return
  await db
    .insert(userCategories)
    .values(
      DEFAULT_CATEGORIES.map((c) => ({
        userId,
        slug: c.slug,
        label: c.label,
        color: c.color,
        description: '',
        sortOrder: c.sortOrder,
      })),
    )
    .onConflictDoNothing()
}

async function grantWelcomeTokensIfMissing(userId: string): Promise<void> {
  const prior = await db
    .select({ id: events.id })
    .from(events)
    .where(
      and(
        eq(events.userId, userId),
        eq(events.type, 'tokens.granted'),
        sql`${events.payload}->>'reason' = ${ONBOARDING_REASON}`,
      ),
    )
    .limit(1)
  if (prior.length > 0) return

  await db.transaction(async (tx) => {
    await tx.insert(events).values({
      userId,
      type: 'tokens.granted',
      payload: {
        amount: TOKEN_GRANT,
        reason: ONBOARDING_REASON,
        grantedBy: 'system',
      },
    })
    await tx
      .insert(progression)
      .values({ userId, tokens: TOKEN_GRANT })
      .onConflictDoUpdate({
        target: progression.userId,
        set: {
          tokens: sql`${progression.tokens} + ${TOKEN_GRANT}`,
          updatedAt: new Date(),
        },
      })
  })
}

async function createOnboardingTaskIfMissing(
  userId: string,
  spec: OnboardingTaskSpec,
): Promise<void> {
  const existing = await db.query.tasks.findFirst({
    where: and(
      eq(tasks.userId, userId),
      eq(tasks.externalRef, spec.externalRef),
    ),
  })
  if (existing) return
  try {
    await db.transaction(async (tx) => {
      const [task] = await tx
        .insert(tasks)
        .values({
          userId,
          title: spec.title,
          notes: spec.notes,
          difficulty: 'small',
          categorySlug: ONBOARDING_CATEGORY,
          externalRef: spec.externalRef,
          visibility: 'private',
        })
        .returning({ id: tasks.id })
      await tx.insert(taskInstances).values({
        taskId: task.id,
        userId,
        dueAt: new Date(),
      })
    })
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    if (!/tasks_user_external_ref_idx|duplicate key/i.test(message)) {
      throw err
    }
  }
}

export async function bootstrapNewUser(userId: string): Promise<void> {
  await seedCategoriesIfEmpty(userId)
  await grantWelcomeTokensIfMissing(userId)
  for (const spec of ONBOARDING_TASKS) {
    await createOnboardingTaskIfMissing(userId, spec)
  }
}
