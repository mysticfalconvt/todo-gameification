**AGENTS MD – Quick Reference for OpenCode Sessions**

- **Dev Setup & Core Commands**
  - `pnpm install` – install deps.
  - `pnpm db:migrate` – apply pending migrations (runs on container boot).
  - `pnpm dev` – start Vite SSR dev server (`http://localhost:3000`).
  - `pnpm build` → `pnpm start` – production build then run built `.output/`.
  - `pnpm test` – Vitest suite.
  - `pnpm db:generate` – hand‑write new SQL migration and update `meta/_journal.json`.

- **Environment**
  - Required vars: `DATABASE_URL`, `BETTER_AUTH_SECRET`, `VAPID_PUBLIC_KEY`, `VAPID_PRIVATE_KEY`.
  - LLM config for task categorizer/scorer lives in `src/server/llm/client.ts`.

- **Database / Drizzle**
  - Schema in `src/server/db/schema.ts`; migrations are hand‑written SQL files under `src/server/db/migrations/` with an idempotent entry in `meta/_journal.json`.
  - Never rely on `drizzle-kit generate` prompts; write migration SQL manually.

- **Routing (TanStack Start)**
  - Folder‑based routes only. A file like `stats.task.$taskId.tsx` creates an implicit layout (`stats.tsx`). If the parent lacks `<Outlet />`, child pages break – always use a folder when you need a nested route.
  - `_authenticated/` contains all pages requiring a session.

- **Server Functions**
  - Thin wrappers in `src/server/functions/*.ts`; real logic lives in corresponding services under `src/server/services/*`.
  - Keep auth & input validation here; move business rules to services.

- **Event Log is Source of Truth**
  - All state changes (XP, streaks, task completions) are append‑only events in the `events` table.
  - Re‑play logic lives in `src/server/services/tasks.ts`. When modifying progression, read that replay code first.

- **Service Worker Caching**
  - `public/sw.js` uses stale‑while‑revalidate for `/api/*`.
  - Bump `CACHE_VERSION` at the top whenever an API response shape changes; otherwise clients may keep outdated shapes.

- **Arcade Game Onboarding Migration Pattern**
  - Adding a new game → update `src/games/registry.ts`.
  - Ship companion migration that:
    1. Grants every existing user enough tokens to try the game.
    2. Creates a `try‑<gameId>` task with `external_ref = 'onboarding-try-<gameId>'` (idempotent via dedup and `tokens.granted` event reason key).
  - Use `0017_arcade_onboarding.sql` as the template.

- **Testing Quirks**
  - Vitest runs against an in‑memory SQLite fallback unless `DATABASE_URL` points to a real Postgres instance.
  - For integration tests that need background jobs, start `pg-boss` via `pnpm dev` (the dev server launches the queue automatically).

- **Helpful Docs & Sources**
  - Authoritative design: `architecture-plan.md`.
  - Existing instruction baseline: `CLAUDE.md`.   

*Only add or modify entries here when a future OpenCode agent would otherwise miss these repo‑specific nuances.*