# Notes for Claude

Quick orientation for this codebase. `architecture-plan.md` is the authoritative design doc — check it when making non-trivial changes.

## Package manager

- Use **pnpm** (not npm). Don't commit `package-lock.json`.

## Lint / format / dead code

- Biome (format + lint) and fallow (dead code, dupes, complexity). See `docs/code-quality.md`.
- `pnpm check` is the gate; it also runs from `.githooks/pre-push`. Nothing runs on commit.
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

## Arcade games: onboarding migration

- When adding a new game to `src/games/registry.ts`, ship a companion migration that (a) grants every existing user enough tokens to try it and (b) creates a `try-<gameId>` task (with `external_ref = 'onboarding-try-<gameId>'`) so users actually discover it. `0017_arcade_onboarding.sql` is the pattern — idempotent via the `external_ref` dedup and the `tokens.granted` event reason key.
