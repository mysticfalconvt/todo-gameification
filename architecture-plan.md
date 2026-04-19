# Gamified Todo App — Architecture Plan

## Overview

A gamified, ADHD-friendly todo app with recurring tasks, flexible snoozing, XP/streak-based motivation, and multi-user social features (later). Built as a PWA targeting Android primarily, with a long-running Node deployment on Coolify.

**Design priorities:**

- Low friction for capture and completion (ADHD brains need sub-second interactions)
- Gamification that can be iterated on repeatedly without data migrations
- Flexible recurrence (especially "N days after last completion" for chores)
- Short and long-term snoozing
- Simple self-contained infrastructure: Postgres + one Node process

## Technology Stack

| Layer | Choice | Notes |
|---|---|---|
| Framework | TanStack Start | v1 (late 2025). File-based routing, server functions, SSR. |
| Language | TypeScript | End-to-end. |
| Database | Postgres | Self-hosted via Coolify. |
| ORM | Drizzle | Schema-as-TS, lightweight, fast migrations. |
| Auth | Better Auth | Email/password to start; add OAuth providers later. |
| Scheduled jobs | pg-boss | In-process job queue backed by Postgres. |
| Push notifications | Web Push API + `web-push` | VAPID keys; no Firebase dependency. |
| Client state | TanStack Query | Optimistic mutations; IndexedDB persistence. |
| Offline | Service Worker (Serwist or custom Workbox) | Caches GETs; queues mutations. |
| Deployment | Coolify (Nixpacks auto-detect) | Long-running Node container. |

## Architecture Overview

```
┌──────────────────────────────────────────────────────┐
│ Browser / Installed PWA                              │
│  ┌──────────────┐  ┌────────────────────────┐       │
│  │ TanStack     │  │ Service Worker         │       │
│  │ Start (React)│  │  - Push handler        │       │
│  │  + Query     │  │  - Offline queue       │       │
│  │  + IndexedDB │  │  - Asset cache         │       │
│  └──────┬───────┘  └───────────┬────────────┘       │
└─────────┼─────────────────────┬┴────────────────────┘
          │                     │
          │ server fn / HTTP    │ push subscription
          │                     │
┌─────────▼─────────────────────▼─────────────────────┐
│ Node Process (Coolify container)                    │
│  ┌──────────────────────────────────────────────┐   │
│  │ TanStack Start server                        │   │
│  │  ├─ Server functions (CRUD, complete task)   │   │
│  │  ├─ Better Auth handlers                     │   │
│  │  ├─ Web Push sender                          │   │
│  │  └─ Event log writer + progression reducer   │   │
│  └───────────────────┬──────────────────────────┘   │
│  ┌──────────────────▼──────────────────────────┐    │
│  │ pg-boss                                      │   │
│  │  ├─ send-reminder (one-off, scheduled)       │   │
│  │  ├─ cleanup-stale-subs (cron)                │   │
│  │  └─ future: escalation, streak-check, etc.   │   │
│  └─────────────────────────────────────────────┘    │
└────────────────────┬─────────────────────────────────┘
                     │
              ┌──────▼───────┐
              │  Postgres    │
              │  (Coolify)   │
              └──────────────┘
```

## Data Model

Better Auth creates its own `user`, `session`, `account`, and `verification` tables automatically. The application schema below is everything in addition to that.

### Tasks and instances

```ts
import { pgTable, uuid, text, integer, timestamp, boolean, jsonb, index, primaryKey } from 'drizzle-orm/pg-core';

export const tasks = pgTable('tasks', {
  id: uuid('id').defaultRandom().primaryKey(),
  userId: text('user_id').notNull().references(() => user.id, { onDelete: 'cascade' }),
  title: text('title').notNull(),
  notes: text('notes'),
  difficulty: text('difficulty', { enum: ['small', 'medium', 'large'] })
    .notNull().default('medium'),
  xpOverride: integer('xp_override'),              // null = derive from difficulty
  recurrence: jsonb('recurrence').$type<Recurrence>(),  // null = one-off
  snoozeUntil: timestamp('snooze_until'),          // long snooze on whole task
  visibility: text('visibility', { enum: ['private', 'friends', 'public'] })
    .notNull().default('friends'),                 // unused in MVP; reserved for social
  active: boolean('active').notNull().default(true),
  createdAt: timestamp('created_at').notNull().defaultNow(),
  updatedAt: timestamp('updated_at').notNull().defaultNow(),
});

export const taskInstances = pgTable('task_instances', {
  id: uuid('id').defaultRandom().primaryKey(),
  taskId: uuid('task_id').notNull().references(() => tasks.id, { onDelete: 'cascade' }),
  userId: text('user_id').notNull(),               // denormalized for query simplicity
  dueAt: timestamp('due_at').notNull(),
  completedAt: timestamp('completed_at'),
  skippedAt: timestamp('skipped_at'),
  snoozedUntil: timestamp('snoozed_until'),        // short snooze on this instance
  createdAt: timestamp('created_at').notNull().defaultNow(),
}, (t) => ({
  userDueIdx: index('task_instances_user_due_idx').on(t.userId, t.dueAt),
}));

type Recurrence =
  | { type: 'daily' }
  | { type: 'weekly'; daysOfWeek: number[] }        // 0=Sun..6=Sat
  | { type: 'interval'; days: number }              // strict every N days
  | { type: 'after_completion'; days: number };     // N days after last done
```

The `tasks` / `task_instances` split lets you skip or snooze a single occurrence without breaking the recurrence, and makes "what's due today" a trivial indexed query.

### Event log and derived state

```ts
export const events = pgTable('events', {
  id: uuid('id').defaultRandom().primaryKey(),
  userId: text('user_id').notNull(),
  type: text('type').notNull(),                    // 'task.completed', 'task.skipped', etc.
  payload: jsonb('payload').notNull(),
  occurredAt: timestamp('occurred_at').notNull().defaultNow(),
}, (t) => ({
  userTimeIdx: index('events_user_time_idx').on(t.userId, t.occurredAt),
}));

export const progression = pgTable('progression', {
  userId: text('user_id').primaryKey(),
  xp: integer('xp').notNull().default(0),
  level: integer('level').notNull().default(1),
  currentStreak: integer('current_streak').notNull().default(0),
  longestStreak: integer('longest_streak').notNull().default(0),
  lastCompletionAt: timestamp('last_completion_at'),
  updatedAt: timestamp('updated_at').notNull().defaultNow(),
});
```

**Events are append-only and the source of truth for all gamification.** `progression` is derived state — it exists for query performance, but can be rebuilt from `events` at any time by replaying them through the current reducer. This is the key to iterating on gamification without data migrations.

### Push subscriptions

```ts
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
});
```

One row per device. Failed pushes bump `failureCount`; the cleanup cron deletes subscriptions above a threshold.

### Social (deferred; v0.3+)

```ts
export const friendships = pgTable('friendships', {
  userId: text('user_id').notNull(),
  friendId: text('friend_id').notNull(),
  status: text('status', { enum: ['pending', 'accepted', 'blocked'] })
    .notNull().default('pending'),
  createdAt: timestamp('created_at').notNull().defaultNow(),
  acceptedAt: timestamp('accepted_at'),
}, (t) => ({
  pk: primaryKey({ columns: [t.userId, t.friendId] }),
}));

export const userPrefs = pgTable('user_prefs', {
  userId: text('user_id').primaryKey(),
  shareTaskTitles: boolean('share_task_titles').notNull().default(false),
  shareProgression: boolean('share_progression').notNull().default(true),
  shareActivity: boolean('share_activity').notNull().default(true),
});
```

## Gamification Design

### XP values

Self-reported difficulty drives base XP, with a streak multiplier:

- Small: 10 XP
- Medium: 25 XP (default)
- Large: 60 XP

Streak multiplier: `1 + min(currentStreak, 30) * 0.02` — caps at 1.6x at 30 days. `xpOverride` on the task bypasses difficulty entirely.

### Level curve

Simple quadratic: `level = floor(sqrt(xp / 50)) + 1`. Level 2 at 50 XP, level 3 at 200, level 10 at 4500. Tune as needed — this value lives in a single pure function.

### Streak logic

`currentStreak` increments by 1 per day on which at least one task is completed. Missing a day resets it to 0. `longestStreak` only goes up.

Implemented as a reducer over events. Pseudocode:

```ts
function applyEvent(state: Progression, event: Event): Progression {
  switch (event.type) {
    case 'task.completed': {
      const xpGain = computeXp(event.payload, state.currentStreak);
      const streak = isNewDay(state.lastCompletionAt, event.occurredAt)
        ? state.currentStreak + 1
        : state.currentStreak;
      return {
        ...state,
        xp: state.xp + xpGain,
        level: levelFor(state.xp + xpGain),
        currentStreak: streak,
        longestStreak: Math.max(state.longestStreak, streak),
        lastCompletionAt: event.occurredAt,
      };
    }
    // ...
  }
}
```

Kept as a pure function → trivially testable, rebuildable from `events` at any time.

### LLM-assigned XP (optional)

When `LLM_BASE_URL` + `LLM_MODEL` are configured, task creation calls an OpenAI-compatible chat/completions endpoint (e.g. a local LM Studio server) and asks the model to classify the task into one of six fixed tiers:

| Tier | XP |
|---|---|
| tiny | 5 |
| small | 10 |
| medium | 25 |
| large | 50 |
| huge | 100 |
| massive | 200 |

The system prompt ships a strict rubric (cognitive load + ADHD-friction-aware, with concrete examples) and forces JSON output at temperature 0.1 via `response_format: { type: 'json_object' }`. The classification — not a free-form integer — is what keeps scoring consistent across users. The returned XP is written to `tasks.xpOverride`; streak and punctuality multipliers apply on top at completion time.

If the LLM call fails, times out (10s default), returns unparseable output, or the env vars aren't set, `xpOverride` stays `null` and the task falls back to the difficulty-based default. The flow is fully graceful — no hard dependency on a running LLM.

### Iteration strategy

Because progression is derived from events, **any change to the rules is a code change, not a data migration**:

- Change XP values → update `computeXp()` → replay events → done.
- Want a pet that levels up instead of a bar? → write a new `Companion` table + a new reducer → replay events → done.
- Add achievements? → emit new event types, add reducer → old events get them retroactively.

## Scheduled Jobs (pg-boss)

pg-boss runs in the same Node process as the Start server and uses Postgres for persistence. No Redis, no external scheduler, no separate worker process.

### Queues

| Queue | Type | Trigger | Purpose |
|---|---|---|---|
| `send-reminder` | One-off, delayed | Scheduled on instance creation/update | Push notification at `dueAt` (or before) |
| `cleanup-stale-subs` | Cron, daily | `0 3 * * *` | Remove push subs with high failure count |
| `rebuild-progression` | One-off, ad-hoc | Manual trigger or after reducer change | Replay events for a user |

### Scheduling a reminder

```ts
await boss.send(
  'send-reminder',
  { taskInstanceId, kind: 'due' },
  {
    startAfter: dueAt,
    singletonKey: `reminder-${taskInstanceId}-due`,  // idempotency
    retryLimit: 3,
    retryBackoff: true,
  }
);
```

The `singletonKey` guarantees that even if the scheduling code runs twice (retry, race, double-click), only one job is queued.

### Reminder worker

Handlers **verify current state** rather than trusting the payload, since the task may have been completed or snoozed between scheduling and firing:

```ts
await boss.work('send-reminder', async ([job]) => {      // note: batched
  const { taskInstanceId, kind } = job.data;

  const instance = await db.query.taskInstances.findFirst({
    where: eq(taskInstances.id, taskInstanceId),
  });

  if (!instance) return;                                  // deleted
  if (instance.completedAt || instance.skippedAt) return; // already done
  if (instance.snoozedUntil && instance.snoozedUntil > new Date()) return;

  const subs = await db.query.pushSubscriptions.findMany({
    where: eq(pushSubscriptions.userId, instance.userId),
  });

  await Promise.allSettled(
    subs.map((sub) => sendWebPush(sub, buildPayload(instance, kind)))
  );
});
```

`Promise.allSettled` so one dead subscription doesn't trigger a retry that double-sends to working devices.

### pg-boss v10 gotchas

- Queues must be created explicitly with `boss.createQueue()` before sending.
- `boss.work()` handlers receive an **array** of jobs by default (batching). Easy to accidentally only handle `jobs[0]`.
- Retries default to 2 — handlers must be idempotent or set `retryLimit: 0`.
- Requires Node 20+ and Postgres 13+.
- Import: `import { PgBoss } from 'pg-boss'` (destructured).

### Bootstrap

```ts
let boss: PgBoss | null = null;

export async function getBoss() {
  if (boss) return boss;
  boss = new PgBoss(process.env.DATABASE_URL!);
  boss.on('error', (e) => console.error('pg-boss error', e));
  await boss.start();

  await boss.createQueue('send-reminder');
  await boss.createQueue('cleanup-stale-subs');

  await boss.work('send-reminder', sendReminderHandler);
  await boss.work('cleanup-stale-subs', cleanupStaleSubsHandler);

  await boss.schedule('cleanup-stale-subs', '0 3 * * *');

  return boss;
}
```

Call `getBoss()` once on server boot.

## Recurrence and Snoozing

### Recurrence types

- `daily` — every day
- `weekly` — specific days of the week
- `interval` — strictly every N days (regardless of completion)
- `after_completion` — N days *after* last completion (the "mow the lawn" case)

### Materialization

When a recurring task's instance is completed or skipped, **synchronously** materialize the next instance. No cron needed for this:

```ts
async function completeInstance(instanceId: string) {
  await db.transaction(async (tx) => {
    const instance = await tx.update(taskInstances)
      .set({ completedAt: new Date() })
      .where(eq(taskInstances.id, instanceId))
      .returning()[0];

    const task = await tx.query.tasks.findFirst({ where: eq(tasks.id, instance.taskId) });

    // Write the event
    await tx.insert(events).values({
      userId: task.userId,
      type: 'task.completed',
      payload: { taskId: task.id, instanceId, difficulty: task.difficulty },
    });

    // Update progression (or re-derive in a separate step)
    await applyEventInTx(tx, task.userId, event);

    // Spawn next occurrence if recurring
    if (task.recurrence && task.active) {
      const nextDue = computeNextDue(task.recurrence, new Date(), instance.dueAt);
      await tx.insert(taskInstances).values({
        taskId: task.id,
        userId: task.userId,
        dueAt: nextDue,
      });
      // Schedule the reminder for the new instance
      await boss.send('send-reminder', { ... }, { startAfter: nextDue, singletonKey: ... });
    }
  });
}
```

### Timezone handling

Store a `timezone` column on the user (IANA name like `America/Chicago` — **not** UTC offset, which breaks across DST). Compute each `dueAt` in UTC based on the user's local intent at the moment of scheduling. Use `date-fns-tz` or `Luxon` — avoid manual offset math. Recompute next occurrences rather than adding fixed intervals, so DST shifts don't drift reminders.

### Snooze semantics

Three distinct operations:

- **Short snooze** (instance-level): set `task_instances.snoozedUntil`. The reminder worker no-ops if current time is before `snoozedUntil`; you may also want to cancel and re-schedule the push to fire at `snoozedUntil`.
- **Long snooze** (task-level): set `tasks.snoozeUntil`. Task doesn't generate new instances and existing instances are hidden from "today" view until then. Use case: "don't bug me about mowing until April."
- **Skip**: set `task_instances.skippedAt`, emit `task.skipped` event, materialize next instance if recurring. This advances the recurrence without marking complete.

## Notifications

### Setup

1. Generate VAPID keys once (`web-push generate-vapid-keys`). Store in env vars.
2. Service worker handles `push` and `notificationclick` events.
3. On client, after install + login: request `Notification.permission`, then `registration.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: VAPID_PUBLIC })`.
4. POST the subscription to a server function, store in `push_subscriptions`.

### Service worker push handler

```ts
self.addEventListener('push', (event) => {
  const data = event.data?.json();
  event.waitUntil(
    self.registration.showNotification(data.title, {
      body: data.body,
      icon: '/icon-192.png',
      badge: '/badge-72.png',
      tag: data.tag,                    // groups/replaces related notifications
      actions: [
        { action: 'complete', title: '✓ Done' },
        { action: 'snooze', title: '⏰ 1h' },
      ],
      data: { taskInstanceId: data.taskInstanceId, url: data.url },
    })
  );
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const { action } = event;
  const { taskInstanceId, url } = event.notification.data;

  if (action === 'complete') {
    event.waitUntil(fetch('/api/tasks/complete', {
      method: 'POST',
      body: JSON.stringify({ taskInstanceId }),
    }));
  } else if (action === 'snooze') {
    event.waitUntil(fetch('/api/tasks/snooze', {
      method: 'POST',
      body: JSON.stringify({ taskInstanceId, hours: 1 }),
    }));
  } else {
    event.waitUntil(clients.openWindow(url));
  }
});
```

**Notification actions are the killer feature for ADHD**: the user can mark things done from the notification shade without opening the app. Build this pattern early.

### Reminder rules

Per-task reminder configuration lives in a `reminders` JSONB on the task:

```ts
type ReminderRule =
  | { offset: '-1h' | '-30m' | '0' }              // relative to dueAt
  | { timeOfDay: '08:00'; daysOfWeek?: number[] }; // absolute time
```

v0.1 ships one fixed rule (`offset: '0'`). v0.2 exposes configuration per task. v0.3 adds escalation (repeat every 2h if ignored).

## Local-First Client Strategy

### Option A: TanStack Query + persistence + SW queue

No new libraries beyond what Start already pulls in. Three layers:

**1. Optimistic mutations** via `useMutation` with `onMutate` / `onError` / `onSettled`:

```ts
const completeTask = useMutation({
  mutationFn: (instanceId) => serverFn.completeTask({ instanceId }),
  onMutate: async (instanceId) => {
    await qc.cancelQueries({ queryKey: ['tasks', 'today'] });
    const prev = qc.getQueryData(['tasks', 'today']);
    qc.setQueryData(['tasks', 'today'], (old) =>
      old?.map((t) => t.id === instanceId ? { ...t, completedAt: new Date() } : t)
    );
    return { prev };
  },
  onError: (_err, _id, ctx) => qc.setQueryData(['tasks', 'today'], ctx?.prev),
  onSettled: () => qc.invalidateQueries({ queryKey: ['tasks'] }),
});
```

**2. Query cache persistence** with `@tanstack/query-persist-client-core` using `idb-keyval` as the IndexedDB adapter. Cache survives page reloads and app close.

**3. Service worker**:

- **GET requests**: stale-while-revalidate caching for routes and API responses.
- **Mutations** (POST/PATCH/DELETE): when offline, queue in IndexedDB and replay on `online` event. Use Background Sync API where available (Android supports it).

### Service worker strategy

Caching strategy by request type:

- App shell (`/`, `/today`, `/tasks`): network-first with offline fallback.
- Static assets (JS, CSS, images): cache-first with revalidation.
- API GETs: stale-while-revalidate.
- API mutations: network-only, queued on failure.

### TanStack Start + PWA caveat

`vite-plugin-pwa` currently doesn't integrate cleanly with TanStack Start's Vite 6 environment-aware build pipeline. Known working approaches:

1. **Serwist** with a custom Vite plugin. Working example exists in a GitHub discussion (search "TanStack Start Serwist").
2. **Post-build Workbox script**: let Start build normally, then run a Node script using `workbox-build.injectManifest()` to generate `sw.js` into the client dist.

Budget half a day to get the service worker generating and hot-reloading correctly in dev.

## Authentication

Better Auth with email/password first. Schema is managed by Better Auth itself — you configure, it creates `user`, `session`, `account`, `verification`.

### Minimal config

```ts
import { betterAuth } from 'better-auth';
import { drizzleAdapter } from 'better-auth/adapters/drizzle';

export const auth = betterAuth({
  database: drizzleAdapter(db, { provider: 'pg' }),
  emailAndPassword: {
    enabled: true,
    requireEmailVerification: false,   // v0.1 simplicity; enable in v0.2
  },
  session: {
    expiresIn: 60 * 60 * 24 * 30,      // 30 days
  },
});
```

### Extension path

Adding Google / Apple / GitHub later is config-only:

```ts
socialProviders: {
  google: { clientId: ..., clientSecret: ... },
}
```

No schema changes; Better Auth's `account` table handles provider linking.

### Session handling in Start

Use a middleware on protected server functions that reads the session via `auth.api.getSession()` and passes `userId` through context.

## PWA Install Flow

### Android (Chrome, Samsung Internet, etc.)

```ts
let deferredPrompt: BeforeInstallPromptEvent | null = null;

window.addEventListener('beforeinstallprompt', (e) => {
  e.preventDefault();
  deferredPrompt = e;
});

async function promptInstall() {
  if (!deferredPrompt) return;
  await deferredPrompt.prompt();
  const { outcome } = await deferredPrompt.userChoice;
  // log outcome server-side
  deferredPrompt = null;
}

window.addEventListener('appinstalled', () => {
  // persist so we stop prompting
});
```

Trigger `promptInstall()` after login + first successful task completion — the user has received value and the prompt lands well.

### iOS (deferred, v0.2+)

No `beforeinstallprompt` equivalent. Show a dismissable instruction card when you detect iOS Safari: "Tap the share icon, then Add to Home Screen."

## Multi-User / Social (v0.3+)

### Friends

Bidirectional `friendships` table with a `status` field. Two rows per accepted friendship (one each direction) to keep queries simple.

### Activity feed

A query over `events` joined with `friendships`:

```sql
SELECT e.*
FROM events e
WHERE e.user_id IN (
  SELECT friend_id FROM friendships
  WHERE user_id = $1 AND status = 'accepted'
)
  AND e.occurred_at > $2
ORDER BY e.occurred_at DESC
LIMIT 50;
```

Respect per-event privacy: the server filters based on `user_prefs.shareActivity` and the task's `visibility`.

### Leaderboards

For a small friend group, a live leaderboard is a simple join of `friendships` + `progression`. For larger groups, materialize weekly/monthly aggregates into a separate table.

**Design note for ADHD:** avoid raw XP leaderboards. Consider:

- "Streak leaderboard" — rewards consistency, not volume.
- "Personal improvement" — this week vs. four-week average.
- "Showed up today" — binary, daily reset, celebrates presence.

### Shared/claimable tasks (future)

Shared chores among roommates: extend `tasks` with an optional `householdId`. Any household member can claim today's instance. `task_instances` gets a nullable `assignedUserId`.

### Reactions

New event types: `task.cheered`, `reaction.added`. Small bonus XP for receiving reactions (careful with gameability).

## Deployment (Coolify)

### Build

Coolify's Nixpacks auto-detects Node apps from `package.json`. Define the build in scripts:

**Node version pin.** A `nixpacks.toml` in the repo root pins `nodejs_23` because Nixpacks' default `nodejs_22` currently resolves to 22.11, which is below Vite 8's minimum (20.19+ or 22.12+). When Vite runs on 22.11 its embedded rolldown bundler fails to load its native binding and the build crashes. Whenever Nixpacks updates its nixpkgs pin past Node 22.12, this override can be revisited.


```json
{
  "scripts": {
    "build": "tsc && vite build",
    "start": "node .output/server/index.mjs",
    "db:migrate": "drizzle-kit migrate"
  }
}
```

Nixpacks will run `npm install`, `npm run build`, and `npm start`. A Dockerfile is only needed if you outgrow defaults (e.g., needing system packages).

### Environment variables

| Var | Purpose |
|---|---|
| `DATABASE_URL` | Postgres connection (Coolify provides) |
| `BETTER_AUTH_SECRET` | Long random string (session signing) |
| `BETTER_AUTH_URL` | Public URL, needed for OAuth callbacks later |
| `VAPID_PUBLIC_KEY` | Web Push public key (exposed to client) |
| `VAPID_PRIVATE_KEY` | Web Push private key (server only) |
| `VAPID_SUBJECT` | `mailto:you@example.com` (required by Web Push spec) |
| `NODE_ENV` | `production` |
| `TZ` | `UTC` (keep server in UTC; convert per user) |

### Health check

Expose `GET /api/health` that runs `SELECT 1`. Coolify uses this to detect readiness. Keep it minimal — don't check pg-boss or external services, or you'll get flappy restart loops.

### Migrations

Two patterns; pick one:

1. **Run on boot**: start script does `npm run db:migrate && node .output/server/index.mjs`. Simple, idempotent, adds seconds to boot.
2. **Pre-deploy step in Coolify**: cleaner separation, requires Coolify command config.

Start with #1.

### Graceful shutdown

pg-boss mid-job + SIGTERM = orphaned work unless handled:

```ts
async function shutdown(signal: string) {
  console.log(`Received ${signal}, shutting down`);
  await boss?.stop({ graceful: true, timeout: 30_000 });
  await db.$client.end?.();
  process.exit(0);
}
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
```

### Backups

Enable Coolify's Postgres snapshot schedule. Configure offsite to S3 or similar — snapshots on the same VPS don't help if the VPS dies.

### Single-instance assumption

No horizontal scaling means: pg-boss in-process, sessions in Postgres, no sticky sessions, no Redis. If you ever scale to multiple instances, pg-boss's `FOR UPDATE SKIP LOCKED` and Postgres-backed sessions already handle it — nothing to re-architect.

## Project Structure

```
src/
├── routes/                      # TanStack Start file-based routes
│   ├── __root.tsx
│   ├── index.tsx                # redirects to /today
│   ├── today.tsx
│   ├── tasks/
│   │   ├── index.tsx
│   │   ├── new.tsx
│   │   └── $taskId.tsx
│   └── auth/
│       ├── login.tsx
│       └── signup.tsx
├── server/
│   ├── db/
│   │   ├── schema.ts            # all Drizzle schemas
│   │   ├── client.ts            # Postgres connection
│   │   └── migrations/
│   ├── auth.ts                  # Better Auth config
│   ├── boss.ts                  # pg-boss bootstrap
│   ├── functions/               # TanStack Start server functions
│   │   ├── tasks.ts
│   │   ├── instances.ts
│   │   └── progression.ts
│   ├── jobs/                    # pg-boss handlers
│   │   ├── sendReminder.ts
│   │   └── cleanupStaleSubs.ts
│   └── push/
│       └── webPush.ts
├── domain/                      # pure logic, no I/O
│   ├── recurrence.ts            # computeNextDue
│   ├── gamification.ts          # reducers, XP, levels
│   └── events.ts                # event types
├── components/
├── lib/
│   ├── query.ts                 # TanStack Query client + persister
│   └── sw/
│       ├── register.ts
│       └── sw.ts                # service worker source
└── styles/
```

**Key idea:** `domain/` is pure functions, no database or network. All gamification logic lives there. Trivially testable:

```ts
// domain/gamification.test.ts
test('completing a medium task adds 25 XP', () => {
  const result = applyEvent(
    { xp: 0, currentStreak: 0, ... },
    { type: 'task.completed', payload: { difficulty: 'medium' }, ... }
  );
  expect(result.xp).toBe(25);
});
```

## External API (v0.3)

Beyond the browser app, tasks and progression should be reachable from machines: Home Assistant dashboards, LLM agents, future desktop/CLI clients. This is what turns the app from "a todo list I look at" into "a substrate other things can build on."

### Why

- **Home Assistant** — show today's open count on a dashboard, blink a light when the streak is at risk, let a physical button mark a habit done.
- **LLM agents** — an assistant that can see what I should be doing, propose new tasks from a chat transcript, and mark things complete when I tell it.
- **Future clients** — a CLI, a widget, a different frontend. Keep the option open.

### Authentication

Machines don't do browser cookies. Use long-lived per-user **API tokens**:

- **Preferred implementation:** Better Auth's `apiKey` plugin (same user/session schema, no extra tables for secrets, built-in hashing and verification).
- **Fallback if the plugin doesn't fit:** custom `api_tokens` table `(id, userId, name, hashedToken, lastUsedAt, createdAt, expiresAt)` with SHA-256 hashing at rest.
- **Transport:** `Authorization: Bearer tgx_<random>` header. The `tgx_` prefix makes tokens greppable and eligible for GitHub secret-scanning partner programs later.
- **Scope:** v0.3 ships all-or-nothing tokens (any operation the owner can do). Per-token read-only / write scopes come after real use reveals where the lines should be.

### Endpoints (versioned under `/api/v1`)

| Method | Path | Purpose |
|---|---|---|
| GET | `/api/v1/today` | Today's open instances |
| GET | `/api/v1/tasks` | All active tasks for the user |
| POST | `/api/v1/tasks` | Create a task |
| GET | `/api/v1/tasks/:id` | Task detail + recent instances |
| PATCH | `/api/v1/tasks/:id` | Update title / notes / difficulty / recurrence / snooze |
| DELETE | `/api/v1/tasks/:id` | Soft delete (sets `active = false`) |
| POST | `/api/v1/instances/:id/complete` | Mark done (same logic as in-app complete) |
| POST | `/api/v1/instances/:id/skip` | Skip; materialize next if recurring |
| POST | `/api/v1/instances/:id/snooze` | Body: `{ hours }` or `{ until: ISO }` |
| GET | `/api/v1/progression` | `{ xp, level, currentStreak, longestStreak }` |
| GET | `/api/v1/events?since=...&limit=` | Paginated event log (useful for LLM context) |

Responses: `{ data: ... }` on success, `{ error: { code, message } }` on failure. Timestamps are ISO 8601 UTC strings. No response envelope changes between versions without a version bump.

### No logic duplication

The REST handlers must not re-implement task logic. Before the API ships, extract the bodies of the existing Start server functions into pure service functions under `src/server/services/` (e.g. `services/tasks.ts` with `createTask`, `completeInstance`, `skipInstance`, `snoozeInstance`, `listTodayInstances`, etc.). Both the server functions (browser) and the REST routes (machines) call the same services. This is the same discipline that keeps `domain/` pure — the closer a change gets to the data model, the fewer copies of the logic exist.

### Token management UI

`/settings/api-tokens`:

- Create a token — shown once in full, then only the hashed form and a prefix for identification.
- Name it (e.g. "Home Assistant", "LLM agent").
- See `lastUsedAt` to spot dead tokens.
- Revoke.

### Out of scope for v0.3

- Rate limiting — tokens are per-user, so abuse only hurts the owner. Add if real pain appears.
- CORS — server-to-server consumption, no browser cross-origin need. If a browser client ever needs it, add narrow allowlisting.
- OpenAPI spec generation — nice for auto-generating LLM tools; worth it once the surface stabilizes.
- Scoped tokens (read-only vs read-write). Deferred until use reveals the scopes.
- Webhooks / outbound events.

### MCP server (shipped)

A Model Context Protocol server at `/api/mcp` wraps the same `src/server/services/` functions the REST API uses. Tools: `list_today`, `list_someday`, `list_tasks`, `get_task`, `create_task`, `complete_instance`, `skip_instance`, `snooze_instance`, `snooze_task`, `delete_task`, `get_progression`, `list_recent_activity`. Auth is the same `Authorization: Bearer tgx_…` header as REST. Stateless transport: one `WebStandardStreamableHTTPServerTransport` per request, so there's no session storage to maintain server-side. Claude Desktop picks it up via `claude_desktop_config.json` with a `url` + `headers` entry — the UI doc at `/settings/api-docs` has the copy-paste config.

### Home Assistant reference integration

Full copy-paste config lives at [`docs/home-assistant.md`](./docs/home-assistant.md): REST sensors (due-today count, level, XP, streak, longest streak), `rest_command` entries for complete/skip/snooze/create, a list-card example, and a troubleshooting section.

## Roadmap

### v0.1 — MVP (self-use)

- Better Auth with email/password
- Create/edit/delete one-off and recurring tasks
- All four recurrence types including `after_completion`
- Mark complete / skip / short-snooze (instance-level)
- Today view, upcoming view, all tasks view
- Event log + progression (XP, current streak)
- PWA installable on Android with working service worker
- Service worker caches assets + GET routes
- Optimistic mutations via TanStack Query
- pg-boss in-process
- Manual push subscription + one hardcoded test notification
- Deployed on Coolify

### v0.2 — Notifications and polish

- Real reminder scheduling via pg-boss + Web Push
- Notification actions (complete / snooze from notification)
- Long snooze (task-level, e.g., mowing until April)
- Streak visualization in UI
- Offline mutation queue with background sync on reconnect
- iOS install instructions card
- Email verification on signup

### v0.3 — External API & integrations

- Extract server-fn bodies into `src/server/services/` (no logic divergence between browser and REST paths)
- API token auth (Better Auth `apiKey` plugin preferred; custom `api_tokens` table as fallback)
- REST endpoints under `/api/v1` covering tasks, instances, progression, and the event log
- `/settings/api-tokens` UI: create / name / last-used / revoke
- Home Assistant reference config in the repo's docs
- Contract tests against `services/` so server fns and REST routes stay in sync

### v0.4 — Social

- Friend requests + acceptance flow
- Privacy preferences per user
- Activity feed (derived from events)
- Consistency-focused leaderboard (streaks, not raw XP)
- Task `visibility` enforcement
- Cheers / reactions on friend completions

### v0.5+ — Iteration

- Alternative progression UIs (pets, plants, whatever) — driven by replaying events through new reducers
- Shared household tasks
- OAuth providers (Google, Apple, GitHub) via Better Auth
- Reminder escalation (nudge again after 2h of ignoring)
- Dashboard package for pg-boss monitoring
- TanStack DB migration if complex client queries become painful
- MCP server wrapping `src/server/services/` for richer LLM tool integration
- OpenAPI spec emitted from the REST layer for auto-generated LLM tools

## Things to Watch Out For

- **Nixpacks Node version drift.** Nixpacks bakes a nixpkgs commit that controls which Node `nodejs_XX` resolves to. At time of writing `nodejs_22` = 22.11, below Vite 8's 22.12+ floor. If you upgrade Vite or rolldown and deploys start failing with "Cannot find native binding", the nixpacks pin has slipped behind again — update `nixpacks.toml` to the next available major.
- **TanStack Start + PWA tooling** is rough. Plan time for service worker setup; have Next.js as an escape hatch if it becomes a blocker.
- **Service worker scope and origin rules** — must be served from app origin, path matters. Don't put Start behind a path prefix.
- **DST and timezones** — never store UTC offsets, always IANA names. Recompute next occurrences rather than adding fixed intervals.
- **pg-boss v10 breaking changes** — most tutorials online are for v9. Trust the official docs only.
- **iOS PWA limitations** — storage eviction after ~7 days of inactivity, no install prompt API. Not blocking since Android-first, but relevant if iOS gets prioritized.
- **Copyright/privacy on task content** — tasks are personal. Ensure search and logs don't leak task titles in error messages or telemetry.
- **Notification fatigue** — ADHD-specific risk. Fewer, better-timed notifications beat more. Build observability for "notifications sent vs. acted on" early.

## Open Decisions Deferred

These decisions are explicitly deferred to keep MVP scope tight:

- Specific push notification copy and tone
- Badge/achievement system
- Category or tag system for tasks
- Calendar integration (Google Calendar sync)
- Widget support (would require native, not PWA)
- Voice/Siri integration for quick capture
- Rich-text notes on tasks
- Attachments on tasks
