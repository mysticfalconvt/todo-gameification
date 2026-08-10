# Notes for Claude

Quick orientation for this codebase. `architecture-plan.md` is the authoritative design doc — check it when making non-trivial changes.

## Package manager

- Use **pnpm** (not npm). Don't commit `package-lock.json`.

## Lint / format / dead code

- Biome (format + lint) and fallow (dead code, dupes, complexity). See `docs/code-quality.md`.
- `pnpm check` is the gate; it also runs from `.githooks/pre-push`. Nothing runs on commit.
- The `prepare` script (`scripts/install-hooks.mjs`) enables the hook. It must always exit 0 — pnpm runs `prepare` in the Nixpacks build container too, which has no `.git`, and a failing `prepare` fails the install and breaks the deploy.
- Both tools are **diff-scoped** — the repo carries ~185 lint warnings and ~490 fallow findings as inherited debt, and the gate only fails on newly introduced ones. Don't "fix" this by running the tools whole-tree and committing the result.
- Rules with existing debt are set to `warn` in `biome.json` as a ratchet: clear a category, then flip it to `error`.
- fallow's config is `.fallowrc.json` (`fallow.json` is silently ignored). `dynamicallyLoaded` there covers `src/server/nitro/*.ts` and `public/sw.js`, which are reachable only via string paths in `vite.config.ts` / the browser — without it fallow calls them dead. Add new runtime-loaded entry points there.
- `tsconfig` has `noUnusedLocals`, so `fallow fix` (which only strips `export`) turns unused exports into compile errors. Don't run it expecting a clean tree.

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

## Arcade games: registry is metadata-only

- Adding a game means **two** files: the definition in `src/games/registry.ts` (via its `games/<name>/index.ts`) and the component entry in `src/games/components.tsx`. They're split so server code can read `rewardXp`/`tokenCost`/`tier` without importing game UI — the components import server functions, so a combined registry creates the cycle `registry → *.tsx → server/functions → server/services → registry`.
- Keys in `components.ts` are the game **id**, not the folder name (2048 lives in `two048/` but its id is `'2048'`). A missing entry renders an error panel in the arcade rather than crashing.
- `GameDefinition` deliberately has no `Component` field. Don't add one back.

## Arcade games: onboarding migration

- When adding a new game to `src/games/registry.ts`, ship a companion migration that (a) grants every existing user enough tokens to try it and (b) creates a `try-<gameId>` task (with `external_ref = 'onboarding-try-<gameId>'`) so users actually discover it. `0017_arcade_onboarding.sql` is the pattern — idempotent via the `external_ref` dedup and the `tokens.granted` event reason key.

## Background jobs: client vs registrar

- `src/server/boss.ts` is the pg-boss **client** — singleton, queue provisioning, and the `schedule*`/`cancel*` calls services use. It imports no job handlers.
- `src/server/jobs/register.ts` is the **registrar** — the only module importing handlers. It calls `boss.work(...)` and registers the cron schedules, and runs once per process from `src/server/nitro/bootJobs.ts`.
- `src/server/jobs/queues.ts` holds queue names and job payload types, and must stay import-free.
- This split is what lets a service `import { scheduleReminder } from '../boss'` directly. Handlers import services, so putting worker registration back in `boss.ts` re-creates `boss → jobs → services → boss`. If you find yourself writing `await import('../boss')` to dodge a cycle, something has regressed.
