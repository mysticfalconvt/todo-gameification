# Code quality tooling

Biome (format + lint) and [fallow](https://github.com/fallow-rs/fallow) (structural
analysis) run behind a pre-push gate. This documents what they check, what was
fixed when they were adopted, and what's deliberately left.

## Commands

| Command | What it does |
|---|---|
| `pnpm check` | The gate. Format/lint + typecheck + fallow, scoped to the diff. |
| `pnpm format` | Rewrite files to Biome's formatting. |
| `pnpm lint` | Format + lint check, whole tree, no writes. |
| `pnpm lint:fix` | Apply every safe autofix. |
| `pnpm typecheck` | `tsc --noEmit`. |
| `pnpm fallow` | Full structural scan (dead code, dupes, complexity). |
| `pnpm fallow:audit` | Only what changed vs `origin/main`. |
| `pnpm fallow:fix` | Preview fallow's dead-code removals (dry run). |

## When it runs

Nothing runs on commit — commit in-progress work freely. `.githooks/pre-push`
runs `scripts/check.sh` once, before anything leaves the machine. The hook is
enabled by `core.hooksPath`, set by the `prepare` script on `pnpm install`.

Bypass with `git push --no-verify`.

### Why the gate is diff-scoped

A full-tree run still reports ~185 lint warnings and ~490 fallow findings. A gate
that always fails is a gate people learn to bypass, so both tools compare against
a base ref:

- `biome check --changed --since=<base>` — only files in the diff.
- `fallow audit --base <base> --gate new-only` — fallow snapshots the base and
  attributes each finding, so inherited debt is excluded and only *newly
  introduced* findings fail.

The base is the remote's current SHA (git hands it to the pre-push hook on
stdin), falling back to the branch upstream, then `origin/main`.

`tsc` runs whole-project regardless — a change in one file breaks consumers
three modules away, and there's no meaningful diff mode for typechecking.

## Config

- `biome.json` — matched to the pre-existing house style so adoption wasn't a
  rewrite: single quotes, no semicolons, 2-space indent, 100 col (p99 line
  length was 111). `src/routeTree.gen.ts` and SQL migrations are excluded.
- `.fallowrc.json` — note the filename; `fallow.json` is silently ignored.

### The `dynamicallyLoaded` entries matter

fallow builds a module graph and calls anything unreachable dead. Three files
are reachable only through mechanisms it can't see statically, and without this
config it reports all three as unused files:

- `src/server/nitro/*.ts` — registered as **string paths** in `vite.config.ts`,
  not imports.
- `public/sw.js` — fetched by the browser, never imported.

If you add another runtime-loaded entry point, add it here or fallow will
propose deleting it.

## What was fixed on adoption

Lint errors went 131 → 0, infos 219 → 1. Verified after each batch with
`tsc --noEmit`, the full test suite, and a production build.

### Mechanical, applied by autofix

| Rule | Count | Change |
|---|---|---|
| `complexity/useLiteralKeys` | 209 | `obj['key']` → `obj.key` |
| `complexity/useOptionalChain` | 13 | `a && a.b` → `a?.b` |
| `style/useTemplate` | 6 | string concat → template literal |
| `complexity/noUselessFragments` | 2 | dropped redundant `<>…</>` |
| `complexity/noUselessSwitchCase` | 1 | removed case falling straight to default |
| `style/useConst` | 1 | `let` never reassigned |

Plus a whole-repo format pass: **167 of 223 files**. Behaviour-neutral — the same
4 tests failed before and after (see below).

### `suspicious/noGlobalIsNan` — 4, in `tasks/new.tsx`

`isNaN(...)` → `Number.isNaN(...)`. Normally a behaviour change, because the
global coerces its argument and `Number.isNaN` doesn't. Safe here: every call
site was `isNaN(someDate.getTime())`, and `getTime()` already returns a number,
so there was never any coercion to lose.

### Hand-fixed

- **`suspicious/noAssignInExpressions`** (3) — `today.tsx` incremented a ref
  inside an object literal (`key: (celebrationKey.current += 1)`); hoisted to a
  statement. `coach.ts` had the classic `while ((m = re.exec(s)) !== null)`
  regex loop; restructured to assign before and at the end of the body.
- **`suspicious/noImplicitAnyLet`** (2) — `let garden` in `checkPlantRisk.ts`
  (annotated `Awaited<ReturnType<typeof getGarden>>`) and `let scope` in
  `tasks.ts`. The latter needed `SQL | undefined`: drizzle's `eq()` returns
  `SQL` but `and()` returns `SQL | undefined`, so the two branches wouldn't
  unify and the binding silently became `any`.
- **`correctness/noUnreachable`** (1) — `tasks.ts` had `void ({} as Row)` parked
  *after* a `return`, a no-op to keep a `Row` type alias "used". Removing it
  exposed `Row` as genuinely unused (`noUnusedLocals`), so both went.

### Dependencies

- **Removed `lucide-react`** from `dependencies` — zero imports anywhere in the
  tree, confirmed by grep. It was shipping in the production bundle.
- `@tanstack/devtools-vite` is also unreferenced (it's a Vite plugin that must
  be explicitly registered, and `vite.config.ts` doesn't). Left in place — it's
  dev-only, so the upside is small and the failure mode is silent.

## What's deliberately left

These rules are set to `warn` in `biome.json`: visible, non-blocking, and
intended as a ratchet — fix a category, then flip it to `error` so it can't
come back. `noUnreachable`, `noAssignInExpressions`, and `noImplicitAnyLet`
were already ratcheted to `error` this way.

| Rule | Count | Why not now |
|---|---|---|
| `style/noNonNullAssertion` | 60 | Style preference; each `!` needs a real decision about the null case. |
| `correctness/useExhaustiveDependencies` | 38 | Highest-value group left. Also the most dangerous to bulk-fix — a wrong dep array causes infinite render loops. Needs per-hook review. |
| `a11y/useSemanticElements` | 32 | `<div role="button">` → `<button>`; real markup changes. |
| `suspicious/noArrayIndexKey` | 19 | Index keys break React reconciliation on reorder; needs a stable id per list. |
| `a11y/useKeyWithClickEvents` | 10 | Click handlers on non-interactive elements need keyboard equivalents. |
| `a11y/useAriaPropsSupportedByRole` | 10 | |
| `a11y/noSvgWithoutTitle`, `noLabelWithoutControl`, `noAutofocus` | 4 each | `noAutofocus` in particular is often a deliberate UX call — suppress inline rather than blanket-fix. |
| `security/noDangerouslySetInnerHtml` | 1 | Needs a look at what's being injected. |
| `suspicious/noShorthandPropertyOverrides` | 1 | `styles.css:127` — a `background:` shorthand right after `background-color:` resets it. Minor, but real. |

### fallow's remaining findings

Not applied, because `tsconfig.json` sets `noUnusedLocals: true`. `fallow fix`
only strips the `export` keyword, which turns each of the 42 unused exports into
a *compile error* — so the real work is deleting ~42 symbols across ~25 files.
That's a refactor deserving its own review, not a mechanical pass.

Worth knowing before you start:

- **42 unused exports / 11 unused type exports.** Several read as intentional
  domain surface (`STREAK_MILESTONES`, `FOCUS_DURATIONS`, `XP_TIERS`). For those,
  prefer adding an `ignoreExports` entry to `.fallowrc.json` over deleting —
  `fallow fix --dry-run` proposes 18 such rules already.
- **`src/lib/asArray.ts` is dead** — nothing imports it. But its own comment
  explains it's a guard for React Query rehydrating a corrupted non-array from
  localStorage. It's a helper that should be *used*, not deleted; decide which.
- **11 circular dependencies**, the heaviest through `services/tasks.ts`
  (27 dependents) and `server/boss.ts`. `pnpm fallow` ranks these by ROI.

Before deleting anything fallow flags, confirm it:

```
pnpm fallow -- dead-code --trace <file>:<export>
pnpm fallow -- dead-code --type-aware --symbol-impact <file>:<export>
```

## Pre-existing test failures

4 tests in `src/server/services/tasks.test.ts` (`assignKidXp`,
`setKidCompletionXp`) fail on a foreign-key violation during **teardown** —
`delete from "user"` is blocked by surviving `task_instances` rows. Confirmed
pre-existing by stashing all tooling changes and re-running: identical 4
failures. Unrelated to formatting or lint, but worth fixing separately.
