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

### Accessibility pass

Cleared six rule categories, 185 → 162 warnings.

- **SVG charts (4)** — the XP line, timing curve, household per-member chart and
  profile XP chart had no accessible name. Each now carries a `<title>` built
  from the data it's already displaying, so a screen reader gets
  "Timing curve: 214 scheduled, 68% completed within 30 minutes" rather than
  nothing.
- **`aria-label` on generic elements (10)** — `aria-label` is ignored on a bare
  `<span>`/`<div>`, so every one of these labels was dead weight. Given the role
  that actually carries a name: `role="timer"` on Boggle's countdown,
  `role="status"` on the four live count badges (friend requests, household
  invites, mobile tab badge, review tab), `role="img"` on the labelled graphical
  tiles (2048 cells, Wordle letters, steps badge, 7-day heatmap, member badge).
- **`<nav role="tablist">` → `<div role="tablist">`** in `garden.tsx` — a `nav`
  landmark can't also be a tablist widget.
- **Modal backdrop** (`MembersOnlyUpsell`) — the panel called
  `stopPropagation` on click, which made a presentational div look interactive.
  Replaced with an `e.target === e.currentTarget` check on the backdrop, which
  deletes the inner handler entirely.
- **`WordSearch` custom-theme input** — a genuine bug, not a lint nit: the
  `<label>` was a *sibling* of the `<input>` with no `htmlFor`, so clicking it
  did nothing and screen readers never associated the two. Wired up with
  `useId()`.
- **`styles.css`** — `background-color` was declared *before* the `background:`
  shorthand, which resets it, silently dropping the fallback. Moved after. No
  visual change: the final gradient layer is opaque and covers the element.

Three `noLabelWithoutControl` reports were genuine false positives — the label
wraps its control through a component boundary (`{children}`, `<Switch/>`) that
static analysis can't follow. Suppressed inline with reasons rather than
contorted to satisfy the rule. Same for the theme-boot `dangerouslySetInnerHTML`
in `__root.tsx`, which injects a build-time constant and must run before paint.

### React hook dependencies

All 38 `useExhaustiveDependencies` cleared, 162 → 124 warnings. This group hid
real bugs, and two of the "obvious" fixes would have introduced worse ones — so
the reasoning matters more than the diff.

**The `ranges.join(',')` idiom (20 of 38).** Five hooks across the stats pages
and `friends.tsx` all did:

```ts
const ranges = ([7, 30, 90, 'all'] as Range[]).filter((r) => allows(r))
useEffect(() => { … }, [ranges.join(','), days])
```

The `join(',')` was a hand-rolled stable key, working around `ranges` being a
new array every render. The root cause was one level down: `useAvailableWindows`
returned `allows` as a fresh closure each render, so nothing derived from it
could ever be memoized. Fixing it there — `allows` is now a `useCallback` keyed
on the two scalars it reads — let all five callers become a plain
`useMemo(…, [allows])` plus an honest `[ranges, days]` dep list.

**Cases where adding the flagged dependency would have been the bug:**

- `MilestoneCelebration` — callers pass `onDone={() => setCelebration(null)}`,
  a new function every render. Adding it as a dep would clear and restart the
  auto-dismiss timer on every parent render, so the overlay would never time out
  while anything above it re-rendered. Held in a ref instead; the effect now
  keys on `event`, whose identity *is* stable between fires.
- `settings/index.tsx` quiet hours — the effect seeds form state from
  `profileQuery.data`. Depending on that object would re-seed on every refetch,
  clobbering whatever the user was typing. Hoisted the two fields plus a
  `loaded` boolean and depended on those.
- `useFocusSession` auto-start — mount-only is load-bearing: re-running on
  `autoStart`/`status`/`start` would restart a session the user had since paused
  or cancelled. Kept `[]` and documented why with a `biome-ignore`.

**Genuine improvements found along the way:**

- `__root.tsx` timezone sync keyed only on `data?.user?.id`, so a session
  refetch that changed the stored timezone wouldn't re-sync until next sign-in.
  Now depends on the timezone value itself.
- `SlidingPuzzle` re-attached its `keydown` listener on every render because
  `tryMove` was a bare function. Wrapped in `useCallback`.
- `focus.tsx` listed `qc`, which the callback never used.

Two dead `eslint-disable-next-line react-hooks/exhaustive-deps` comments were
removed — the project has no ESLint, so they had been silently doing nothing.

### List keys

All 19 `noArrayIndexKey` cleared, 124 → 105 warnings. Only one was an actual
bug; the value of the pass was separating it from 18 look-alikes.

**The real one — the task steps editor** (`tasks/new.tsx`, `StepsField`). Steps
are a plain `string[]` with move-up/move-down/remove controls and a controlled
`<input>` per row. Keyed by index, the input DOM node stays pinned to its
position, so reordering a step you're editing leaves focus and the text caret
behind on whatever step slid into that slot. The *values* still render correctly
— the inputs are controlled — which is exactly why this is easy to miss.

Fixed by tracking a stable id per row alongside `steps`, mutated in lockstep by
`add`/`remove`/`move`. The external contract stays `string[]` (that's the shape
the server wants), and `setSteps` is only ever called from inside `StepsField`,
so the ids can't drift.

**Where a real key already existed** — swapped in: weekday labels in
`WeekdayPicker` and the `tasks/new` day radio, `KEYBOARD_ROWS` content in
Wordle, weekday names in the stats bar chart, and tile *value* in
`SlidingPuzzle` (tiles genuinely move, and values 0–8 are unique, so React now
tracks each tile through a slide instead of rewriting text in place).

**Where the index is the identity** — suppressed with a per-site reason rather
than contorted. Two distinct cases:

- *Positional grids*, where `r`/`c` **is** the cell's identity and the grid
  never reorders: Sudoku, Word Search, 2048, Boggle, Wordle letter slots.
- *Index is a domain value, not a list position*: hour-of-day in the stats hour
  chart and the weekly-summary hour `<select>` (there, `h` is literally the
  option's `value`).

Plus the append-only admin failure logs, which are rendered read-only and whose
entries can share a timestamp — a composed key would risk duplicates, which is
worse than an index.

Suppression placement gotcha: a `biome-ignore` applies to the **next line only**,
so on a multi-line JSX element it has to sit directly above the `key=` line, not
above the opening tag. Comments placed above the tag silently do nothing.

### Interactive markup (`useSemanticElements`, `useKeyWithClickEvents`)

41 findings, 105 → 64 warnings. Almost all were the rules being opinionated
rather than catching bugs — the value was in separating those from the two that
weren't.

**`useKeyWithClickEvents` (9) — all false positives.** Every one is a backdrop
click-to-dismiss handler on a modal. Eight are native `<dialog>` elements, which
close on Escape via the browser and already wire `onClose`; the ninth
(`MembersOnlyUpsell`, a `role="dialog"` div) has its own Escape listener. There
is no keyboard-only affordance missing, so adding an `onKeyDown` to a container
would be noise. Suppressed with that reason.

**`useSemanticElements` (32) — one real fix, 31 documented suppressions.**

The real one: `WeekdayPicker` used `<div role="group">`, which has an exact
native equivalent. Now a `<fieldset>` with its default border/padding/margin
reset so the row lays out identically.

The other 31 are all one pattern — `<button role="radio" aria-checked>` pills
inside a `role="radiogroup"`, used across 12 files with 30 group wrappers. Biome
wants `<input type="radio">`. We're keeping the buttons, deliberately:

- The pattern is **valid ARIA**, not a bug.
- Native radios can't carry this pill styling without rewriting every control as
  a label-wrapped `sr-only` input, and that breaks the `disabled:` Tailwind
  variants four of them rely on.
- 31 UI controls is a lot of visual regression risk for a rule that is
  expressing a preference.

**Known gap, deliberately accepted:** a fully conformant ARIA radiogroup also
needs roving tabindex and arrow-key navigation between options. These groups
have neither — every pill is individually tabbable and arrows do nothing. Screen
readers still announce role and checked state correctly. If this is ever worth
closing, the fix is one shared `SegmentedControl` component rather than 31
edits, and it would keep the current markup and styling.

The rule stays at `error` rather than being switched off, so a genuinely wrong
role (like the `<div role="group">` above) still gets caught.

#### Suppression comment syntax

Two gotchas, both of which produced silent no-ops or parse errors on the first
attempt:

- The comment must sit on the line **immediately above the element** biome
  points at — above `<button`, not above the `role="radio"` attribute line.
- The syntax depends on position. Directly inside a `(` (e.g.
  `{items.map((x) => (`) it's an expression position and needs `//`. In JSX
  children position it needs `{/* … */}`. Using the wrong one either fails to
  parse or silently suppresses nothing. This file's split is 29 `//` to 2
  `{/* */}`.

### `noAutofocus` (4)

Split 3–1, and the split is the point.

**Three are conditionally-rendered inline edit fields** — the task-step rename in
`TaskDetailsDialog`, and the two kid-XP number inputs in the household page.
Each only renders once the user clicks "edit", so focus landing there *is* the
result of their action, not an unrequested jump. The rule is aimed at focus
moving on load; that isn't what these do.

**One is a genuine page-load autofocus** — the Title field on `/tasks/new`. Kept
deliberately: that route exists solely to type a title, so focus starting there
is predictable rather than disorienting. It's the one worth revisiting if a
screen-reader or magnifier user ever reports it, and its suppression comment
says so.

With this category done, `biome.json`'s linter block is back to a bare
`"recommended": true` — **no rule is downgraded any more**. The 60 remaining
`noNonNullAssertion` warnings are Biome's own default severity for that rule,
not a local override.

## What's deliberately left

Every category taken on so far has been ratcheted: fix it, then remove its
`warn` override from `biome.json` so it can't come back. That list is now empty
— what's below sits at Biome's own default severity.

| Rule | Count | Why not now |
|---|---|---|
| `style/noNonNullAssertion` | 60 | Style preference; each `!` needs a real decision about the null case. |

Already ratcheted to `error` and now enforced: `noUnreachable`,
`noAssignInExpressions`, `noImplicitAnyLet`, `noShorthandPropertyOverrides`,
`noDangerouslySetInnerHtml`, `noSvgWithoutTitle`, `noLabelWithoutControl`,
`noStaticElementInteractions`, `noNoninteractiveElementToInteractiveRole`,
`useAriaPropsSupportedByRole`, `useExhaustiveDependencies`, `noArrayIndexKey`, `useSemanticElements`,
`useKeyWithClickEvents`, `noAutofocus`. The linter block carries no severity
overrides at all now.

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

## The test-teardown FK bug (fixed)

4 household tests in `src/server/services/tasks.test.ts` (`assignKidXp`,
`setKidCompletionXp`) failed on `task_instances_task_id_tasks_id_fk` during
**teardown**, not during the assertions. Worth writing down, because the cause
is non-obvious and the same shape could bite any future cascade delete.

`task_instances` is reachable from a single `delete from "user"` by **two**
different referential actions:

```
tasks.user_id                       ON DELETE CASCADE   → deletes task_instances
task_instances.completed_by_user_id ON DELETE SET NULL  → updates task_instances
```

Postgres runs both. The SET NULL fires an `UPDATE` on a `task_instances` row,
and that update re-validates the row's `task_id` — against a `tasks` parent the
cascade may have already removed. Hence a FK violation reported as
*"insert or update on table task_instances"* while running a `DELETE` on `user`.

Two changes in `src/test/helpers.ts`:

- `cleanupTestUser` now deletes the user's `tasks` (cascading their instances)
  *before* the `user` row, so only the SET NULL path is left and it points at
  tasks that still exist.
- `withTestUsers` cleans up **sequentially** instead of `Promise.all`. In a
  household test one user owns the task and another completed the instance, so
  concurrent deletes raced on the same `task_instances` rows.

Suite is now 144/144. Note there is no production user-deletion path today, so
this was test-only in practice — but the FK shape is still there if one is ever
added.
