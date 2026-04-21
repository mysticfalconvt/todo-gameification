# Todo Gameification

A gamified, ADHD-friendly todo PWA with recurring tasks, flexible snoozing, and XP/streak-based motivation. Targets Android as an installed PWA, with room to grow social features later.

## Stack

- **Framework:** TanStack Start (SSR, file-based routing, server functions)
- **Language:** TypeScript
- **Database:** Postgres + Drizzle ORM
- **Auth:** Better Auth (email/password)
- **Jobs:** pg-boss (in-process queue on Postgres)
- **Push:** Web Push API + `web-push` (VAPID)
- **Client state:** TanStack Query with IndexedDB persistence
- **Offline:** custom service worker (stale-while-revalidate for `/api/*`)
- **Deploy:** Coolify + Nixpacks (long-running Node container)

See [`architecture-plan.md`](./architecture-plan.md) for the authoritative design doc — data model, event log, progression, push flow, etc.

## Local development

```bash
pnpm install
pnpm db:migrate        # apply any pending migrations to $DATABASE_URL
pnpm dev               # vite dev on http://localhost:3000
```

Environment variables (at minimum):

- `DATABASE_URL` — Postgres connection string
- `BETTER_AUTH_SECRET` — auth session secret
- `VAPID_PUBLIC_KEY` / `VAPID_PRIVATE_KEY` — for push notifications
- LLM config for the task categorizer / scorer (see `src/server/llm/client.ts`)

## Scripts

```bash
pnpm dev               # dev server
pnpm build             # production build + tsc
pnpm start             # run built server (expects .output/ from build)
pnpm test              # vitest
pnpm db:generate       # drizzle-kit generate migration
pnpm db:migrate        # apply pending migrations
pnpm db:studio         # drizzle studio UI
```

## Database migrations

Migrations live in `src/server/db/migrations/` with a hand-maintained `meta/_journal.json`. Recent migrations are hand-written SQL; drizzle-kit tracks what's been applied. Prod runs `pnpm db:migrate` on boot (see `nixpacks.toml`), so deploys pick up schema changes automatically.

## Deployment

Push to the deploy branch; Coolify rebuilds via Nixpacks. The start command in `nixpacks.toml` runs migrations then starts the Node SSR server.

## Project layout

```
src/
  routes/            # file-based routes (TanStack)
    _authenticated/  # pages that require a session
    auth/            # login/signup/reset flows
  server/
    db/              # drizzle schema + migrations
    services/        # business logic (tasks, categories, progression, ...)
    functions/       # thin TanStack server-fn wrappers (cookie auth)
    llm/             # LLM categorizer + scorer
    middleware/      # auth, etc.
  components/        # shared UI
  lib/               # client-side utilities (hooks, sw registration, ...)
  domain/            # shared types (events, recurrence, progression)
public/
  sw.js              # service worker (push handler + offline cache)
```
