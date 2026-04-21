# Notes for Claude

Quick orientation for this codebase. `architecture-plan.md` is the authoritative design doc — check it when making non-trivial changes.

## Package manager

- Use **pnpm** (not npm). Don't commit `package-lock.json`.

## Database migrations

- Schema lives in `src/server/db/schema.ts`. Migrations in `src/server/db/migrations/`.
- Recent migrations are hand-written SQL (`NNNN_name.sql`) with an entry appended to `meta/_journal.json`. `drizzle-kit generate` trips on TTY prompts here, so just write the SQL yourself.
- Prod applies migrations on container boot via `nixpacks.toml` — no manual step needed for deploy.

## Deployment

- Coolify + Nixpacks only. Don't add Dockerfiles or docker-compose. Start command is in `nixpacks.toml`.

## Service worker caching

- `public/sw.js` does stale-while-revalidate on `/api/*`. Bump `CACHE_VERSION` at the top when you change an API response shape — otherwise clients will render the old shape from cache until the SW revalidates.

## Routing (TanStack Start)

- Uses folder-based nested routes (see `src/routes/_authenticated/tasks/` and `stats/`). Flat dot-filename routes like `stats.task.$taskId.tsx` make the sibling `stats.tsx` an implicit layout, which silently breaks the child if the parent has no `<Outlet />`. Prefer folders.
- Server functions (`src/server/functions/*.ts`) are thin wrappers around services (`src/server/services/*.ts`). Put logic in services; keep the function file to auth + input validation.

## Event log is the source of truth

- Completions, categorizations, etc. are append-only events in the `events` table. Progression (XP, streaks) is a projection — undo flows replay events to rebuild state (see `src/server/services/tasks.ts` reopen path). When touching XP/streak logic, read that replay code first.

## Stats / charts

- Charts live in `src/components/stats/charts.tsx` — `XpLineSection` and `TimingDistributionSection`. `TimingDistributionSection` uses monotone cubic (Fritsch-Carlson) interpolation so the curve never dips below 0.
