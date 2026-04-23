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
  // Independent of profileVisibility: the community garden has its own
  // tri-state gate so a user can show their garden publicly while
  // keeping the rest of their profile friends-only, or vice versa.
  gardenVisibility: text('garden_visibility', {
    enum: ['public', 'friends', 'private'],
  })
    .notNull()
    .default('friends'),
  // Quiet hours suppress reminder-escalation pushes (not first-time
  // reminders the user explicitly scheduled). Stored as local HH:MM
  // strings; null on either side means "no quiet window."
  quietHoursStart: text('quiet_hours_start'),
  quietHoursEnd: text('quiet_hours_end'),
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
  // Dedup key for tasks auto-created from external systems (e.g.
  // `github-pr-<prId>`). Null for user-created tasks. Unique per user
  // when set — enforced via a partial unique index.
  externalRef: text('external_ref'),
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
  tokens: integer('tokens').notNull().default(0),
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
    description: text('description').notNull().default(''),
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

// Per-email audit log for outbound transactional mail (verification +
// password reset). Used purely for rate limiting: we count recent sends
// to the same address before dispatching another one. Email is stored
// lowercased. Old rows can be pruned later — not urgent since volume is
// tiny.
export const emailSendLog = pgTable(
  'email_send_log',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    email: text('email').notNull(),
    kind: text('kind', {
      enum: ['verification', 'password_reset'],
    }).notNull(),
    sentAt: timestamp('sent_at').notNull().defaultNow(),
  },
  (t) => [index('email_send_log_email_kind_sent_idx').on(t.email, t.kind, t.sentAt)],
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

// Per-user credentials for external services (GitHub for now; structured
// so Jira/Linear/etc. can be added without another table). Token stored
// plaintext — Postgres disk is the trust boundary for this app.
export const userIntegrations = pgTable(
  'user_integrations',
  {
    userId: text('user_id')
      .notNull()
      .references(() => user.id, { onDelete: 'cascade' }),
    provider: text('provider').notNull(), // 'github'
    externalId: text('external_id'), // e.g. GitHub username, for display
    token: text('token').notNull(),
    pollIntervalMinutes: integer('poll_interval_minutes').notNull().default(5),
    lastPolledAt: timestamp('last_polled_at'),
    lastPollError: text('last_poll_error'),
    // Parsed from the `github-authentication-token-expiration` header that
    // GitHub returns on every authenticated response for classic PATs.
    // Null when the token has no expiration or we haven't seen a response
    // yet. Used to create an "expires soon" task 5 days out.
    tokenExpiresAt: timestamp('token_expires_at'),
    createdAt: timestamp('created_at').notNull().defaultNow(),
    updatedAt: timestamp('updated_at').notNull().defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.userId, t.provider] })],
)

// Admin-curated word pool for the Wordle arcade game. Edited from
// /admin/wordle. We log plays in the `events` table with `word` in the
// payload; unseen-word counts are computed per-user on demand, no extra
// "seen" table needed.
export const wordleWords = pgTable('wordle_words', {
  word: text('word').primaryKey(),
  createdBy: text('created_by').references(() => user.id, {
    onDelete: 'set null',
  }),
  createdAt: timestamp('created_at').notNull().defaultNow(),
})

// Per-call audit log for outbound LLM requests. Used by the admin
// dashboard to watch latency + success rate against the single LM Studio
// instance — when load climbs, this is where it shows up. One row per
// call, written fire-and-forget so tracking can't add latency to the
// user-facing path. Old rows can be pruned; volume is tiny.
export const llmCallLog = pgTable(
  'llm_call_log',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    userId: text('user_id'),
    kind: text('kind').notNull(), // 'score' | 'categorize' | 'coach' | ...
    model: text('model'),
    startedAt: timestamp('started_at').notNull().defaultNow(),
    durationMs: integer('duration_ms').notNull(),
    success: boolean('success').notNull(),
    errorMessage: text('error_message'),
    promptTokens: integer('prompt_tokens'),
    completionTokens: integer('completion_tokens'),
    totalTokens: integer('total_tokens'),
    messages: jsonb('messages').$type<Array<{ role: string; content: string }>>(),
    response: text('response'),
  },
  (t) => [
    index('llm_call_log_started_idx').on(t.startedAt),
    index('llm_call_log_user_started_idx').on(t.userId, t.startedAt),
  ],
)

