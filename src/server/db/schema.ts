import {
  boolean,
  index,
  integer,
  jsonb,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uuid,
} from 'drizzle-orm/pg-core'
import type { Recurrence } from '../../domain/recurrence'

// ---------------------------------------------------------------------------
// Better Auth tables (schema shape matches better-auth 1.x defaults).
// Regenerate with `pnpm dlx @better-auth/cli generate` if the upstream schema
// changes and reconcile any drift here.
// ---------------------------------------------------------------------------

export const user = pgTable('user', {
  id: text('id').primaryKey(),
  name: text('name').notNull(),
  email: text('email').notNull().unique(),
  emailVerified: boolean('email_verified').notNull().default(false),
  image: text('image'),
  timezone: text('timezone').notNull().default('UTC'),
  // Public-facing identifier used for friend search and profile URLs.
  // Lowercase alphanumeric + underscore, 3–20 chars. Unique case-insensitive.
  handle: text('handle').notNull().unique(),
  profileVisibility: text('profile_visibility', {
    enum: ['public', 'friends', 'private'],
  })
    .notNull()
    .default('friends'),
  createdAt: timestamp('created_at').notNull().defaultNow(),
  updatedAt: timestamp('updated_at').notNull().defaultNow(),
})

export const session = pgTable('session', {
  id: text('id').primaryKey(),
  expiresAt: timestamp('expires_at').notNull(),
  token: text('token').notNull().unique(),
  createdAt: timestamp('created_at').notNull().defaultNow(),
  updatedAt: timestamp('updated_at').notNull().defaultNow(),
  ipAddress: text('ip_address'),
  userAgent: text('user_agent'),
  userId: text('user_id')
    .notNull()
    .references(() => user.id, { onDelete: 'cascade' }),
})

export const account = pgTable('account', {
  id: text('id').primaryKey(),
  accountId: text('account_id').notNull(),
  providerId: text('provider_id').notNull(),
  userId: text('user_id')
    .notNull()
    .references(() => user.id, { onDelete: 'cascade' }),
  accessToken: text('access_token'),
  refreshToken: text('refresh_token'),
  idToken: text('id_token'),
  accessTokenExpiresAt: timestamp('access_token_expires_at'),
  refreshTokenExpiresAt: timestamp('refresh_token_expires_at'),
  scope: text('scope'),
  password: text('password'),
  createdAt: timestamp('created_at').notNull().defaultNow(),
  updatedAt: timestamp('updated_at').notNull().defaultNow(),
})

export const verification = pgTable('verification', {
  id: text('id').primaryKey(),
  identifier: text('identifier').notNull(),
  value: text('value').notNull(),
  expiresAt: timestamp('expires_at').notNull(),
  createdAt: timestamp('created_at').notNull().defaultNow(),
  updatedAt: timestamp('updated_at').notNull().defaultNow(),
})

// ---------------------------------------------------------------------------
// Application tables
// ---------------------------------------------------------------------------

export const tasks = pgTable('tasks', {
  id: uuid('id').defaultRandom().primaryKey(),
  userId: text('user_id')
    .notNull()
    .references(() => user.id, { onDelete: 'cascade' }),
  title: text('title').notNull(),
  notes: text('notes'),
  difficulty: text('difficulty', { enum: ['small', 'medium', 'large'] })
    .notNull()
    .default('medium'),
  xpOverride: integer('xp_override'),
  recurrence: jsonb('recurrence').$type<Recurrence>(),
  timeOfDay: text('time_of_day'),
  categorySlug: text('category_slug'),
  snoozeUntil: timestamp('snooze_until'),
  visibility: text('visibility', { enum: ['private', 'friends', 'public'] })
    .notNull()
    .default('friends'),
  active: boolean('active').notNull().default(true),
  createdAt: timestamp('created_at').notNull().defaultNow(),
  updatedAt: timestamp('updated_at').notNull().defaultNow(),
})

export const taskInstances = pgTable(
  'task_instances',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    taskId: uuid('task_id')
      .notNull()
      .references(() => tasks.id, { onDelete: 'cascade' }),
    userId: text('user_id').notNull(),
    dueAt: timestamp('due_at'),
    completedAt: timestamp('completed_at'),
    skippedAt: timestamp('skipped_at'),
    snoozedUntil: timestamp('snoozed_until'),
    createdAt: timestamp('created_at').notNull().defaultNow(),
  },
  (t) => [index('task_instances_user_due_idx').on(t.userId, t.dueAt)],
)

export const events = pgTable(
  'events',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    userId: text('user_id').notNull(),
    type: text('type').notNull(),
    payload: jsonb('payload').notNull(),
    occurredAt: timestamp('occurred_at').notNull().defaultNow(),
  },
  (t) => [index('events_user_time_idx').on(t.userId, t.occurredAt)],
)

export const progression = pgTable('progression', {
  userId: text('user_id').primaryKey(),
  xp: integer('xp').notNull().default(0),
  level: integer('level').notNull().default(1),
  currentStreak: integer('current_streak').notNull().default(0),
  longestStreak: integer('longest_streak').notNull().default(0),
  lastCompletionAt: timestamp('last_completion_at'),
  updatedAt: timestamp('updated_at').notNull().defaultNow(),
})

export const userCategories = pgTable(
  'user_categories',
  {
    userId: text('user_id')
      .notNull()
      .references(() => user.id, { onDelete: 'cascade' }),
    slug: text('slug').notNull(),
    label: text('label').notNull(),
    color: text('color').notNull(),
    sortOrder: integer('sort_order').notNull().default(0),
    createdAt: timestamp('created_at').notNull().defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.userId, t.slug] })],
)

export const apiTokens = pgTable('api_tokens', {
  id: uuid('id').defaultRandom().primaryKey(),
  userId: text('user_id')
    .notNull()
    .references(() => user.id, { onDelete: 'cascade' }),
  name: text('name').notNull(),
  hashedToken: text('hashed_token').notNull().unique(),
  tokenPrefix: text('token_prefix').notNull(),
  lastUsedAt: timestamp('last_used_at'),
  createdAt: timestamp('created_at').notNull().defaultNow(),
  expiresAt: timestamp('expires_at'),
})

// Directed friendship row. One row per send; accepted friendships still
// live as a single row (queried with OR on either side). Blocks are
// one-directional: the blocker's row carries status='blocked'.
export const friendships = pgTable(
  'friendships',
  {
    requesterId: text('requester_id')
      .notNull()
      .references(() => user.id, { onDelete: 'cascade' }),
    addresseeId: text('addressee_id')
      .notNull()
      .references(() => user.id, { onDelete: 'cascade' }),
    status: text('status', {
      enum: ['pending', 'accepted', 'blocked'],
    })
      .notNull()
      .default('pending'),
    createdAt: timestamp('created_at').notNull().defaultNow(),
    respondedAt: timestamp('responded_at'),
  },
  (t) => [
    primaryKey({ columns: [t.requesterId, t.addresseeId] }),
    index('friendships_addressee_status_idx').on(t.addresseeId, t.status),
  ],
)

export const userPrefs = pgTable('user_prefs', {
  userId: text('user_id')
    .primaryKey()
    .references(() => user.id, { onDelete: 'cascade' }),
  shareProgression: boolean('share_progression').notNull().default(true),
  shareActivity: boolean('share_activity').notNull().default(true),
  shareTaskTitles: boolean('share_task_titles').notNull().default(false),
})

export const pushSubscriptions = pgTable('push_subscriptions', {
  id: uuid('id').defaultRandom().primaryKey(),
  userId: text('user_id').notNull(),
  endpoint: text('endpoint').notNull().unique(),
  p256dh: text('p256dh').notNull(),
  auth: text('auth').notNull(),
  deviceLabel: text('device_label'),
  failureCount: integer('failure_count').notNull().default(0),
  lastFailureAt: timestamp('last_failure_at'),
  createdAt: timestamp('created_at').notNull().defaultNow(),
})

