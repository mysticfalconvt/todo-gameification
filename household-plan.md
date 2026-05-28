# Household Feature

## Status — 2026-05-28

Legend: ✅ shipped · ⏸ deliberately deferred · ❌ not built · ➕ shipped beyond the original plan

| Phase | Status |
|---|---|
| Phase 1 — Minimum viable household | ✅ shipped |
| Phase 2 — Roles | ✅ mostly shipped (RoleGuard component ⏸, kid nav-hiding ⏸) |
| Phase 3 — Dashboard + activity | ✅ shipped |
| Phase 4 — Polish | partial: promote-kid ✅ · assigned-chore push ❌ · round-robin ❌ |
| Phase 5 — Family kiosk user | ✅ shipped (generalized into admin-created managed accounts) |

### Shipped beyond the original plan ➕

- **Member colors** (per-household palette, picker on Members tab, tinted chore rows)
- **Household charts**: completion bar + multi-line XP per family member (Stats tab + compact card on Chores tab)
- **Week view** on Chores tab (List / Week toggle) with recurrence-projection
- **Pending-approval flow** (Review tab) — kid + kiosk completions claim into a review queue; admin/member approve to grant XP or reject to reopen
- **Credit-recipient dialog** — admin/member can pick who gets XP/streak when completing a chore (covers "complete on behalf of")
- **Settings → Household card** (create form + admin delete with name-typing confirm)
- **Login by handle** (not just email) — needed for managed accounts
- **Admin-created managed accounts** for both kids and kiosks (`createManagedMember` + reset-password flow) — generalized the original "kiosk only" sketch
- **REST API endpoints**: `/api/v1/household`, `/api/v1/household/chores`, `/api/v1/household/chores/week`, `/api/v1/household/stats`, `/api/v1/household/activity`; `creditUserId` body on `complete`; `?type` filter on `events`
- **Mobile bottom-bar Family tab** (gated on household membership or pending invite)
- **"+ New chore" button** on household page with deep-link back

## Context

The app today models tasks as strictly personal (one owner = one completer = one XP recipient). The user wants a "household" layer so cohabitants can share chores: tasks that any household member can see, that can be either assigned to a specific person or claimed first-come-first-serve, with a dashboard showing household-wide chores and per-member stats. The use case spans both adult cohabitants and a kids' chore chart (kid role with restricted UI).

The friends primitive already exists and powers a tabbed multi-user dashboard (`src/routes/_authenticated/friends.tsx`). Household reuses that pattern: it's a small, closed group on top of the friends graph, with shared task ownership and a stricter visibility surface. The hard part is not the UI — it's that XP and streaks are a **projection of the events table** (CLAUDE.md call-out), and household chores break the accidental invariant that `event.userId == task.userId`. This plan keeps the projection mechanics intact by being explicit about which user gets the XP and never reducing across users.

## Confirmed product decisions

1. **XP**: completer only. Whoever marks a chore done gets full XP and streak credit. Creator (often a parent) gets nothing extra.
2. **Membership**: one household per user, friends-first invite (must already be friends to send an invite).
3. **Roles**: `admin` / `member` / `kid`. Admin manages membership + creates/edits any chore. Member can create chores assigned to self or free-for-all, complete chores assigned to them or free-for-all. Kid sees a restricted UI: complete-only, no task creation, no friends/garden/arcade surfaces.
4. **Mode**: always-on "Household" tab when you're a member, plus a `mergeHouseholdIntoToday` pref that surfaces household chores in the Today view.
5. **Kid accounts**: full accounts with the Kid role — no new auth path. Admin can promote to Member later.
6. **Free-for-all**: first-completer wins, no claim step. DB race resolved by the completion `UPDATE … WHERE completed_at IS NULL RETURNING`.
7. **Today merge** (when toggle is on): personal tasks + household chores assigned to me + unclaimed free-for-all chores. Chores assigned to other members stay hidden in Today.
8. **Cross-completion**: a member may **not** complete a chore assigned to someone else. To allow "anyone can do it," create it as free-for-all. Admins reassign rather than complete-for.

## Data model

### New tables

```sql
CREATE TABLE households (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name text NOT NULL,
  created_by_user_id text NOT NULL REFERENCES "user"(id) ON DELETE RESTRICT,
  created_at timestamp NOT NULL DEFAULT now(),
  updated_at timestamp NOT NULL DEFAULT now()
);

CREATE TABLE household_members (
  household_id uuid NOT NULL REFERENCES households(id) ON DELETE CASCADE,
  user_id      text NOT NULL REFERENCES "user"(id) ON DELETE CASCADE,
  role         text NOT NULL CHECK (role IN ('admin','member','kid')),
  joined_at    timestamp NOT NULL DEFAULT now(),
  PRIMARY KEY (household_id, user_id)
);
-- enforces "one household per user" in the DB so service code can't drift
CREATE UNIQUE INDEX household_members_user_uq ON household_members(user_id);
CREATE INDEX household_members_household_role_idx ON household_members(household_id, role);

CREATE TABLE household_invites (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  household_id    uuid NOT NULL REFERENCES households(id) ON DELETE CASCADE,
  inviter_user_id text NOT NULL REFERENCES "user"(id) ON DELETE CASCADE,
  invitee_user_id text NOT NULL REFERENCES "user"(id) ON DELETE CASCADE,
  proposed_role   text NOT NULL CHECK (proposed_role IN ('member','kid')),
  status          text NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending','accepted','declined','cancelled')),
  created_at      timestamp NOT NULL DEFAULT now(),
  responded_at    timestamp
);
CREATE UNIQUE INDEX household_invites_unique_pending_idx
  ON household_invites(household_id, invitee_user_id) WHERE status = 'pending';
```

### Column additions

```sql
ALTER TABLE tasks
  ADD COLUMN household_id        uuid REFERENCES households(id) ON DELETE SET NULL,
  ADD COLUMN assigned_to_user_id text REFERENCES "user"(id)    ON DELETE SET NULL;
CREATE INDEX tasks_household_idx ON tasks(household_id) WHERE household_id IS NOT NULL;

ALTER TABLE task_instances
  ADD COLUMN household_id          uuid REFERENCES households(id) ON DELETE SET NULL,
  ADD COLUMN assigned_to_user_id   text REFERENCES "user"(id)    ON DELETE SET NULL,
  ADD COLUMN completed_by_user_id  text REFERENCES "user"(id)    ON DELETE SET NULL;
CREATE INDEX task_instances_household_open_idx
  ON task_instances(household_id, due_at)
  WHERE completed_at IS NULL AND skipped_at IS NULL;
CREATE INDEX task_instances_household_assignee_idx
  ON task_instances(household_id, assigned_to_user_id);

ALTER TABLE user_prefs
  ADD COLUMN merge_household_into_today boolean NOT NULL DEFAULT true;

-- Partial B-tree on events.payload->>'householdId' for per-household aggregates
-- (per-member stats reuse the existing getStats(userId,days) and don't need this).
CREATE INDEX events_household_completed_idx
  ON events ((payload->>'householdId'))
  WHERE type = 'task.completed' AND payload->>'householdId' IS NOT NULL;
```

### Semantic rules (load-bearing)

- `tasks.user_id` = **creator** (unchanged meaning). For personal tasks, also the assignee. For household tasks, the creator may differ from the assignee.
- `tasks.assigned_to_user_id` = assignee. `NULL` means free-for-all if `household_id` is set; meaningless if `household_id` is `NULL`.
- `task_instances.user_id` = **creator** (mirrors `tasks.user_id`) — kept as a back-pointer, NOT used to decide who sees it in Today. Today queries are refactored to filter by `assigned_to_user_id` and `household_id`. Stays `NOT NULL`.
- `task_instances.assigned_to_user_id` = assignee at the time the instance was materialized.
- `task_instances.completed_by_user_id` = whoever actually clicked complete. Written in the same transaction as `completed_at`.
- `events.user_id` = the XP recipient = the completer. **This is now an explicit invariant** (previously accidentally true).

### Migration

Single file `src/server/db/migrations/0034_households.sql` containing all the above. Append journal entry:
```json
{ "idx": 34, "version": "7", "when": <ms>, "tag": "0034_households", "breakpoints": true }
```
Mirror the new columns in `src/server/db/schema.ts`. Don't run `drizzle-kit generate` (TTY issue, per CLAUDE.md).

## Event model

Extend the existing `task.completed` event — do **not** add a new event type (would fork ~15 call sites filtering on `eq(events.type, 'task.completed')`). New optional payload fields:

```ts
{
  type: 'task.completed',
  taskId, instanceId, difficulty, xpOverride, dueAt, dueKind, occurredAt,
  // new, optional:
  householdId?: string | null,
  assignedToUserId?: string | null,
  completedAs?: 'personal' | 'assigned' | 'free_for_all',
}
```

`applyEvent` in `src/domain/gamification.ts` does **not** change. `events.userId` is already the recipient; the new fields are metadata for the activity feed and household aggregate queries.

New events (Phase 3, activity feed):
- `household.member.joined` — `{ householdId, role }`
- `household.member.left` — `{ householdId }`

Both no-ops in `applyEvent`. Register the type union in `src/domain/events.ts`.

## Service layer

### New: `src/server/services/households.ts`

```ts
type Role = 'admin' | 'member' | 'kid'

createHousehold(userId, name): Promise<{ householdId }>
getMyHousehold(userId): Promise<{ household, role, members } | null>
listHouseholdMembers(viewerId, householdId): Promise<MemberRow[]>
inviteMember(inviterId, inviteeId, role: 'member'|'kid'): Promise<{ inviteId }>  // requires friendship + admin
listMyInvites(userId): Promise<InviteRow[]>
acceptInvite(userId, inviteId): Promise<void>     // tx: re-check no existing membership
declineInvite(userId, inviteId): Promise<void>
cancelInvite(adminId, inviteId): Promise<void>
removeMember(adminId, householdId, targetUserId): Promise<void>
leaveHousehold(userId): Promise<void>             // last admin cannot leave without promoting another
changeRole(adminId, targetUserId, role): Promise<void>
renameHousehold(adminId, householdId, name): Promise<void>
deleteHousehold(adminId, householdId): Promise<void>

// shared helpers (imported by tasks.ts)
getMembership(userId, householdId): Promise<{ role } | null>
assertHouseholdRole(userId, householdId, allowed: Role[]): Promise<void>
areFriends(a, b): Promise<boolean>  // new export in social.ts, used here
```

`inviteMember` checks `areFriends(inviterId, inviteeId)` (extract from existing `canView` logic in `src/server/services/social.ts`). `acceptInvite` does NOT re-check friendship at accept time — only the write-side asserts (so an unfriend after invite doesn't block acceptance).

### Changes to `src/server/services/tasks.ts`

- **`createTask(userId, input)`** (~line 260): accept optional `householdId`, `assignedToUserId`. Validate:
  - if `householdId` set → user must be a household member
  - `kid` cannot create at all (rejected here AND gated at function layer)
  - `member` can only assign to self or free-for-all
  - `admin` can assign to any household member
  - Instance materialization: set `household_id` and `assigned_to_user_id` on the new `task_instances` row, mirroring the task.

- **`listTodayInstances(userId)`** (~line 826): change WHERE to:
  ```
  -- personal tasks (unchanged behavior)
  (task_instances.user_id = $userId AND task_instances.household_id IS NULL)
  OR
  -- household chores, when toggle is on
  ($mergeHouseholdIntoToday
    AND task_instances.household_id = <my household_id>
    AND (task_instances.assigned_to_user_id = $userId
         OR task_instances.assigned_to_user_id IS NULL))
  ```
  Read `mergeHouseholdIntoToday` from `user_prefs` once at the top.

- **`completeInstance(userId, instanceId)`** (lines 1323-1516) — the key change:
  1. Fetch instance by id (no `eq(taskInstances.userId, userId)` filter).
  2. Permission gate:
     - if `instance.household_id IS NULL`: require `instance.user_id == userId` (existing rule for personal).
     - else: require viewer is a household member AND (`assigned_to_user_id IS NULL` OR `assigned_to_user_id == userId`). Admins do NOT get a bypass here — see decision 8.
  3. Race-safe update:
     ```sql
     UPDATE task_instances
     SET completed_at = now(), completed_by_user_id = $userId
     WHERE id = $instanceId AND completed_at IS NULL AND skipped_at IS NULL
     RETURNING *
     ```
     If 0 rows: return `{ alreadyHandled: true }` (free-for-all race lost).
  4. Insert event with `events.user_id = $userId` (the completer) and payload including `householdId`, `assignedToUserId`, `completedAs` (`'personal'` | `'assigned'` | `'free_for_all'`).
  5. `applyEvent(prevState, event)` — unchanged. Loads progression for `events.userId` (completer), credits XP/streak, upserts.
  6. Recurrence: next instance inherits `household_id` and `assigned_to_user_id` from the **parent task** (not from the completed instance), so reassigning the task affects future instances but not the open one. Assignment persists across recurrence; FFA chores stay FFA.

- **`reopenInstance`** (~line 974): widen the ownership gate. Allow reopen if viewer is one of:
  - `instance.user_id` (creator, for personal tasks — existing behavior)
  - `instance.completed_by_user_id` (whoever actually did it — needed for FFA + assigned household chores)
  - household admin where `instance.household_id` matches
  
  The events delete (~line 1003) is already scoped by `events.user_id = <completer> AND payload.instanceId = <id>`. Read `completed_by_user_id` from the instance row and use that as the `events.user_id` filter, NOT the viewer's id. Same for the `rebuildProgression(<completer>)` call.

- **New: `listHouseholdChores(viewerId, householdId, filter)`** — returns open instances grouped by assignee plus a "free-for-all" bucket. Used by the household dashboard.

### Stats / leaderboard

- `getStats(userId, days)` (`src/server/services/tasks.ts:1901`) — unchanged. For per-member household dashboard cards, call it once per member (N ≤ ~5).
- `getLeaderboard(viewerId, scope, metric, window)` (`src/server/services/leaderboard.ts`) — add `scope: 'household'`. New branch: source members from `household_members` for the viewer's household, then reuse the same XP-per-window subquery already used for `scope: 'friends'`.
- Per-household aggregate (e.g. "completions in this household, last 7 days, grouped by completer"): new helper in `households.ts` that queries `events WHERE type='task.completed' AND payload->>'householdId' = $hh` — backed by the new partial index.

## Server functions (thin wrappers)

New: `src/server/functions/households.ts` — one `createServerFn().middleware([authMiddleware]).validator(z…).handler` per service function above. Mirror the validator + auth pattern in `src/server/functions/social.ts`.

Extend `src/server/functions/tasks.ts`:
- `createTaskFn` validator gains `householdId?: uuid`, `assignedToUserId?: string`.
- No other function file changes needed (auth + input pass-through).

Extend `src/server/functions/user.ts` `updatePrefs` validator with `mergeHouseholdIntoToday?: boolean`.

## Routes / UI

Per CLAUDE.md, **folder-based** routes only:

```
src/routes/_authenticated/household/
  index.tsx          # tabbed dashboard, mirrors friends.tsx
                     #   Tabs: Chores | Members | Leaderboard | Activity
  members.tsx        # admin: list + role chips + remove/promote
  invites.tsx        # accept/decline pending + send new (friend picker)
  settings.tsx       # rename / delete / leave
  $memberId.tsx      # per-member stats page (reuses getStats + XpLineSection)
  -components/
    HouseholdChoreList.tsx
    AssigneePicker.tsx        # admin sees full member list; member sees self|FFA
    FreeForAllBadge.tsx
```

### Kid role gating

Create `src/components/auth/RoleGuard.tsx`:
```ts
<RoleGuard allow={['admin','member']} fallback={<KidLockMessage/>}>...</RoleGuard>
```
Backed by `useMyHouseholdRole()` reading the cached `getMyHousehold` query. Apply at:
- Sidebar/nav: when role is `kid`, hide Friends, Garden, Arcade, Settings (advanced), and the "new task" button. Keep Today, Household, basic profile.
- `src/routes/_authenticated/tasks/new.tsx`: wrap form in `RoleGuard`.
- Task list edit/delete actions: gate per task — kids can complete but not modify.

### Today merge

`src/routes/_authenticated/today.tsx` requires no UI structural change — `listTodayInstances` returns the merged list when the pref is on. Add a "Household" badge on rows where `instance.householdId != null` (small chip component). Add the `mergeHouseholdIntoToday` toggle to whichever settings section currently hosts privacy/activity toggles (`src/routes/_authenticated/settings/index.tsx`).

### Task create form

Add a "Household chore" section to `src/routes/_authenticated/tasks/new.tsx`, only rendered if the user is in a household and not a kid:
- Toggle: "For household"
- If on: `AssigneePicker` (admin → all members + Free-for-all; member → Me + Free-for-all)
- Existing recurrence/difficulty/category fields unchanged

### Service worker

Bump `CACHE_VERSION` at the top of `public/sw.js` — `getMyHousehold`, `listMyInvites`, `listTodayInstances` shapes all change. One bump covers all of it.

## Phasing

Each phase ships independently and leaves the app working.

### Phase 1 — Minimum viable household (one PR) ✅
- ✅ Migration 0034 (all tables + columns).
- ✅ `households.ts` service: create, getMyHousehold, inviteMember, acceptInvite, listMyInvites, declineInvite.
- ✅ Server function wrappers.
- ✅ Routes: `household/index.tsx`. (`invites.tsx` was later consolidated into the Members tab.)
- ✅ Task creation: optional `householdId`, assignee = self or free-for-all only.
- ✅ `completeInstance` household-aware + race-safe + `completed_by_user_id` written.
- ✅ `task.completed` payload extended.
- ✅ `reopenInstance` uses `completed_by_user_id`.
- ✅ Today merge: pref defaults true.
- ✅ Service worker `CACHE_VERSION` bump.

**Demonstrates end-to-end:** two friends, one household, FFA chore, first-completer wins, XP goes to completer.

### Phase 2 — Roles ✅ mostly
- ✅ `admin`/`member`/`kid` enforcement in services (`assertHouseholdRole`, inline role checks).
- ⏸ `RoleGuard` component + nav gating — not built. Per the user's direction, nav-hiding for kids was deliberately deferred ("some of those things might be good for kids to still have") and an inline `isKid` check on `/tasks/new` was used instead of a reusable wrapper.
- ✅ `changeRole`, `removeMember`, `leaveHousehold`, `cancelInvite`.
- ✅ `AssigneePicker` full version (admin sees all members; member sees self/FFA).

### Phase 3 — Dashboard + activity ✅
- ✅ Leaderboard `scope='household'` branch.
- ✅ Per-member stats page (`household/$memberId.tsx`).
- ✅ Activity feed: `household.member.joined`/`left` events + per-completion events filtered by `householdId`.
- ✅ Rename / delete household.

### Phase 4 (optional, post-dogfood) — Polish
- ❌ Notifications when assigned a chore — not built.
- ❌ Round-robin recurring assignment (`tasks.rotation_strategy` + `tasks.last_assignee_cursor`) — not built.
- ✅ Promote-kid-to-member UX (admin's role dropdown on Members tab).

### Phase 5 (now built) — Family kiosk user ✅
A shared "kiosk" account a household can leave running on a counter iPad / wall tablet so anyone in the family can glance at the chore list and mark chores done without logging in as themselves.

**What shipped:**
- ✅ Admin creates managed kid / kiosk accounts on the Members tab (`createManagedMember` service, password reveal dialog).
- ✅ New role `kiosk` (migration 0037) widens the role enum. Kiosk completions go into the Pending Review queue just like kid completions.
- ✅ The credit-recipient dialog (already built for adult on-behalf-of completion) covers the "pick which family member did this chore" UX on a kiosk.
- ✅ Auth: real `user` row + `account` row via better-auth's `signUpEmail`. Sign-in supports handle-or-email so the family device logs in with `@kitchen` or similar.
- ✅ Kiosk + kid accounts hidden from friend search.
- ✅ Admins can reset a managed member's password from the Members tab.
- ⏸ **Still on the future list:** a dedicated kiosk landing route (chores-only, full-screen friendly) — today the kiosk lands on the regular Today/Household tabs; a `kiosk` role check could route them to `/household` and hide other surfaces. Also no "lock to this device" PIN yet.

## Verification

### Phase 1 end-to-end
1. Create users A and B; A sends friend request to B; B accepts.
2. A: `createHousehold("Smiths")` → row in `households` + auto-row in `household_members(role='admin')`.
3. A: `inviteMember(B, 'member')` → pending row in `household_invites`. B: `listMyInvites` shows it.
4. B: `acceptInvite` → second row in `household_members`. The unique index on `user_id` should prevent B from joining a second household.
5. A: create task with `householdId` set, `assignedToUserId=null` (free-for-all). Confirm `task_instances` row has both `household_id` and `assigned_to_user_id IS NULL`.
6. B (with `mergeHouseholdIntoToday=true`): Today shows the chore with a "Household" badge.
7. B: complete it. Confirm:
   - `task_instances.completed_at` set, `completed_by_user_id = B`.
   - `events` row with `user_id = B`, payload `completedAs='free_for_all'`, `householdId` set.
   - B's `progression.xp` and `currentStreak` incremented; A's untouched.
   - A's Today (refreshed) no longer shows the chore.
8. **Race test:** open two windows for A and B, both click complete on the same FFA chore. Exactly one succeeds; the other gets `{ alreadyHandled: true }` (UI shows toast).
9. **Reopen test:** B reopens the completion. Confirm `events` row deleted, B's progression decremented back, instance row's `completed_at` and `completed_by_user_id` cleared.
10. A creates a chore assigned to B (`assignedToUserId=B`). A tries to complete it → rejected (decision 8). B completes it → B gets XP, event `completedAs='assigned'`.

### Phase 2
- A demotes B to `kid`. B's nav loses Tasks/Friends/Garden/Arcade/Settings. Today still works. B can still complete chores assigned to them or FFA. B cannot open `/tasks/new` (`RoleGuard` fallback).
- A promotes a member C. Reassignment from B to C works. C can complete it; B can no longer.
- A (admin) reopens a kid's accidental completion → progression decrements on the kid, not on A. (Tests the `completed_by_user_id` path in reopen.)
- Member tries to assign a chore to another member → service-layer rejection.

### Phase 3
- Leaderboard `scope='household'` returns household members ranked correctly across 7/30/90/all windows.
- Per-member stats page reuses `getStats(memberId, days)` and `XpLineSection` without modification.
- Activity feed shows chronological mix of completions + member joins.

### Type-check + tests
- `pnpm typecheck` clean after each phase.
- Add unit tests for the FFA race (`completeInstance` with two parallel calls) and the reopen-by-completer path.

## Risks / things to watch

1. **The `events.userId = completer` invariant is now load-bearing.** Add a one-line comment in `src/domain/events.ts` next to the `task.completed` registration so future code doesn't slip back into "userId = task owner."
2. **`taskInstances.user_id` is no longer the canonical assignee.** Audit anything that reads it expecting "the person responsible." Today queries are the obvious case; double-check `repairDriftedRecurring` and any cron job that touches instances.
3. **Free-for-all race correctness depends on Read Committed isolation** (Postgres default). Don't wrap `completeInstance` in a higher isolation level — the `WHERE completed_at IS NULL` predicate is what prevents double-completion.
4. **Reopen permission gate widens.** Make sure the new admin-reopen branch only affects household instances, not personal ones (i.e. don't let a household admin reopen another member's *personal* completions).
5. **Kid privacy:** kids should not appear on the global leaderboard or in friend search. Filter `social.ts` searches to exclude users whose only household membership role is `kid` (or add an explicit `user.is_kid` derived flag in Phase 2).
6. **Invite-after-unfriend:** acceptance should NOT re-check friendship (deliberately — avoids a footgun where the invitee can never join). Friendship is only required at invite-write time.
7. **Service worker cache:** one `CACHE_VERSION` bump in Phase 1 covers Today, household queries, and the prefs response. Don't forget it — stale clients will render old shapes.
8. **`assigned_to_user_id` referencing user.id with `ON DELETE SET NULL`:** if a member is deleted, their assigned chores silently become free-for-all. Acceptable, but document it.

## Critical files

- `src/server/db/schema.ts` — mirror new columns and tables
- `src/server/db/migrations/0034_households.sql` (new) + `meta/_journal.json`
- `src/server/services/tasks.ts` — `createTask`, `listTodayInstances`, `completeInstance`, `reopenInstance`, plus new `listHouseholdChores`
- `src/server/services/households.ts` (new)
- `src/server/services/social.ts` — export `areFriends` helper
- `src/server/services/leaderboard.ts` — add `scope='household'`
- `src/domain/events.ts` — extend `task.completed` payload + register household events (Phase 3)
- `src/server/functions/households.ts` (new) + extensions to `tasks.ts`, `user.ts`
- `src/routes/_authenticated/household/index.tsx` (new, mirror `friends.tsx`)
- `src/routes/_authenticated/household/{members,invites,settings,$memberId}.tsx` (new)
- `src/routes/_authenticated/today.tsx` — Household badge on merged rows
- `src/routes/_authenticated/tasks/new.tsx` — Household chore section
- `src/routes/_authenticated/settings/index.tsx` — `mergeHouseholdIntoToday` toggle
- `src/components/auth/RoleGuard.tsx` (new)
- `public/sw.js` — bump `CACHE_VERSION`
