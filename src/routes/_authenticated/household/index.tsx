import { useEffect, useRef, useState } from 'react'
import { createFileRoute, Link } from '@tanstack/react-router'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { toast } from 'sonner'
import { useSession } from '../../../lib/auth-client'
import { assigneeBarStyle } from '../../../components/household/assigneeBar'
import {
  acceptInviteFn,
  approveClaimFn,
  cancelInviteFn,
  createManagedMemberFn,
  declineInviteFn,
  getMyHouseholdFn,
  inviteMemberFn,
  leaveHouseholdFn,
  listHouseholdActivityFn,
  listHouseholdChoresFn,
  listHouseholdChoresWeekFn,
  listHouseholdStatsFn,
  listMyInvitesFn,
  listOutgoingInvitesFn,
  listPendingApprovalsFn,
  rejectClaimFn,
  removeMemberFn,
  renameHouseholdFn,
  resetManagedMemberPasswordFn,
  changeRoleFn,
  updateMemberColorFn,
} from '../../../server/functions/households'
import {
  HouseholdCompletionBar,
  HouseholdXpMultiLine,
} from '../../../components/household/charts'
import { getLeaderboardFn } from '../../../server/functions/leaderboard'
import type {
  LeaderboardMetric,
  LeaderboardWindow,
} from '../../../server/services/leaderboard'
import { listFriendsFn } from '../../../server/functions/social'
import { completeInstance } from '../../../server/functions/tasks'

export const Route = createFileRoute('/_authenticated/household/')({
  component: HouseholdPage,
})

type Tab =
  | 'chores'
  | 'review'
  | 'stats'
  | 'leaderboard'
  | 'activity'
  | 'members'

const TAB_LABEL: Record<Tab, string> = {
  chores: 'Chores',
  review: 'Review',
  stats: 'Stats',
  leaderboard: 'Leaderboard',
  activity: 'Activity',
  members: 'Members',
}

function HouseholdPage() {
  const qc = useQueryClient()
  // refetchOnMount: 'always' — the persisted query cache survives reloads
  // for 7 days and we don't want a stale `null` (from before the user
  // joined a household) to render the empty state on entry. Always
  // re-validate when the page mounts.
  const myQuery = useQuery({
    queryKey: ['my-household'],
    queryFn: () => getMyHouseholdFn(),
    refetchOnMount: 'always',
  })
  const invitesQuery = useQuery({
    queryKey: ['my-household-invites'],
    queryFn: () => listMyInvitesFn(),
    refetchOnMount: 'always',
  })

  // Pending-approval count for the Review tab badge. Declared up here
  // (above any conditional returns) so the hook order stays stable
  // across renders — even before the household payload has loaded.
  // The query is gated by `enabled` once we know the viewer's role +
  // household id; until then it's a no-op shaped like the same hook.
  const myHouseholdId = myQuery.data?.household?.id ?? null
  const myRole = myQuery.data?.role ?? null
  const isAdultViewer = myRole !== null && myRole !== 'kid'
  const pendingQuery = useQuery({
    queryKey: ['household-pending-approvals', myHouseholdId ?? 'none'],
    queryFn: () =>
      listPendingApprovalsFn({
        data: { householdId: myHouseholdId as string },
      }),
    enabled: Boolean(myHouseholdId) && isAdultViewer,
    refetchInterval: 60_000,
    staleTime: 30_000,
  })

  const [tab, setTab] = useState<Tab>('chores')

  // Treat "no valid data yet AND a fetch is in flight" as loading too,
  // not just the initial `isLoading`. This covers the case where a
  // stale persisted value (null or malformed) lets `isLoading` flip to
  // false immediately, which would otherwise flash the empty state
  // before the refetch lands.
  const hasValidData = Boolean(myQuery.data?.household)
  if (myQuery.isLoading || (myQuery.isFetching && !hasValidData)) {
    return (
      <main className="page-wrap space-y-6 px-4 py-8">
        <p className="text-[var(--sea-ink-soft)]">Loading…</p>
      </main>
    )
  }

  const data = myQuery.data
  const pendingInvites = invitesQuery.data ?? []

  // Not in a household: show pending invites + a hint to create one from
  // settings. The create form lives in Settings → Household so the empty
  // state stays light. Also guard against a malformed cached payload
  // (data without `household`) so a stale persisted query can't crash
  // the page.
  if (!data || !data.household) {
    return (
      <main className="page-wrap space-y-6 px-4 py-8">
        <header>
          <p className="island-kicker mb-1">Household</p>
          <h1 className="display-title text-4xl font-bold text-[var(--sea-ink)]">
            Share chores with people you live with
          </h1>
          <p className="mt-2 text-sm text-[var(--sea-ink-soft)]">
            You&rsquo;re not in a household yet. Create one from{' '}
            <Link to="/settings" className="underline">
              Settings → Household
            </Link>
            , or accept an invite below.
          </p>
        </header>
        {pendingInvites.length > 0 && (
          <section className="island-shell rounded-2xl p-4">
            <h2 className="text-lg font-semibold text-[var(--sea-ink)]">
              Pending invites
            </h2>
            <ul className="mt-3 space-y-2">
              {pendingInvites.map((inv) => (
                <InviteRow
                  key={inv.id}
                  inviteId={inv.id}
                  householdName={inv.householdName}
                  inviterName={inv.inviterName}
                  inviterHandle={inv.inviterHandle}
                  proposedRole={inv.proposedRole}
                  onChanged={() => {
                    qc.invalidateQueries({ queryKey: ['my-household-invites'] })
                    qc.invalidateQueries({ queryKey: ['my-household'] })
                  }}
                />
              ))}
            </ul>
          </section>
        )}
      </main>
    )
  }

  const { household, role, members } = data
  const isAdult = role === 'admin' || role === 'member'
  const isKiosk = role === 'kiosk'
  const pendingCount = pendingQuery.data?.length ?? 0

  // Tab visibility by role:
  //   admin / member — everything (incl. Review queue for approvals
  //     and Members for management).
  //   kid — everything except Review (kids can't approve other kids'
  //     claims).
  //   kiosk — just the family-dashboard surfaces. No Members
  //     (can't manage), no Review (kids' claims are an adult
  //     responsibility).
  const tabsForRole: Tab[] = isKiosk
    ? ['chores', 'stats', 'leaderboard', 'activity']
    : isAdult
      ? ['chores', 'review', 'stats', 'leaderboard', 'activity', 'members']
      : ['chores', 'stats', 'leaderboard', 'activity', 'members']

  return (
    <main className="page-wrap space-y-6 px-4 py-8">
      <header>
        <p className="island-kicker mb-1">Household</p>
        <h1 className="display-title text-4xl font-bold text-[var(--sea-ink)]">
          {household.name}
        </h1>
        <p className="mt-2 text-sm text-[var(--sea-ink-soft)]">
          {members.length} {members.length === 1 ? 'member' : 'members'} ·
          You are {role === 'admin' ? 'an' : 'a'} {role}
        </p>
      </header>

      <div
        className="flex flex-wrap gap-1.5 rounded-2xl border border-[var(--line)] bg-[var(--option-bg)] p-1.5"
        role="tablist"
        aria-label="Household tabs"
      >
        {tabsForRole.map((t) => (
          <button
            key={t}
            type="button"
            role="tab"
            aria-selected={tab === t}
            onClick={() => setTab(t)}
            className={`relative flex-1 whitespace-nowrap rounded-full px-3.5 py-1.5 text-center text-xs font-semibold transition ${
              tab === t
                ? 'bg-[var(--btn-primary-bg)] text-[var(--btn-primary-fg)]'
                : 'text-[var(--sea-ink-soft)] hover:text-[var(--sea-ink)]'
            }`}
          >
            {TAB_LABEL[t]}
            {t === 'review' && pendingCount > 0 ? (
              <span
                aria-label={`${pendingCount} pending`}
                className={`ml-1.5 inline-flex h-4 min-w-[1rem] items-center justify-center rounded-full px-1 text-[10px] font-bold leading-none ${
                  tab === 'review'
                    ? 'bg-[var(--btn-primary-fg)] text-[var(--btn-primary-bg)]'
                    : 'bg-[var(--btn-primary-bg)] text-[var(--btn-primary-fg)]'
                }`}
              >
                {pendingCount > 9 ? '9+' : pendingCount}
              </span>
            ) : null}
          </button>
        ))}
      </div>

      {tab === 'chores' ? (
        <ChoresTab
          householdId={household.id}
          viewerRole={role}
          members={members}
        />
      ) : tab === 'review' && isAdult ? (
        <ReviewTab householdId={household.id} members={members} />
      ) : tab === 'stats' ? (
        <StatsTab householdId={household.id} />
      ) : tab === 'leaderboard' ? (
        <LeaderboardTab householdId={household.id} />
      ) : tab === 'activity' ? (
        <ActivityTab householdId={household.id} members={members} />
      ) : (
        <MembersTab
          householdId={household.id}
          viewerRole={role}
          members={members}
          householdName={household.name}
          pendingInvites={pendingInvites}
          onInvitesChanged={() => {
            qc.invalidateQueries({ queryKey: ['my-household-invites'] })
            qc.invalidateQueries({ queryKey: ['my-household'] })
            qc.invalidateQueries({ queryKey: ['outgoing-invites'] })
          }}
        />
      )}
    </main>
  )
}

type HouseholdMemberRow = {
  userId: string
  handle: string
  name: string
  role: 'admin' | 'member' | 'kid' | 'kiosk'
  joinedAt: Date | string
  color: string | null
}

type CreditPicker = {
  instanceId: string
  title: string
  assignedToUserId: string | null
  assignedToName: string | null
}

// yyyy-MM-dd of the most recent Sunday in the browser's local tz. The
// week view scrolls one week at a time around this anchor.
function defaultWeekStart(): string {
  const today = new Date()
  const dow = today.getDay() // 0 = Sunday
  const start = new Date(today.getFullYear(), today.getMonth(), today.getDate() - dow)
  return formatLocalDate(start)
}

function formatLocalDate(d: Date): string {
  const yyyy = d.getFullYear()
  const mm = String(d.getMonth() + 1).padStart(2, '0')
  const dd = String(d.getDate()).padStart(2, '0')
  return `${yyyy}-${mm}-${dd}`
}

function addDaysToDateStr(s: string, n: number): string {
  const [y, m, d] = s.split('-').map(Number)
  const date = new Date(y, m - 1, d + n)
  return formatLocalDate(date)
}

const WEEKDAY_LABEL = [
  'Sunday',
  'Monday',
  'Tuesday',
  'Wednesday',
  'Thursday',
  'Friday',
  'Saturday',
] as const

function ChoresTab({
  householdId,
  viewerRole,
  members,
}: {
  householdId: string
  viewerRole: 'admin' | 'member' | 'kid' | 'kiosk'
  members: HouseholdMemberRow[]
}) {
  const qc = useQueryClient()
  const { data: session } = useSession()
  const viewerUserId = session?.user?.id
  const [viewMode, setViewMode] = useState<'list' | 'week' | 'kanban'>(
    'list',
  )
  // Assignee filter: 'all' shows everything; 'mine' shows chores
  // assigned to viewer + FFA; 'ffa' just FFA; a userId narrows to
  // that member's chores.
  const [filterAssignee, setFilterAssignee] = useState<string>('all')
  // Sort applies to List + Kanban; the Week view's day grouping is
  // its own ordering.
  const [sortBy, setSortBy] = useState<'due' | 'title' | 'assignee'>('due')
  // Week-mode pagination: yyyy-MM-dd string of Sunday-anchored week
  // start in the browser's local tz. The server interprets this in the
  // viewer's stored timezone for consistency across devices.
  const [weekStart, setWeekStart] = useState<string>(() =>
    defaultWeekStart(),
  )
  const choresQuery = useQuery({
    queryKey: ['household-chores', householdId],
    queryFn: () => listHouseholdChoresFn({ data: { householdId } }),
    // List + Kanban both render the same flat chores result; only
    // Week mode swaps to the projected weekly endpoint.
    enabled: viewMode !== 'week',
  })
  const weekQuery = useQuery({
    queryKey: ['household-chores-week', householdId, weekStart],
    queryFn: () =>
      listHouseholdChoresWeekFn({
        data: { householdId, startDateLocal: weekStart },
      }),
    enabled: viewMode === 'week',
  })
  const complete = useMutation({
    mutationFn: (vars: { instanceId: string; creditUserId?: string }) =>
      completeInstance({
        data: { instanceId: vars.instanceId, force: true, creditUserId: vars.creditUserId },
      }),
    onSuccess: (res) => {
      if ('alreadyHandled' in res && res.alreadyHandled) {
        toast.message('Already done!')
      } else if ('pendingApproval' in res && res.pendingApproval) {
        toast.success('Submitted — waiting for a grown-up to approve.')
      } else if ('xp' in res) {
        toast.success(`+${res.xp} XP`)
      }
      qc.invalidateQueries({ queryKey: ['household-chores', householdId] })
      qc.invalidateQueries({ queryKey: ['household-chores-week', householdId] })
      qc.invalidateQueries({ queryKey: ['household-pending-approvals', householdId] })
      qc.invalidateQueries({ queryKey: ['today'] })
      qc.invalidateQueries({ queryKey: ['progression'] })
    },
    onError: (err: unknown) => {
      toast.error(err instanceof Error ? err.message : 'Failed to complete.')
    },
  })

  // null = no dialog open; an object = pick-who-gets-credit dialog open.
  const [creditPicker, setCreditPicker] = useState<CreditPicker | null>(null)

  const chores = choresQuery.data ?? []
  const weekRows = weekQuery.data ?? []
  // Kids and kiosks can't author chores. Kid is blocked at the
  // server (createTask rejects); kiosk is also blocked AND its
  // /tasks/new navigation is bounced back to /household by the
  // KioskRedirect guard — so the button would look broken if shown.
  const canCreate = viewerRole !== 'kid' && viewerRole !== 'kiosk'
  const memberById = new Map(members.map((m) => [m.userId, m]))

  // Members in the household excluding kiosks. Used for assignee
  // filter chips and Kanban columns — kiosks aren't people.
  const realMembers = members.filter((m) => m.role !== 'kiosk')

  // Apply filter + sort to flat chores (list + kanban modes).
  // Week mode applies only the filter (its day grouping is its sort).
  function filterChore(c: {
    assignedToUserId: string | null
  }): boolean {
    if (filterAssignee === 'all') return true
    if (filterAssignee === 'mine') {
      return (
        c.assignedToUserId === viewerUserId || c.assignedToUserId === null
      )
    }
    if (filterAssignee === 'ffa') return c.assignedToUserId === null
    return c.assignedToUserId === filterAssignee
  }
  const filteredChores = chores.filter(filterChore)
  const sortedChores = [...filteredChores].sort((a, b) => {
    if (sortBy === 'due') {
      // null due (someday-style) sinks to the bottom.
      if (a.dueAt === null && b.dueAt === null) return 0
      if (a.dueAt === null) return 1
      if (b.dueAt === null) return -1
      return a.dueAt.localeCompare(b.dueAt)
    }
    if (sortBy === 'title') {
      return a.title.localeCompare(b.title)
    }
    // assignee: FFA last, then by assignee name, with null last
    const aName = a.assignedToUserId
      ? memberById.get(a.assignedToUserId)?.name ??
        a.assignedToName ??
        ''
      : ''
    const bName = b.assignedToUserId
      ? memberById.get(b.assignedToUserId)?.name ??
        b.assignedToName ??
        ''
      : ''
    if (!aName && bName) return 1
    if (aName && !bName) return -1
    return aName.localeCompare(bName)
  })
  const filteredWeekRows = weekRows.filter(filterChore)

  // Split chores into what's actionable now vs later, so the list can
  // tuck not-yet-due chores into a collapsible "Upcoming" section (the
  // same idea as Today's "Later today"). A chore is "upcoming" when its
  // due time is still in the future — later today or a future day.
  // Overdue / due-now chores and someday (null-due) chores stay in the
  // main list.
  const now = new Date()
  function isUpcoming(c: { dueAt: string | null }): boolean {
    return c.dueAt !== null && new Date(c.dueAt) > now
  }
  const nowChores = sortedChores.filter((c) => !isUpcoming(c))
  const upcomingChores = sortedChores.filter(isUpcoming)

  function renderChore(c: (typeof sortedChores)[number]) {
    const assigneeLabel = c.assignedToName ?? `@${c.assignedToHandle ?? ''}`
    return (
      <li
        key={c.instanceId}
        className="relative flex items-center justify-between gap-3 overflow-hidden rounded-lg border border-[var(--line)] bg-[var(--option-bg)] py-2 pl-4 pr-3"
      >
        <span
          aria-hidden="true"
          className="absolute inset-y-0 left-0 w-1"
          style={assigneeBarStyle(c, members)}
        />
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <span className="truncate font-medium text-[var(--sea-ink)]">
              {c.title}
            </span>
            {c.recurring && (
              <span className="rounded-full bg-[var(--lagoon-soft)] px-2 py-0.5 text-[10px] uppercase tracking-wide text-[var(--lagoon-deep)]">
                repeats
              </span>
            )}
          </div>
          <div className="mt-1 text-xs text-[var(--sea-ink-soft)]">
            {c.assignedToUserId ? (
              <span>
                Assigned to <strong>{assigneeLabel}</strong>
              </span>
            ) : c.assigneeGroup === 'adults' ? (
              <span className="font-semibold text-[var(--lagoon-deep)]">
                Any adult
              </span>
            ) : c.assigneeGroup === 'kids' ? (
              <span className="font-semibold text-[var(--lagoon-deep)]">
                Any kid
              </span>
            ) : (
              <span className="font-semibold text-[var(--lagoon-deep)]">
                Free for all
              </span>
            )}
            {c.dueAt && (
              <span> · due {new Date(c.dueAt).toLocaleString()}</span>
            )}
          </div>
        </div>
        {canCompleteChore(c.assignedToUserId, c.assigneeGroup) && (
          <button
            type="button"
            onClick={() =>
              clickChore({
                instanceId: c.instanceId,
                title: c.title,
                assignedToUserId: c.assignedToUserId,
                assignedToHandle: c.assignedToHandle,
                assignedToName: c.assignedToName,
              })
            }
            disabled={complete.isPending}
            className="rounded-lg bg-[var(--btn-primary-bg)] px-3 py-1.5 text-xs font-semibold text-[var(--btn-primary-fg)] disabled:opacity-50"
          >
            Complete
          </button>
        )}
      </li>
    )
  }

  // Shared click handler: decides whether to open the credit picker
  // or complete immediately, based on viewer role + assignment.
  function clickChore(c: {
    instanceId: string
    title: string
    assignedToUserId: string | null
    assignedToHandle: string | null
    assignedToName: string | null
  }): void {
    const isMine =
      c.assignedToUserId !== null && c.assignedToUserId === viewerUserId
    const isForSomeoneElse = c.assignedToUserId !== null && !isMine
    // Kiosks ALWAYS open the credit picker — the iPad doesn't know
    // who's tapping, so every completion needs an explicit "who did
    // this?" pick. Admins skip the picker only on their own chores.
    // Members open it only when crediting on behalf.
    const opensDialog =
      viewerRole === 'kiosk'
        ? true
        : viewerRole === 'admin'
          ? !isMine
          : viewerRole === 'member' && isForSomeoneElse
    const assigneeLabel = c.assignedToName ?? `@${c.assignedToHandle ?? ''}`
    if (opensDialog) {
      setCreditPicker({
        instanceId: c.instanceId,
        title: c.title,
        assignedToUserId: c.assignedToUserId,
        assignedToName: assigneeLabel,
      })
    } else {
      complete.mutate({ instanceId: c.instanceId })
    }
  }

  function canCompleteChore(
    assignedToUserId: string | null,
    assigneeGroup: 'adults' | 'kids' | null,
  ): boolean {
    const isMine =
      assignedToUserId !== null && assignedToUserId === viewerUserId
    const isFreeForAll = assignedToUserId === null
    if (viewerRole === 'kid') {
      // Kids can complete their own + open chores, but never an
      // "any adult" chore (the server rejects it too).
      if (assigneeGroup === 'adults') return false
      return isMine || isFreeForAll
    }
    return true
  }

  return (
    <div className="space-y-3">
      <HouseholdStatsCompact householdId={householdId} />

      <div className="flex flex-wrap items-center gap-2">
        <div
          className="flex gap-1 rounded-full border border-[var(--line)] bg-[var(--option-bg)] p-1"
          role="radiogroup"
          aria-label="View"
        >
          {(
            [
              ['list', 'List'],
              ['week', 'Week'],
              ['kanban', 'User'],
            ] as const
          ).map(([value, label]) => (
            <button
              key={value}
              type="button"
              role="radio"
              aria-checked={viewMode === value}
              onClick={() => setViewMode(value)}
              className={`rounded-full px-3 py-1 text-xs font-semibold transition ${
                viewMode === value
                  ? 'bg-[var(--btn-primary-bg)] text-[var(--btn-primary-fg)]'
                  : 'text-[var(--sea-ink-soft)] hover:text-[var(--sea-ink)]'
              }`}
            >
              {label}
            </button>
          ))}
        </div>
        {/* Sort sits in the view-toggle row so it has a home even when
            the filter-chip row below is hidden (Kanban mode). Week
            mode doesn't sort — its day grid is its own ordering — so
            the dropdown collapses there. */}
        {viewMode !== 'week' && (
          <label className="ml-auto flex items-center gap-1 text-xs text-[var(--sea-ink-soft)]">
            <span className="font-semibold uppercase tracking-wide">Sort</span>
            <select
              value={sortBy}
              onChange={(e) =>
                setSortBy(e.target.value as 'due' | 'title' | 'assignee')
              }
              className="field-input w-auto rounded-md px-2 py-1 text-xs"
            >
              <option value="due">Due date</option>
              <option value="title">Title</option>
              <option value="assignee">Assignee</option>
            </select>
          </label>
        )}
        {canCreate && (
          <Link
            to="/tasks/new"
            search={{ household: 1 }}
            className={`${viewMode === 'week' ? 'ml-auto' : ''} rounded-full border border-[rgba(50,143,151,0.3)] bg-[rgba(79,184,178,0.14)] px-4 py-2 text-sm font-semibold text-[var(--lagoon-deep)] no-underline`}
          >
            + New chore
          </Link>
        )}
      </div>

      <ChoreFiltersBar
        viewMode={viewMode}
        filterAssignee={filterAssignee}
        setFilterAssignee={setFilterAssignee}
        members={realMembers}
        viewerUserId={viewerUserId}
        viewerRole={viewerRole}
      />

      {viewMode === 'list' ? (
        choresQuery.isLoading ? (
          <p className="text-[var(--sea-ink-soft)]">Loading chores…</p>
        ) : sortedChores.length === 0 ? (
          <section className="island-shell rounded-2xl p-4 text-center text-sm text-[var(--sea-ink-soft)]">
            {chores.length === 0 ? (
              <>
                No open household chores.
                {canCreate && (
                  <span> Tap &ldquo;New chore&rdquo; to add one.</span>
                )}
              </>
            ) : (
              <>No chores match the current filter.</>
            )}
          </section>
        ) : (
          <section className="island-shell space-y-3 rounded-2xl p-4">
            {nowChores.length > 0 ? (
              <ul className="space-y-2">{nowChores.map(renderChore)}</ul>
            ) : (
              <p className="text-sm text-[var(--sea-ink-soft)]">
                Nothing due yet — see what&rsquo;s upcoming below.
              </p>
            )}
            {upcomingChores.length > 0 ? (
              <details className="rounded-xl border border-[var(--line)] bg-[var(--option-bg)] p-3">
                <summary className="cursor-pointer text-xs font-semibold uppercase tracking-wide text-[var(--kicker)]">
                  Upcoming ({upcomingChores.length})
                </summary>
                <ul className="mt-3 space-y-2">
                  {upcomingChores.map(renderChore)}
                </ul>
              </details>
            ) : null}
          </section>
        )
      ) : viewMode === 'week' ? (
        <WeekView
          weekStart={weekStart}
          setWeekStart={setWeekStart}
          rows={filteredWeekRows}
          isLoading={weekQuery.isLoading}
          viewerUserId={viewerUserId}
          memberById={memberById}
          onClickChore={clickChore}
          canCompleteChore={canCompleteChore}
          completePending={complete.isPending}
        />
      ) : (
        <KanbanView
          isLoading={choresQuery.isLoading}
          chores={sortedChores}
          members={realMembers}
          memberById={memberById}
          viewerUserId={viewerUserId}
          onClickChore={clickChore}
          canCompleteChore={canCompleteChore}
          completePending={complete.isPending}
        />
      )}

      <CreditPickerDialog
        pending={creditPicker}
        viewerRole={viewerRole}
        viewerUserId={viewerUserId}
        members={members}
        onCancel={() => setCreditPicker(null)}
        onConfirm={(creditUserId) => {
          if (!creditPicker) return
          complete.mutate({
            instanceId: creditPicker.instanceId,
            creditUserId,
          })
          setCreditPicker(null)
        }}
      />
    </div>
  )
}

type WeekRow = {
  instanceId: string | null
  taskId: string
  title: string
  difficulty: 'small' | 'medium' | 'large'
  xpOverride: number | null
  dueAt: string
  timeOfDay: string | null
  localDay: string
  assignedToUserId: string | null
  assignedToHandle: string | null
  assignedToName: string | null
  assigneeGroup: 'adults' | 'kids' | null
  recurring: boolean
  completedAt: string | null
  completedByUserId: string | null
  skippedAt: string | null
}

function ChoreFiltersBar({
  viewMode,
  filterAssignee,
  setFilterAssignee,
  members,
  viewerUserId,
  viewerRole,
}: {
  viewMode: 'list' | 'week' | 'kanban'
  filterAssignee: string
  setFilterAssignee: (v: string) => void
  members: HouseholdMemberRow[]
  viewerUserId: string | undefined
  viewerRole: 'admin' | 'member' | 'kid' | 'kiosk'
}) {
  // Sort doesn't affect Week mode (the day grid is its own order),
  // and the Kanban columns ARE the assignee groupings — filtering
  // "Mine" or per-member there would empty out other columns, which
  // is occasionally useful but mostly noisy. Keep both bars
  // available everywhere so the controls don't pop in and out.
  // Kanban already groups by assignee via its columns, so the filter
  // chips would just be a way to hide columns — that defeats the
  // whole-family overview. Hide the row there; keep it everywhere
  // else. The Sort dropdown lives in the view-toggle row above, so
  // it's not affected by this gate.
  const showFilters = viewMode !== 'kanban'
  // When the filter row is hidden, force the assignee back to "all"
  // so a stale selection isn't silently filtering the next view.
  useEffect(() => {
    if (!showFilters && filterAssignee !== 'all') {
      setFilterAssignee('all')
    }
  }, [showFilters, filterAssignee, setFilterAssignee])
  if (!showFilters) return null
  return (
    <div
      className="flex flex-wrap gap-1 rounded-full border border-[var(--line)] bg-[var(--option-bg)] p-1"
      role="radiogroup"
      aria-label="Filter"
    >
        <FilterChip
          checked={filterAssignee === 'all'}
          onClick={() => setFilterAssignee('all')}
          label="All"
        />
        {viewerUserId && viewerRole !== 'kiosk' && (
          <FilterChip
            checked={filterAssignee === 'mine'}
            onClick={() => setFilterAssignee('mine')}
            label="Mine"
          />
        )}
        <FilterChip
          checked={filterAssignee === 'ffa'}
          onClick={() => setFilterAssignee('ffa')}
          label="Free-for-all"
        />
      {members.map((m) => (
        <FilterChip
          key={m.userId}
          checked={filterAssignee === m.userId}
          onClick={() => setFilterAssignee(m.userId)}
          label={m.name}
          dotColor={m.color ?? undefined}
        />
      ))}
    </div>
  )
}

function FilterChip({
  checked,
  onClick,
  label,
  dotColor,
}: {
  checked: boolean
  onClick: () => void
  label: string
  dotColor?: string
}) {
  return (
    <button
      type="button"
      role="radio"
      aria-checked={checked}
      onClick={onClick}
      className={`flex items-center gap-1.5 rounded-full px-3 py-1 text-xs font-semibold transition ${
        checked
          ? 'bg-[var(--btn-primary-bg)] text-[var(--btn-primary-fg)]'
          : 'text-[var(--sea-ink-soft)] hover:text-[var(--sea-ink)]'
      }`}
    >
      {dotColor ? (
        <span
          aria-hidden
          className="inline-block h-2 w-2 rounded-full"
          style={{ backgroundColor: dotColor }}
        />
      ) : null}
      <span>{label}</span>
    </button>
  )
}

type KanbanChore = {
  instanceId: string
  taskId: string
  title: string
  xpOverride: number | null
  dueAt: string | null
  dueKind: 'hard' | 'week_target'
  assignedToUserId: string | null
  assignedToHandle: string | null
  assignedToName: string | null
  assigneeGroup: 'adults' | 'kids' | null
  recurring: boolean
}

function KanbanView({
  isLoading,
  chores,
  members,
  memberById,
  viewerUserId,
  onClickChore,
  canCompleteChore,
  completePending,
}: {
  isLoading: boolean
  chores: KanbanChore[]
  members: HouseholdMemberRow[]
  memberById: Map<string, HouseholdMemberRow>
  viewerUserId: string | undefined
  onClickChore: (c: {
    instanceId: string
    title: string
    assignedToUserId: string | null
    assignedToHandle: string | null
    assignedToName: string | null
  }) => void
  canCompleteChore: (
    assignedToUserId: string | null,
    assigneeGroup: 'adults' | 'kids' | null,
  ) => boolean
  completePending: boolean
}) {
  if (isLoading) {
    return <p className="text-[var(--sea-ink-soft)]">Loading chores…</p>
  }

  // Group chores by assignee. A null assigneeId goes into the FFA
  // column. Chores assigned to a user who's left the household get
  // an orphan column so they don't silently vanish; admins can
  // reassign or delete from there.
  const byAssignee = new Map<string, KanbanChore[]>()
  byAssignee.set('__ffa__', [])
  byAssignee.set('__adults__', [])
  byAssignee.set('__kids__', [])
  for (const m of members) byAssignee.set(m.userId, [])
  for (const c of chores) {
    // Group-targeted chores have no specific assignee — bucket them by
    // their role group; plain free-for-all falls through to __ffa__.
    const key =
      c.assignedToUserId ??
      (c.assigneeGroup === 'adults'
        ? '__adults__'
        : c.assigneeGroup === 'kids'
          ? '__kids__'
          : '__ffa__')
    const bucket = byAssignee.get(key) ?? []
    bucket.push(c)
    byAssignee.set(key, bucket)
  }

  // Column order: viewer first (their column on the left = primary
  // attention), then other members in join order, then FFA, then any
  // orphan columns.
  const orderedMemberIds: string[] = []
  if (viewerUserId && byAssignee.has(viewerUserId)) {
    orderedMemberIds.push(viewerUserId)
  }
  for (const m of members) {
    if (m.userId === viewerUserId) continue
    orderedMemberIds.push(m.userId)
  }
  const orphanIds: string[] = []
  for (const key of byAssignee.keys()) {
    if (key === '__ffa__' || key === '__adults__' || key === '__kids__') {
      continue
    }
    if (orderedMemberIds.includes(key)) continue
    orphanIds.push(key)
  }

  const columns: Array<{
    key: string
    label: string
    color: string | null
    isFFA: boolean
    chores: KanbanChore[]
  }> = []
  for (const id of orderedMemberIds) {
    const m = memberById.get(id)
    if (!m) continue
    columns.push({
      key: id,
      label: id === viewerUserId ? `${m.name} (you)` : m.name,
      color: m.color,
      isFFA: false,
      chores: byAssignee.get(id) ?? [],
    })
  }
  // Role-group columns appear only when they hold chores, so households
  // that never use group assignment don't see empty columns.
  const adultsChores = byAssignee.get('__adults__') ?? []
  if (adultsChores.length > 0) {
    columns.push({
      key: '__adults__',
      label: 'Any adult',
      color: null,
      isFFA: true,
      chores: adultsChores,
    })
  }
  const kidsChores = byAssignee.get('__kids__') ?? []
  if (kidsChores.length > 0) {
    columns.push({
      key: '__kids__',
      label: 'Any kid',
      color: null,
      isFFA: true,
      chores: kidsChores,
    })
  }
  columns.push({
    key: '__ffa__',
    label: 'Free for all',
    color: null,
    isFFA: true,
    chores: byAssignee.get('__ffa__') ?? [],
  })
  for (const id of orphanIds) {
    const sample = (byAssignee.get(id) ?? [])[0]
    columns.push({
      key: id,
      label: sample?.assignedToName ?? `@${sample?.assignedToHandle ?? '?'}`,
      color: null,
      isFFA: false,
      chores: byAssignee.get(id) ?? [],
    })
  }

  return (
    <div className="-mx-4 overflow-x-auto px-4 pb-2 sm:mx-0 sm:px-0">
      <div className="flex gap-3 sm:grid sm:auto-cols-[minmax(220px,1fr)] sm:grid-flow-col sm:gap-3">
        {columns.map((col) => (
          <section
            key={col.key}
            className="min-w-[220px] flex-shrink-0 rounded-2xl border border-[var(--line)] bg-[var(--option-bg)] p-3"
          >
            <header className="mb-2 flex items-center gap-2">
              {col.isFFA ? (
                <span
                  aria-hidden
                  className="inline-block h-2.5 w-2.5 rounded-full bg-[var(--lagoon-deep)]"
                />
              ) : (
                <span
                  aria-hidden
                  className="inline-block h-2.5 w-2.5 rounded-full"
                  style={{
                    backgroundColor: col.color ?? '#cccccc',
                  }}
                />
              )}
              <h3 className="flex-1 truncate text-sm font-bold text-[var(--sea-ink)]">
                {col.label}
              </h3>
              <span className="text-xs tabular-nums text-[var(--sea-ink-soft)]">
                {col.chores.length}
              </span>
            </header>
            {col.chores.length === 0 ? (
              <p className="text-xs text-[var(--sea-ink-soft)]">—</p>
            ) : (
              <ul className="space-y-2">
                {col.chores.map((c) => (
                  <li
                    key={c.instanceId}
                    className="rounded-lg border border-[var(--line)] bg-[var(--surface-strong)] p-2"
                    style={{
                      borderLeft: `4px solid ${col.color ?? 'var(--line)'}`,
                    }}
                  >
                    <div className="flex items-start gap-2">
                      <div className="min-w-0 flex-1">
                        <div className="flex flex-wrap items-center gap-1.5">
                          <span className="truncate text-sm font-medium text-[var(--sea-ink)]">
                            {c.title}
                          </span>
                          {c.recurring && (
                            <span className="rounded-full bg-[var(--lagoon-soft)] px-1.5 py-0 text-[10px] uppercase tracking-wide text-[var(--lagoon-deep)]">
                              repeats
                            </span>
                          )}
                        </div>
                        <div className="mt-1 text-[10px] text-[var(--sea-ink-soft)]">
                          {c.dueAt
                            ? `due ${new Date(c.dueAt).toLocaleString()}`
                            : 'anytime'}
                        </div>
                      </div>
                      {canCompleteChore(c.assignedToUserId, c.assigneeGroup) && (
                        <button
                          type="button"
                          onClick={() =>
                            onClickChore({
                              instanceId: c.instanceId,
                              title: c.title,
                              assignedToUserId: c.assignedToUserId,
                              assignedToHandle: c.assignedToHandle,
                              assignedToName: c.assignedToName,
                            })
                          }
                          disabled={completePending}
                          className="flex-shrink-0 rounded-md bg-[var(--btn-primary-bg)] px-2 py-1 text-[10px] font-semibold text-[var(--btn-primary-fg)] disabled:opacity-50"
                        >
                          ✓
                        </button>
                      )}
                    </div>
                  </li>
                ))}
              </ul>
            )}
          </section>
        ))}
      </div>
    </div>
  )
}

function WeekView({
  weekStart,
  setWeekStart,
  rows,
  isLoading,
  viewerUserId,
  memberById,
  onClickChore,
  canCompleteChore,
  completePending,
}: {
  weekStart: string
  setWeekStart: (s: string) => void
  rows: WeekRow[]
  isLoading: boolean
  viewerUserId: string | undefined
  memberById: Map<string, HouseholdMemberRow>
  onClickChore: (c: {
    instanceId: string
    title: string
    assignedToUserId: string | null
    assignedToHandle: string | null
    assignedToName: string | null
  }) => void
  canCompleteChore: (
    assignedToUserId: string | null,
    assigneeGroup: 'adults' | 'kids' | null,
  ) => boolean
  completePending: boolean
}) {
  const members = Array.from(memberById.values())
  // Build the 7-day shell from weekStart so empty days still render.
  const days: { iso: string; label: string; weekday: string }[] = []
  for (let i = 0; i < 7; i++) {
    const iso = addDaysToDateStr(weekStart, i)
    const [y, m, d] = iso.split('-').map(Number)
    const date = new Date(y, m - 1, d)
    days.push({
      iso,
      weekday: WEEKDAY_LABEL[date.getDay()],
      label: date.toLocaleDateString(undefined, {
        month: 'short',
        day: 'numeric',
      }),
    })
  }
  const todayIso = formatLocalDate(new Date())
  const rowsByDay = new Map<string, WeekRow[]>()
  for (const r of rows) {
    const arr = rowsByDay.get(r.localDay) ?? []
    arr.push(r)
    rowsByDay.set(r.localDay, arr)
  }

  // Pretty range for the header: "Dec 1 – Dec 7" (or with year if not
  // current year). Cheap and self-contained.
  const startLabel = (() => {
    const [y, m, d] = weekStart.split('-').map(Number)
    return new Date(y, m - 1, d).toLocaleDateString(undefined, {
      month: 'short',
      day: 'numeric',
    })
  })()
  const endLabel = (() => {
    const endIso = addDaysToDateStr(weekStart, 6)
    const [y, m, d] = endIso.split('-').map(Number)
    return new Date(y, m - 1, d).toLocaleDateString(undefined, {
      month: 'short',
      day: 'numeric',
    })
  })()

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center justify-between gap-2 rounded-2xl border border-[var(--line)] bg-[var(--option-bg)] px-3 py-2">
        <div className="flex items-center gap-1">
          <button
            type="button"
            onClick={() => setWeekStart(addDaysToDateStr(weekStart, -7))}
            className="rounded-md px-2 py-1 text-xs font-semibold text-[var(--sea-ink-soft)] hover:text-[var(--sea-ink)]"
            aria-label="Previous week"
          >
            ←
          </button>
          <button
            type="button"
            onClick={() => setWeekStart(defaultWeekStart())}
            className="rounded-md px-2 py-1 text-xs font-semibold text-[var(--sea-ink-soft)] hover:text-[var(--sea-ink)]"
          >
            This week
          </button>
          <button
            type="button"
            onClick={() => setWeekStart(addDaysToDateStr(weekStart, 7))}
            className="rounded-md px-2 py-1 text-xs font-semibold text-[var(--sea-ink-soft)] hover:text-[var(--sea-ink)]"
            aria-label="Next week"
          >
            →
          </button>
        </div>
        <p className="text-sm font-semibold text-[var(--sea-ink)]">
          {startLabel} – {endLabel}
        </p>
      </div>

      {isLoading ? (
        <p className="text-[var(--sea-ink-soft)]">Loading week…</p>
      ) : (
        // Mobile: stacked column (one section per day).
        // Desktop (md+): 7-column grid so the whole week fits as a
        // single calendar-style row. Each day stays in its own
        // bordered card; today is highlighted.
        <div className="space-y-3 md:grid md:grid-cols-7 md:gap-2 md:space-y-0">
          {days.map((day) => {
            const dayRows = (rowsByDay.get(day.iso) ?? []).sort((a, b) =>
              a.dueAt.localeCompare(b.dueAt),
            )
            const isToday = day.iso === todayIso
            return (
              <section
                key={day.iso}
                className={`rounded-2xl border p-3 md:min-h-[10rem] ${
                  isToday
                    ? 'border-[var(--lagoon-deep)] bg-[rgba(79,184,178,0.08)]'
                    : 'border-[var(--line)] bg-[var(--option-bg)]'
                }`}
              >
                <header className="mb-2 flex items-baseline justify-between gap-2 md:flex-col md:items-start md:gap-0">
                  <h3 className="text-sm font-bold text-[var(--sea-ink)]">
                    {day.weekday}
                    {isToday ? (
                      <span className="ml-2 text-xs font-semibold uppercase tracking-wide text-[var(--lagoon-deep)]">
                        Today
                      </span>
                    ) : null}
                  </h3>
                  <span className="text-xs text-[var(--sea-ink-soft)]">
                    {day.label}
                  </span>
                </header>
                {dayRows.length === 0 ? (
                  <p className="text-xs text-[var(--sea-ink-soft)]">—</p>
                ) : (
                  <ul className="space-y-2">
                    {dayRows.map((r) => {
                      return (
                        <WeekRowItem
                          key={`${r.taskId}-${r.dueAt}`}
                          row={r}
                          viewerUserId={viewerUserId}
                          memberById={memberById}
                          barStyle={assigneeBarStyle(r, members)}
                          onClick={onClickChore}
                          canCompleteChore={canCompleteChore}
                          completePending={completePending}
                        />
                      )
                    })}
                  </ul>
                )}
              </section>
            )
          })}
        </div>
      )}
    </div>
  )
}

function WeekRowItem({
  row,
  viewerUserId,
  memberById,
  barStyle,
  onClick,
  canCompleteChore,
  completePending,
}: {
  row: WeekRow
  viewerUserId: string | undefined
  memberById: Map<string, HouseholdMemberRow>
  barStyle: { backgroundColor?: string; backgroundImage?: string }
  onClick: (c: {
    instanceId: string
    title: string
    assignedToUserId: string | null
    assignedToHandle: string | null
    assignedToName: string | null
  }) => void
  canCompleteChore: (
    assignedToUserId: string | null,
    assigneeGroup: 'adults' | 'kids' | null,
  ) => boolean
  completePending: boolean
}) {
  const isProjection = row.instanceId === null
  const isCompleted = !!row.completedAt
  const isSkipped = !!row.skippedAt
  const isAssignedToMe =
    row.assignedToUserId !== null && row.assignedToUserId === viewerUserId
  const assigneeLabel = row.assignedToUserId
    ? row.assignedToName ?? `@${row.assignedToHandle ?? ''}`
    : null
  const completer = row.completedByUserId
    ? memberById.get(row.completedByUserId)
    : null
  const timeLabel = row.timeOfDay
    ? row.timeOfDay
    : new Date(row.dueAt).toLocaleTimeString(undefined, {
        hour: 'numeric',
        minute: '2-digit',
      })

  const showButton =
    !isProjection &&
    !isCompleted &&
    !isSkipped &&
    canCompleteChore(row.assignedToUserId, row.assigneeGroup)

  return (
    <li
      className={`relative flex flex-col gap-2 overflow-hidden rounded-lg border p-2 pl-3 ${
        isProjection
          ? 'border-dashed border-[var(--line)] bg-transparent opacity-60'
          : isCompleted
            ? 'border-[var(--line)] bg-[var(--option-bg)] opacity-70'
            : 'border-[var(--line)] bg-[var(--surface-strong)]'
      } ${isAssignedToMe && !isCompleted ? 'ring-1 ring-[var(--lagoon-deep)]' : ''}`}
    >
      <span
        aria-hidden="true"
        className="absolute inset-y-0 left-0 w-1"
        style={barStyle}
      />
      <div className="min-w-0">
        {/* Title wraps freely — week columns get narrow, especially on
            7-col desktop, and truncating short titles ("clear the t…")
            felt punishing. break-words covers single long words too. */}
        <p
          className={`break-words text-sm font-medium leading-snug text-[var(--sea-ink)] ${
            isCompleted ? 'line-through' : ''
          }`}
        >
          {row.title}
        </p>
        <div className="mt-1 flex flex-wrap items-center gap-1">
          <span className="rounded-full border border-[var(--line)] px-1.5 py-0 text-[10px] font-semibold text-[var(--sea-ink-soft)]">
            {timeLabel}
          </span>
          {row.recurring && (
            <span className="rounded-full bg-[var(--lagoon-soft)] px-1.5 py-0 text-[10px] uppercase tracking-wide text-[var(--lagoon-deep)]">
              repeats
            </span>
          )}
          {isProjection && (
            <span className="rounded-full border border-dashed border-[var(--sea-ink-soft)] px-1.5 py-0 text-[10px] font-semibold uppercase tracking-wide text-[var(--sea-ink-soft)]">
              scheduled
            </span>
          )}
        </div>
        <p className="mt-1 break-words text-[11px] leading-tight text-[var(--sea-ink-soft)]">
          {assigneeLabel ? (
            <>
              <strong>{assigneeLabel}</strong>
            </>
          ) : (
            <span className="font-semibold text-[var(--lagoon-deep)]">
              {row.assigneeGroup === 'adults'
                ? 'Any adult'
                : row.assigneeGroup === 'kids'
                  ? 'Any kid'
                  : 'Free for all'}
            </span>
          )}
          {isCompleted && completer ? (
            <span> · ✓ {completer.name}</span>
          ) : null}
          {isSkipped ? <span> · skipped</span> : null}
        </p>
      </div>
      {showButton && (
        <div className="flex justify-end">
          <button
            type="button"
            onClick={() =>
              onClick({
                instanceId: row.instanceId!,
                title: row.title,
                assignedToUserId: row.assignedToUserId,
                assignedToHandle: row.assignedToHandle,
                assignedToName: row.assignedToName,
              })
            }
            disabled={completePending}
            className="rounded-md bg-[var(--btn-primary-bg)] px-2.5 py-1 text-[11px] font-semibold text-[var(--btn-primary-fg)] disabled:opacity-50"
          >
            Complete
          </button>
        </div>
      )}
    </li>
  )
}

function CreditPickerDialog({
  pending,
  viewerRole,
  viewerUserId,
  members,
  onCancel,
  onConfirm,
}: {
  pending: CreditPicker | null
  viewerRole: 'admin' | 'member' | 'kid' | 'kiosk'
  viewerUserId: string | undefined
  members: HouseholdMemberRow[]
  onCancel: () => void
  onConfirm: (creditUserId: string) => void
}) {
  const dialogRef = useRef<HTMLDialogElement | null>(null)
  // Default the radio to the assignee — that's the most common
  // intent: "credit the person the chore is for."
  const [pickedUserId, setPickedUserId] = useState<string | null>(null)

  useEffect(() => {
    const el = dialogRef.current
    if (!el) return
    if (pending && !el.open) {
      // Default: the assignee on assigned chores. For kiosks on
      // free-for-all chores there's no good default (the "kiosk"
      // didn't do it), so leave the radio empty and force a choice.
      const fallback = viewerRole === 'kiosk' ? null : (viewerUserId ?? null)
      setPickedUserId(pending.assignedToUserId ?? fallback)
      el.showModal()
    } else if (!pending && el.open) {
      el.close()
    }
  }, [pending, viewerUserId, viewerRole])

  // Build the list of options the viewer is allowed to credit.
  //  - admin / kiosk: all household members (kiosk = shared family
  //    device; admin = manager). Both can credit anyone.
  //  - member: themselves + the chore's assignee (if any)
  //  - kid: shouldn't see this dialog at all (button hidden upstream)
  const options: HouseholdMemberRow[] = (() => {
    if (!pending) return []
    if (viewerRole === 'admin' || viewerRole === 'kiosk') {
      // Hide other kiosks from the picker (you wouldn't credit "the
      // iPad" with a chore completion).
      return members.filter((m) => m.role !== 'kiosk')
    }
    const allowedIds = new Set<string>()
    if (viewerUserId) allowedIds.add(viewerUserId)
    if (pending.assignedToUserId) allowedIds.add(pending.assignedToUserId)
    return members.filter((m) => allowedIds.has(m.userId))
  })()

  return (
    <dialog
      ref={dialogRef}
      onClose={onCancel}
      onClick={(e) => {
        if (e.target === dialogRef.current) onCancel()
      }}
      className="m-auto w-[min(420px,calc(100%-1.5rem))] rounded-2xl border border-[var(--line)] bg-[var(--surface)] p-0 text-[var(--sea-ink)] shadow-2xl backdrop:bg-black/40 backdrop:backdrop-blur-sm"
    >
      {pending ? (
        <div className="flex flex-col gap-4 p-5">
          <div>
            <h3 className="display-title text-lg font-bold text-[var(--sea-ink)]">
              Who gets credit?
            </h3>
            <p className="mt-1 text-sm text-[var(--sea-ink-soft)]">
              Completing &ldquo;{pending.title}&rdquo; — pick who earns the XP
              and streak for this chore.
            </p>
          </div>
          <fieldset className="flex flex-col gap-2">
            {options.map((m) => {
              const isAssignee = m.userId === pending.assignedToUserId
              const isMe = m.userId === viewerUserId
              return (
                <label
                  key={m.userId}
                  className={`flex cursor-pointer items-center gap-3 rounded-xl border p-3 text-sm ${
                    pickedUserId === m.userId
                      ? 'border-[var(--lagoon-deep)] bg-[rgba(79,184,178,0.1)]'
                      : 'border-[var(--line)] bg-[var(--option-bg)]'
                  }`}
                >
                  <input
                    type="radio"
                    name="credit-user"
                    value={m.userId}
                    checked={pickedUserId === m.userId}
                    onChange={() => setPickedUserId(m.userId)}
                  />
                  <span className="flex-1">
                    <span className="block font-semibold text-[var(--sea-ink)]">
                      {isMe ? `Me (${m.name})` : m.name}
                    </span>
                    <span className="block text-xs text-[var(--sea-ink-soft)]">
                      @{m.handle}
                      {isAssignee ? ' · originally assigned' : ''}
                    </span>
                  </span>
                </label>
              )
            })}
          </fieldset>
          <div className="flex justify-end gap-2">
            <button
              type="button"
              onClick={onCancel}
              className="rounded-full border border-[var(--line)] bg-[var(--option-bg)] px-3 py-1.5 text-xs font-semibold text-[var(--sea-ink-soft)]"
            >
              Cancel
            </button>
            <button
              type="button"
              onClick={() => {
                if (pickedUserId) onConfirm(pickedUserId)
              }}
              disabled={!pickedUserId}
              className="rounded-full border border-[rgba(50,143,151,0.3)] bg-[rgba(79,184,178,0.14)] px-3 py-1.5 text-xs font-semibold text-[var(--lagoon-deep)] disabled:opacity-50"
            >
              Complete
            </button>
          </div>
        </div>
      ) : null}
    </dialog>
  )
}

function ReviewTab({
  householdId,
  members,
}: {
  householdId: string
  members: HouseholdMemberRow[]
}) {
  const qc = useQueryClient()
  const query = useQuery({
    queryKey: ['household-pending-approvals', householdId],
    queryFn: () =>
      listPendingApprovalsFn({ data: { householdId } }),
  })
  function invalidate() {
    qc.invalidateQueries({ queryKey: ['household-pending-approvals', householdId] })
    qc.invalidateQueries({ queryKey: ['household-chores', householdId] })
    qc.invalidateQueries({ queryKey: ['household-chores-week', householdId] })
    qc.invalidateQueries({ queryKey: ['household-activity', householdId] })
    qc.invalidateQueries({ queryKey: ['household-stats', householdId] })
    qc.invalidateQueries({ queryKey: ['today'] })
    qc.invalidateQueries({ queryKey: ['progression'] })
  }
  const approve = useMutation({
    mutationFn: (instanceId: string) =>
      approveClaimFn({ data: { instanceId } }),
    onSuccess: (res) => {
      if ('alreadyHandled' in res && res.alreadyHandled) {
        toast.message('Already handled.')
      } else if ('xp' in res) {
        toast.success(`Approved — +${res.xp} XP`)
      } else {
        toast.success('Approved.')
      }
      invalidate()
    },
    onError: (err: unknown) =>
      toast.error(err instanceof Error ? err.message : 'Approve failed.'),
  })
  const reject = useMutation({
    mutationFn: (instanceId: string) =>
      rejectClaimFn({ data: { instanceId } }),
    onSuccess: () => {
      toast.message('Sent back — chore is open again.')
      invalidate()
    },
    onError: (err: unknown) =>
      toast.error(err instanceof Error ? err.message : 'Reject failed.'),
  })

  const memberById = new Map(members.map((m) => [m.userId, m]))
  const rows = query.data ?? []

  if (query.isLoading) {
    return <p className="text-[var(--sea-ink-soft)]">Loading…</p>
  }
  if (rows.length === 0) {
    return (
      <section className="island-shell rounded-2xl p-4 text-center text-sm text-[var(--sea-ink-soft)]">
        Nothing waiting for review. Kid completions land here for an
        admin or member to approve.
      </section>
    )
  }

  return (
    <section className="island-shell rounded-2xl p-4">
      <ul className="space-y-2">
        {rows.map((r) => {
          const claimer = r.claimedByUserId
            ? memberById.get(r.claimedByUserId)
            : null
          const claimerColor = claimer?.color ?? null
          const assigneeColor = r.assignedToUserId
            ? memberById.get(r.assignedToUserId)?.color ?? null
            : null
          return (
            <li
              key={r.instanceId}
              className="flex flex-col gap-2 rounded-lg border border-[var(--line)] bg-[var(--option-bg)] px-3 py-2 sm:flex-row sm:items-center sm:justify-between"
              style={{
                borderLeft: `4px solid ${claimerColor ?? assigneeColor ?? 'var(--line)'}`,
              }}
            >
              <div className="min-w-0 flex-1">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="truncate font-medium text-[var(--sea-ink)]">
                    {r.title}
                  </span>
                  {r.recurring && (
                    <span className="rounded-full bg-[var(--lagoon-soft)] px-2 py-0.5 text-[10px] uppercase tracking-wide text-[var(--lagoon-deep)]">
                      repeats
                    </span>
                  )}
                </div>
                <div className="mt-1 text-xs text-[var(--sea-ink-soft)]">
                  {claimer ? (
                    <span>
                      <strong>{claimer.name}</strong> says it&rsquo;s done
                    </span>
                  ) : (
                    <span>
                      <strong>@{r.claimedByHandle ?? '?'}</strong> says it&rsquo;s done
                    </span>
                  )}
                  <span> · claimed {relativeTime(r.claimedAt)}</span>
                </div>
              </div>
              <div className="flex flex-shrink-0 gap-2">
                <button
                  type="button"
                  onClick={() => reject.mutate(r.instanceId)}
                  disabled={reject.isPending || approve.isPending}
                  className="rounded-full border border-[var(--line)] bg-[var(--option-bg)] px-3 py-1.5 text-xs font-semibold text-[var(--sea-ink-soft)] disabled:opacity-50"
                >
                  Reject
                </button>
                <button
                  type="button"
                  onClick={() => approve.mutate(r.instanceId)}
                  disabled={approve.isPending || reject.isPending}
                  className="rounded-full bg-[var(--btn-primary-bg)] px-3 py-1.5 text-xs font-semibold text-[var(--btn-primary-fg)] disabled:opacity-50"
                >
                  Approve
                </button>
              </div>
            </li>
          )
        })}
      </ul>
    </section>
  )
}

// Pretty short-relative-time label: "2m ago", "3h ago", "yesterday",
// otherwise a date.
function relativeTime(iso: string): string {
  const ms = Date.now() - new Date(iso).getTime()
  if (ms < 60_000) return 'just now'
  const min = Math.round(ms / 60_000)
  if (min < 60) return `${min}m ago`
  const hr = Math.round(min / 60)
  if (hr < 24) return `${hr}h ago`
  const d = Math.round(hr / 24)
  if (d === 1) return 'yesterday'
  if (d < 7) return `${d}d ago`
  return new Date(iso).toLocaleDateString()
}

function StatsTab({ householdId }: { householdId: string }) {
  const [days, setDays] = useState<number>(30)
  const [metric, setMetric] = useState<'xp' | 'count'>('xp')
  const statsQuery = useQuery({
    queryKey: ['household-stats', householdId, days],
    queryFn: () =>
      listHouseholdStatsFn({ data: { householdId, days } }),
  })
  const ranges: number[] = [7, 30, 90]
  const stats = statsQuery.data

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div
          className="flex gap-1 rounded-full border border-[var(--line)] bg-[var(--option-bg)] p-1"
          role="radiogroup"
          aria-label="Window"
        >
          {ranges.map((r) => (
            <button
              key={r}
              type="button"
              role="radio"
              aria-checked={days === r}
              onClick={() => setDays(r)}
              className={`rounded-full px-3 py-1 text-xs font-semibold transition ${
                days === r
                  ? 'bg-[var(--btn-primary-bg)] text-[var(--btn-primary-fg)]'
                  : 'text-[var(--sea-ink-soft)] hover:text-[var(--sea-ink)]'
              }`}
            >
              {r}d
            </button>
          ))}
        </div>
        <div
          className="flex gap-1 rounded-full border border-[var(--line)] bg-[var(--option-bg)] p-1"
          role="radiogroup"
          aria-label="Metric"
        >
          {(['xp', 'count'] as const).map((m) => (
            <button
              key={m}
              type="button"
              role="radio"
              aria-checked={metric === m}
              onClick={() => setMetric(m)}
              className={`rounded-full px-3 py-1 text-xs font-semibold transition ${
                metric === m
                  ? 'bg-[var(--btn-primary-bg)] text-[var(--btn-primary-fg)]'
                  : 'text-[var(--sea-ink-soft)] hover:text-[var(--sea-ink)]'
              }`}
            >
              {m === 'xp' ? 'XP' : 'Count'}
            </button>
          ))}
        </div>
      </div>

      {statsQuery.isLoading || !stats ? (
        <p className="text-[var(--sea-ink-soft)]">Loading…</p>
      ) : (
        <>
          <HouseholdCompletionBar
            members={stats.members}
            totalCompletions={stats.totalCompletions}
            title="Chore completions by member"
          />
          <HouseholdXpMultiLine
            members={stats.members}
            dateKeys={stats.dateKeys}
            metric={metric}
            label={
              metric === 'xp'
                ? 'XP per day per family member'
                : 'Chores per day per family member'
            }
          />
        </>
      )}
    </div>
  )
}

// Compact household stats card rendered above the chore list / week
// view so anyone glancing at the chores (including kids) sees their
// current standing. Hidden when there's no completion data yet.
function HouseholdStatsCompact({ householdId }: { householdId: string }) {
  const statsQuery = useQuery({
    queryKey: ['household-stats', householdId, 7],
    queryFn: () =>
      listHouseholdStatsFn({ data: { householdId, days: 7 } }),
  })
  const stats = statsQuery.data
  if (!stats || stats.totalCompletions === 0) return null
  return (
    <HouseholdCompletionBar
      members={stats.members}
      totalCompletions={stats.totalCompletions}
      variant="compact"
      title="This week so far"
    />
  )
}

function LeaderboardTab({ householdId }: { householdId: string }) {
  const [metric, setMetric] = useState<LeaderboardMetric>('xp')
  const [days, setDays] = useState<LeaderboardWindow>(30)

  const query = useQuery({
    queryKey: ['household-leaderboard', householdId, metric, days],
    queryFn: () =>
      getLeaderboardFn({ data: { scope: 'household', metric, days } }),
  })

  const metricLabel: Record<LeaderboardMetric, string> = {
    xp: 'XP earned',
    streak: 'Longest streak',
    'showed-up': 'Days shown up',
  }
  const metricHint: Record<LeaderboardMetric, string> = {
    xp: 'Sum of XP from chore completions in the window.',
    streak: 'Longest run of consecutive days with a completion in the window.',
    'showed-up': 'Distinct days with at least one completion.',
  }
  const ranges: LeaderboardWindow[] = [7, 30, 90, 'all']

  const rows = query.data ?? []

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <p className="text-sm text-[var(--sea-ink-soft)]">
          {metricHint[metric]}
        </p>
        <div
          className="flex gap-1 rounded-full border border-[var(--line)] bg-[var(--option-bg)] p-1"
          role="radiogroup"
          aria-label="Window"
        >
          {ranges.map((r) => (
            <button
              key={String(r)}
              type="button"
              role="radio"
              aria-checked={days === r}
              onClick={() => setDays(r)}
              className={`rounded-full px-3 py-1 text-xs font-semibold transition ${
                days === r
                  ? 'bg-[var(--btn-primary-bg)] text-[var(--btn-primary-fg)]'
                  : 'text-[var(--sea-ink-soft)] hover:text-[var(--sea-ink)]'
              }`}
            >
              {r === 'all' ? 'All' : `${r}d`}
            </button>
          ))}
        </div>
      </div>

      <div
        className="flex flex-wrap gap-1 rounded-full border border-[var(--line)] bg-[var(--option-bg)] p-1"
        role="radiogroup"
        aria-label="Metric"
      >
        {(['xp', 'streak', 'showed-up'] as LeaderboardMetric[]).map((m) => (
          <button
            key={m}
            type="button"
            role="radio"
            aria-checked={metric === m}
            onClick={() => setMetric(m)}
            className={`rounded-full px-3 py-1 text-xs font-semibold transition ${
              metric === m
                ? 'bg-[var(--btn-primary-bg)] text-[var(--btn-primary-fg)]'
                : 'text-[var(--sea-ink-soft)] hover:text-[var(--sea-ink)]'
            }`}
          >
            {metricLabel[m]}
          </button>
        ))}
      </div>

      <section className="island-shell rounded-2xl p-4">
        {query.isLoading ? (
          <p className="text-[var(--sea-ink-soft)]">Loading…</p>
        ) : rows.length === 0 ? (
          <p className="text-sm text-[var(--sea-ink-soft)]">
            No data in this window yet.
          </p>
        ) : (
          <ol className="space-y-2">
            {rows.map((r) => (
              <li key={r.userId}>
                <Link
                  to="/household/$memberId"
                  params={{ memberId: r.userId }}
                  className={`flex items-center justify-between gap-3 rounded-lg border px-3 py-2 no-underline ${
                    r.isMe
                      ? 'border-[var(--lagoon-deep)] bg-[rgba(79,184,178,0.12)]'
                      : 'border-[var(--line)] bg-[var(--option-bg)]'
                  }`}
                >
                  <div className="flex min-w-0 items-center gap-3">
                    <span className="inline-flex h-6 w-6 flex-shrink-0 items-center justify-center rounded-full bg-[var(--surface-strong)] text-xs font-bold text-[var(--sea-ink)]">
                      {r.rank}
                    </span>
                    <span className="min-w-0 flex-1">
                      <span className="block truncate font-semibold text-[var(--sea-ink)]">
                        {r.isMe ? `${r.name} (you)` : r.name}
                      </span>
                      <span className="block text-xs text-[var(--sea-ink-soft)]">
                        @{r.handle}
                      </span>
                    </span>
                  </div>
                  <span className="text-sm font-bold tabular-nums text-[var(--sea-ink)]">
                    {r.value}
                  </span>
                </Link>
              </li>
            ))}
          </ol>
        )}
      </section>
    </div>
  )
}

function ActivityTab({
  householdId,
  members,
}: {
  householdId: string
  members: HouseholdMemberRow[]
}) {
  const [days, setDays] = useState<number>(30)
  const [eventType, setEventType] = useState<
    'all' | 'completions' | 'membership'
  >('all')
  const [memberFilter, setMemberFilter] = useState<string>('all')

  const query = useQuery({
    queryKey: ['household-activity', householdId, days],
    queryFn: () =>
      listHouseholdActivityFn({
        data: { householdId, days, limit: 200 },
      }),
  })

  const allRows = query.data ?? []
  const rows = allRows.filter((r) => {
    if (eventType === 'completions' && r.type !== 'task.completed') return false
    if (
      eventType === 'membership' &&
      r.type !== 'household.member.joined' &&
      r.type !== 'household.member.left'
    ) {
      return false
    }
    if (memberFilter !== 'all' && r.userId !== memberFilter) return false
    return true
  })

  const ranges: number[] = [7, 30, 90]

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-2">
        <div
          className="flex gap-1 rounded-full border border-[var(--line)] bg-[var(--option-bg)] p-1"
          role="radiogroup"
          aria-label="Window"
        >
          {ranges.map((r) => (
            <button
              key={r}
              type="button"
              role="radio"
              aria-checked={days === r}
              onClick={() => setDays(r)}
              className={`rounded-full px-3 py-1 text-xs font-semibold transition ${
                days === r
                  ? 'bg-[var(--btn-primary-bg)] text-[var(--btn-primary-fg)]'
                  : 'text-[var(--sea-ink-soft)] hover:text-[var(--sea-ink)]'
              }`}
            >
              {r}d
            </button>
          ))}
        </div>
        <div
          className="flex gap-1 rounded-full border border-[var(--line)] bg-[var(--option-bg)] p-1"
          role="radiogroup"
          aria-label="Event type"
        >
          {(
            [
              ['all', 'Everything'],
              ['completions', 'Completions'],
              ['membership', 'Joined / left'],
            ] as const
          ).map(([value, label]) => (
            <button
              key={value}
              type="button"
              role="radio"
              aria-checked={eventType === value}
              onClick={() => setEventType(value)}
              className={`rounded-full px-3 py-1 text-xs font-semibold transition ${
                eventType === value
                  ? 'bg-[var(--btn-primary-bg)] text-[var(--btn-primary-fg)]'
                  : 'text-[var(--sea-ink-soft)] hover:text-[var(--sea-ink)]'
              }`}
            >
              {label}
            </button>
          ))}
        </div>
        <label className="flex items-center gap-1 text-xs text-[var(--sea-ink-soft)]">
          <span className="font-semibold uppercase tracking-wide">Who</span>
          <select
            value={memberFilter}
            onChange={(e) => setMemberFilter(e.target.value)}
            className="field-input w-auto rounded-md px-2 py-1 text-xs"
          >
            <option value="all">Anyone</option>
            {members.map((m) => (
              <option key={m.userId} value={m.userId}>
                {m.name}
              </option>
            ))}
          </select>
        </label>
      </div>

      {query.isLoading ? (
        <p className="text-[var(--sea-ink-soft)]">Loading…</p>
      ) : rows.length === 0 ? (
        <section className="island-shell rounded-2xl p-4 text-center text-sm text-[var(--sea-ink-soft)]">
          {allRows.length === 0
            ? `No household activity in the last ${days} days.`
            : 'No activity matches the current filter.'}
        </section>
      ) : (
        <section className="island-shell rounded-2xl p-4">
          <ul className="space-y-2">
            {rows.map((r) => (
              <li
                key={r.eventId}
                className="flex items-start justify-between gap-3 rounded-lg border border-[var(--line)] bg-[var(--option-bg)] px-3 py-2"
              >
                <div className="min-w-0 flex-1">
                  <p className="text-sm text-[var(--sea-ink)]">
                    <ActivityMessage row={r} />
                  </p>
                  <p className="mt-0.5 text-xs text-[var(--sea-ink-soft)]">
                    {new Date(r.occurredAt).toLocaleString()}
                  </p>
                </div>
                {r.type === 'task.completed' && r.xp != null && (
                  <span className="flex-shrink-0 rounded-full border border-[rgba(50,143,151,0.3)] bg-[rgba(79,184,178,0.14)] px-2 py-0.5 text-[10px] font-semibold text-[var(--lagoon-deep)]">
                    +{r.xp} XP
                  </span>
                )}
              </li>
            ))}
          </ul>
        </section>
      )}
    </div>
  )
}

function ActivityMessage({
  row,
}: {
  row: {
    type: 'task.completed' | 'household.member.joined' | 'household.member.left'
    name: string
    taskTitle: string | null
    completedAs: 'personal' | 'assigned' | 'free_for_all' | null
    role: 'admin' | 'member' | 'kid' | 'kiosk' | null
  }
}) {
  const who = <strong>{row.name}</strong>
  if (row.type === 'task.completed') {
    const title = row.taskTitle ?? '(deleted chore)'
    const tag =
      row.completedAs === 'free_for_all'
        ? ' (free-for-all)'
        : row.completedAs === 'assigned'
          ? ''
          : ''
    return (
      <>
        {who} completed <strong>{title}</strong>
        {tag}
      </>
    )
  }
  if (row.type === 'household.member.joined') {
    const role = row.role ?? 'member'
    return (
      <>
        {who} joined as {role === 'admin' ? 'an' : 'a'} {role}
      </>
    )
  }
  return <>{who} left the household</>
}

function MembersTab({
  householdId,
  viewerRole,
  members,
  householdName,
  pendingInvites,
  onInvitesChanged,
}: {
  householdId: string
  viewerRole: 'admin' | 'member' | 'kid' | 'kiosk'
  members: HouseholdMemberRow[]
  householdName: string
  pendingInvites: Array<{
    id: string
    householdName: string
    inviterName: string
    inviterHandle: string
    proposedRole: 'member' | 'kid'
  }>
  onInvitesChanged: () => void
}) {
  const qc = useQueryClient()
  const { data: session } = useSession()
  const viewerUserId = session?.user?.id

  // Invite-side state (was the dedicated Invites tab before).
  const outgoingQuery = useQuery({
    queryKey: ['outgoing-invites'],
    queryFn: () => listOutgoingInvitesFn(),
    enabled: viewerRole === 'admin',
  })
  const friendsQuery = useQuery({
    queryKey: ['friends'],
    queryFn: () => listFriendsFn(),
    enabled: viewerRole === 'admin',
  })
  const [selectedFriend, setSelectedFriend] = useState('')
  const [proposedRole, setProposedRole] = useState<'member' | 'kid'>('member')
  const invite = useMutation({
    mutationFn: (vars: {
      inviteeUserId: string
      proposedRole: 'member' | 'kid'
    }) => inviteMemberFn({ data: vars }),
    onSuccess: () => {
      toast.success('Invite sent.')
      setSelectedFriend('')
      qc.invalidateQueries({ queryKey: ['outgoing-invites'] })
    },
    onError: (err: unknown) => {
      toast.error(err instanceof Error ? err.message : 'Failed to invite.')
    },
  })
  const cancel = useMutation({
    mutationFn: (inviteId: string) =>
      cancelInviteFn({ data: { inviteId } }),
    onSuccess: () => {
      toast.success('Invite cancelled.')
      qc.invalidateQueries({ queryKey: ['outgoing-invites'] })
    },
    onError: (err: unknown) => {
      toast.error(err instanceof Error ? err.message : 'Failed to cancel.')
    },
  })
  const updateColor = useMutation({
    mutationFn: (vars: { targetUserId: string; color: string }) =>
      updateMemberColorFn({ data: vars }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['my-household'] })
      qc.invalidateQueries({ queryKey: ['household-stats', householdId] })
      qc.invalidateQueries({ queryKey: ['household-chores', householdId] })
      qc.invalidateQueries({ queryKey: ['household-chores-week', householdId] })
    },
    onError: (err: unknown) => {
      toast.error(err instanceof Error ? err.message : 'Failed to update color.')
    },
  })
  const remove = useMutation({
    mutationFn: (targetUserId: string) =>
      removeMemberFn({ data: { householdId, targetUserId } }),
    onSuccess: () => {
      toast.success('Member removed.')
      qc.invalidateQueries({ queryKey: ['my-household'] })
    },
    onError: (err: unknown) => {
      toast.error(err instanceof Error ? err.message : 'Failed to remove.')
    },
  })
  const changeRole = useMutation({
    mutationFn: (vars: {
      targetUserId: string
      // Only "person" roles can be set via this path — kiosk accounts
      // are provisioned via createManagedMember and stay kiosk for life.
      role: 'admin' | 'member' | 'kid'
    }) => changeRoleFn({ data: vars }),
    onSuccess: () => {
      toast.success('Role updated.')
      qc.invalidateQueries({ queryKey: ['my-household'] })
    },
    onError: (err: unknown) => {
      toast.error(err instanceof Error ? err.message : 'Failed to update.')
    },
  })
  const leave = useMutation({
    mutationFn: () => leaveHouseholdFn(),
    onSuccess: () => {
      toast.success('Left household.')
      qc.invalidateQueries({ queryKey: ['my-household'] })
    },
    onError: (err: unknown) => {
      toast.error(err instanceof Error ? err.message : 'Failed to leave.')
    },
  })
  const [renaming, setRenaming] = useState(false)
  const [newName, setNewName] = useState(householdName)
  const rename = useMutation({
    mutationFn: (name: string) =>
      renameHouseholdFn({ data: { householdId, name } }),
    onSuccess: () => {
      toast.success('Household renamed.')
      setRenaming(false)
      qc.invalidateQueries({ queryKey: ['my-household'] })
    },
    onError: (err: unknown) => {
      toast.error(err instanceof Error ? err.message : 'Failed to rename.')
    },
  })
  return (
    <div className="space-y-4">
      <section className="island-shell rounded-2xl p-4">
        <ul className="space-y-2">
          {members.map((m) => (
            <li
              key={m.userId}
              className="flex items-center justify-between gap-3 rounded-lg border border-[var(--line)] bg-[var(--option-bg)] px-3 py-2"
            >
              <div className="flex min-w-0 flex-1 items-center gap-3">
                {/* Color swatch + picker. Members can change their
                    own color; admins can change anyone's. */}
                {viewerRole === 'admin' || m.userId === viewerUserId ? (
                  <label className="relative inline-block h-5 w-5 flex-shrink-0 cursor-pointer overflow-hidden rounded-full border border-[var(--line)]">
                    <span
                      aria-hidden
                      className="block h-full w-full"
                      style={{ backgroundColor: m.color ?? '#cccccc' }}
                    />
                    <input
                      type="color"
                      value={m.color ?? '#cccccc'}
                      onChange={(e) =>
                        updateColor.mutate({
                          targetUserId: m.userId,
                          color: e.target.value,
                        })
                      }
                      className="absolute inset-0 h-full w-full cursor-pointer opacity-0"
                      aria-label={`Color for ${m.name}`}
                    />
                  </label>
                ) : (
                  <span
                    aria-hidden
                    className="inline-block h-5 w-5 flex-shrink-0 rounded-full border border-[var(--line)]"
                    style={{ backgroundColor: m.color ?? '#cccccc' }}
                  />
                )}
                <Link
                  to="/household/$memberId"
                  params={{ memberId: m.userId }}
                  className="min-w-0 flex-1 no-underline"
                >
                  <div className="truncate font-medium text-[var(--sea-ink)]">
                    {m.name}
                  </div>
                  <div className="text-xs text-[var(--sea-ink-soft)]">
                    @{m.handle} · {m.role}
                  </div>
                </Link>
              </div>
              {viewerRole === 'admin' && (
                <div className="flex flex-wrap items-center gap-2">
                  {m.role === 'kiosk' ? (
                    // Kiosk role is provisioned, not changed.
                    <span className="rounded-full border border-[var(--line)] bg-[var(--option-bg)] px-2 py-1 text-[10px] font-semibold uppercase tracking-wide text-[var(--sea-ink-soft)]">
                      kiosk
                    </span>
                  ) : (
                    <select
                      value={m.role}
                      onChange={(e) =>
                        changeRole.mutate({
                          targetUserId: m.userId,
                          role: e.target.value as 'admin' | 'member' | 'kid',
                        })
                      }
                      className="field-input w-auto rounded-md px-2 py-1 text-xs"
                    >
                      <option value="admin">admin</option>
                      <option value="member">member</option>
                      <option value="kid">kid</option>
                    </select>
                  )}
                  {(m.role === 'kid' || m.role === 'kiosk') && (
                    <ResetPasswordButton
                      targetUserId={m.userId}
                      targetName={m.name}
                    />
                  )}
                  <button
                    type="button"
                    onClick={() => {
                      if (confirm(`Remove ${m.name}?`)) {
                        remove.mutate(m.userId)
                      }
                    }}
                    className="rounded-md border border-[var(--line)] px-2 py-1 text-xs text-[var(--sea-ink-soft)] hover:text-[var(--sea-ink)]"
                  >
                    Remove
                  </button>
                </div>
              )}
            </li>
          ))}
        </ul>
      </section>

      {viewerRole === 'admin' && (
        <section className="island-shell rounded-2xl p-4">
          <h3 className="text-sm font-semibold text-[var(--sea-ink)]">
            Household settings
          </h3>
          {renaming ? (
            <form
              onSubmit={(e) => {
                e.preventDefault()
                if (!newName.trim()) return
                rename.mutate(newName.trim())
              }}
              className="mt-3 flex gap-2"
            >
              <input
                type="text"
                value={newName}
                onChange={(e) => setNewName(e.target.value)}
                maxLength={80}
                className="field-input flex-1 rounded-lg px-3 py-2 text-sm"
              />
              <button
                type="submit"
                className="rounded-lg bg-[var(--btn-primary-bg)] px-3 py-1.5 text-xs font-semibold text-[var(--btn-primary-fg)]"
              >
                Save
              </button>
              <button
                type="button"
                onClick={() => {
                  setRenaming(false)
                  setNewName(householdName)
                }}
                className="rounded-lg border border-[var(--line)] px-3 py-1.5 text-xs"
              >
                Cancel
              </button>
            </form>
          ) : (
            <div className="mt-3 flex flex-wrap gap-2">
              <button
                type="button"
                onClick={() => setRenaming(true)}
                className="rounded-md border border-[var(--line)] px-3 py-1.5 text-xs"
              >
                Rename
              </button>
              <p className="text-xs text-[var(--sea-ink-soft)]">
                To delete the household, go to{' '}
                <Link to="/settings" className="underline">
                  Settings → Household
                </Link>
                .
              </p>
            </div>
          )}
        </section>
      )}

      {viewerRole === 'admin' && <AddManagedMemberCard />}

      {pendingInvites.length > 0 && (
        <section className="island-shell rounded-2xl p-4">
          <h2 className="text-sm font-semibold text-[var(--sea-ink)]">
            Pending invites for you
          </h2>
          <ul className="mt-3 space-y-2">
            {pendingInvites.map((inv) => (
              <InviteRow
                key={inv.id}
                inviteId={inv.id}
                householdName={inv.householdName}
                inviterName={inv.inviterName}
                inviterHandle={inv.inviterHandle}
                proposedRole={inv.proposedRole}
                onChanged={onInvitesChanged}
              />
            ))}
          </ul>
        </section>
      )}

      {viewerRole === 'admin' && (
        <section className="island-shell rounded-2xl p-4">
          <h2 className="text-sm font-semibold text-[var(--sea-ink)]">
            Invite a friend
          </h2>
          <p className="mt-1 text-xs text-[var(--sea-ink-soft)]">
            You can only invite people you&rsquo;re already friends with.
          </p>
          {friendsQuery.data && friendsQuery.data.length === 0 ? (
            <p className="mt-3 text-sm text-[var(--sea-ink-soft)]">
              No friends yet. Add some from the friends page first.
            </p>
          ) : (
            <form
              onSubmit={(e) => {
                e.preventDefault()
                if (!selectedFriend) return
                invite.mutate({ inviteeUserId: selectedFriend, proposedRole })
              }}
              className="mt-3 flex flex-wrap gap-2"
            >
              <select
                value={selectedFriend}
                onChange={(e) => setSelectedFriend(e.target.value)}
                className="field-input flex-1 rounded-lg px-3 py-2 text-sm"
              >
                <option value="">Select a friend…</option>
                {(friendsQuery.data ?? []).map((f) => (
                  <option key={f.userId} value={f.userId}>
                    {f.name} (@{f.handle})
                  </option>
                ))}
              </select>
              <select
                value={proposedRole}
                onChange={(e) =>
                  setProposedRole(e.target.value as 'member' | 'kid')
                }
                className="field-input w-auto rounded-lg px-3 py-2 text-sm"
              >
                <option value="member">member</option>
                <option value="kid">kid</option>
              </select>
              <button
                type="submit"
                disabled={invite.isPending || !selectedFriend}
                className="rounded-full border border-[rgba(50,143,151,0.3)] bg-[rgba(79,184,178,0.14)] px-4 py-2 text-sm font-semibold text-[var(--lagoon-deep)] disabled:opacity-50"
              >
                Invite
              </button>
            </form>
          )}

          {(outgoingQuery.data ?? []).length > 0 && (
            <div className="mt-4">
              <h3 className="text-xs font-semibold uppercase tracking-wide text-[var(--sea-ink-soft)]">
                Outgoing
              </h3>
              <ul className="mt-2 space-y-1">
                {(outgoingQuery.data ?? []).map((o) => (
                  <li
                    key={o.id}
                    className="flex items-center justify-between rounded-md border border-[var(--line)] px-3 py-2 text-sm"
                  >
                    <span className="truncate">
                      {o.inviteeName} (@{o.inviteeHandle}) ·{' '}
                      <span className="text-xs text-[var(--sea-ink-soft)]">
                        {o.proposedRole}
                      </span>
                    </span>
                    <button
                      type="button"
                      onClick={() => cancel.mutate(o.id)}
                      className="text-xs text-[var(--sea-ink-soft)] underline"
                    >
                      Cancel
                    </button>
                  </li>
                ))}
              </ul>
            </div>
          )}
        </section>
      )}

      <section className="island-shell rounded-2xl p-4">
        <button
          type="button"
          onClick={() => {
            if (confirm('Leave this household?')) leave.mutate()
          }}
          className="rounded-md border border-[var(--line)] px-3 py-1.5 text-xs text-[var(--sea-ink-soft)] hover:text-[var(--sea-ink)]"
        >
          Leave household
        </button>
      </section>
    </div>
  )
}


function generateTempPassword(): string {
  // Easy-to-read 10-char password for handoff. Skip ambiguous chars
  // (0/O, 1/l/I) and split with a dash so admins can read it aloud
  // without confusion. Crypto-strong via crypto.getRandomValues.
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'
  const bytes = new Uint8Array(10)
  if (typeof crypto !== 'undefined' && crypto.getRandomValues) {
    crypto.getRandomValues(bytes)
  } else {
    for (let i = 0; i < bytes.length; i++) {
      bytes[i] = Math.floor(Math.random() * 256)
    }
  }
  let out = ''
  for (let i = 0; i < bytes.length; i++) {
    out += alphabet[bytes[i] % alphabet.length]
    if (i === 4) out += '-'
  }
  return out
}

function AddManagedMemberCard() {
  const qc = useQueryClient()
  const [showForm, setShowForm] = useState(false)
  const [role, setRole] = useState<'kid' | 'kiosk'>('kid')
  const [name, setName] = useState('')
  const [handle, setHandle] = useState('')
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState(() => generateTempPassword())
  const [credentials, setCredentials] = useState<{
    name: string
    handle: string
    email: string
    password: string
    role: 'kid' | 'kiosk'
  } | null>(null)

  function reset() {
    setName('')
    setHandle('')
    setEmail('')
    setPassword(generateTempPassword())
  }

  const create = useMutation({
    mutationFn: (vars: {
      name: string
      handle: string
      password: string
      email?: string | null
      role: 'kid' | 'kiosk'
    }) => createManagedMemberFn({ data: vars }),
    onSuccess: (res) => {
      // Hand the credentials to the admin. They're never shown again
      // through the UI — the admin needs to write them down or relay.
      setCredentials({
        name: res.name,
        handle: res.handle,
        email: res.email,
        password,
        role: res.role,
      })
      reset()
      setShowForm(false)
      qc.invalidateQueries({ queryKey: ['my-household'] })
    },
    onError: (err: unknown) => {
      toast.error(err instanceof Error ? err.message : 'Failed to create.')
    },
  })

  return (
    <section className="island-shell rounded-2xl p-4">
      <div className="flex items-baseline justify-between gap-3">
        <div>
          <h2 className="text-sm font-semibold text-[var(--sea-ink)]">
            Add a household account
          </h2>
          <p className="mt-1 text-xs text-[var(--sea-ink-soft)]">
            Provision a kid or shared kiosk login directly — no friend
            request, no email signup. You&rsquo;ll get the credentials to
            hand to the family.
          </p>
        </div>
        {!showForm && (
          <button
            type="button"
            onClick={() => {
              setShowForm(true)
              reset()
            }}
            className="flex-shrink-0 rounded-full border border-[rgba(50,143,151,0.3)] bg-[rgba(79,184,178,0.14)] px-3 py-1.5 text-xs font-semibold text-[var(--lagoon-deep)]"
          >
            + Add
          </button>
        )}
      </div>

      {showForm && (
        <form
          onSubmit={(e) => {
            e.preventDefault()
            create.mutate({
              name: name.trim(),
              handle: handle.trim(),
              password,
              email: email.trim() || null,
              role,
            })
          }}
          className="mt-4 space-y-3"
        >
          <div
            className="flex gap-1 rounded-full border border-[var(--line)] bg-[var(--option-bg)] p-1"
            role="radiogroup"
            aria-label="Role"
          >
            {(['kid', 'kiosk'] as const).map((r) => (
              <button
                key={r}
                type="button"
                role="radio"
                aria-checked={role === r}
                onClick={() => setRole(r)}
                className={`rounded-full px-3 py-1 text-xs font-semibold transition ${
                  role === r
                    ? 'bg-[var(--btn-primary-bg)] text-[var(--btn-primary-fg)]'
                    : 'text-[var(--sea-ink-soft)] hover:text-[var(--sea-ink)]'
                }`}
              >
                {r === 'kid' ? 'Kid account' : 'Family kiosk'}
              </button>
            ))}
          </div>
          <label className="block">
            <span className="mb-1 block text-xs font-semibold uppercase tracking-wide text-[var(--kicker)]">
              {role === 'kiosk' ? 'Kiosk display name' : 'Name'}
            </span>
            <input
              type="text"
              required
              maxLength={80}
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder={role === 'kiosk' ? 'Kitchen iPad' : 'Junior'}
              className="field-input"
            />
          </label>
          <label className="block">
            <span className="mb-1 block text-xs font-semibold uppercase tracking-wide text-[var(--kicker)]">
              Handle
            </span>
            <input
              type="text"
              required
              minLength={3}
              maxLength={20}
              value={handle}
              onChange={(e) =>
                setHandle(e.target.value.toLowerCase().replace(/[^a-z0-9_]/g, ''))
              }
              placeholder={role === 'kiosk' ? 'kitchen' : 'junior'}
              className="field-input"
            />
            <span className="mt-1 block text-[10px] text-[var(--sea-ink-soft)]">
              Lowercase letters / numbers / underscore. 3–20 chars. Used
              to log in instead of email.
            </span>
          </label>
          <label className="block">
            <span className="mb-1 block text-xs font-semibold uppercase tracking-wide text-[var(--kicker)]">
              Email (optional)
            </span>
            <input
              type="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              placeholder="parent@example.com — for password recovery"
              className="field-input"
            />
            <span className="mt-1 block text-[10px] text-[var(--sea-ink-soft)]">
              Optional. Leave blank to skip email; the account uses a
              placeholder address and you can reset the password from
              this page.
            </span>
          </label>
          <label className="block">
            <span className="mb-1 block text-xs font-semibold uppercase tracking-wide text-[var(--kicker)]">
              Password
            </span>
            <div className="flex gap-2">
              <input
                type="text"
                required
                minLength={8}
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                className="field-input flex-1 font-mono"
              />
              <button
                type="button"
                onClick={() => setPassword(generateTempPassword())}
                className="rounded-md border border-[var(--line)] px-3 py-1 text-xs text-[var(--sea-ink-soft)] hover:text-[var(--sea-ink)]"
              >
                Regenerate
              </button>
            </div>
            <span className="mt-1 block text-[10px] text-[var(--sea-ink-soft)]">
              Share this with the family member. You can reset it later.
            </span>
          </label>
          <div className="flex justify-end gap-2">
            <button
              type="button"
              onClick={() => setShowForm(false)}
              className="rounded-full border border-[var(--line)] px-3 py-1.5 text-xs font-semibold text-[var(--sea-ink-soft)]"
            >
              Cancel
            </button>
            <button
              type="submit"
              disabled={
                create.isPending ||
                !name.trim() ||
                handle.length < 3 ||
                password.length < 8
              }
              className="rounded-full border border-[rgba(50,143,151,0.3)] bg-[rgba(79,184,178,0.14)] px-4 py-1.5 text-xs font-semibold text-[var(--lagoon-deep)] disabled:opacity-50"
            >
              {create.isPending ? 'Creating…' : 'Create account'}
            </button>
          </div>
        </form>
      )}

      <CredentialsDialog
        creds={credentials}
        onClose={() => setCredentials(null)}
      />
    </section>
  )
}

function CredentialsDialog({
  creds,
  onClose,
}: {
  creds: {
    name: string
    handle: string
    email: string
    password: string
    role: 'kid' | 'kiosk'
  } | null
  onClose: () => void
}) {
  const dialogRef = useRef<HTMLDialogElement | null>(null)
  useEffect(() => {
    const el = dialogRef.current
    if (!el) return
    if (creds && !el.open) el.showModal()
    else if (!creds && el.open) el.close()
  }, [creds])

  return (
    <dialog
      ref={dialogRef}
      onClose={onClose}
      onClick={(e) => {
        if (e.target === dialogRef.current) onClose()
      }}
      className="m-auto w-[min(480px,calc(100%-1.5rem))] rounded-2xl border border-[var(--line)] bg-[var(--surface)] p-0 text-[var(--sea-ink)] shadow-2xl backdrop:bg-black/40 backdrop:backdrop-blur-sm"
    >
      {creds ? (
        <div className="flex flex-col gap-4 p-5">
          <div>
            <h3 className="display-title text-lg font-bold text-[var(--sea-ink)]">
              Account created
            </h3>
            <p className="mt-1 text-sm text-[var(--sea-ink-soft)]">
              Write these down — the password isn&rsquo;t shown again.
              You can reset it from the Members list if needed.
            </p>
          </div>
          <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-2 rounded-xl border border-[var(--line)] bg-[var(--option-bg)] p-3 text-sm">
            <dt className="font-semibold text-[var(--sea-ink-soft)]">Name</dt>
            <dd className="text-[var(--sea-ink)]">{creds.name}</dd>
            <dt className="font-semibold text-[var(--sea-ink-soft)]">Login</dt>
            <dd className="font-mono text-[var(--sea-ink)]">
              @{creds.handle}
            </dd>
            <dt className="font-semibold text-[var(--sea-ink-soft)]">Email</dt>
            <dd className="break-all text-[var(--sea-ink)]">{creds.email}</dd>
            <dt className="font-semibold text-[var(--sea-ink-soft)]">Password</dt>
            <dd className="font-mono text-[var(--sea-ink)]">{creds.password}</dd>
            <dt className="font-semibold text-[var(--sea-ink-soft)]">Role</dt>
            <dd className="text-[var(--sea-ink)]">{creds.role}</dd>
          </dl>
          <div className="flex justify-end gap-2">
            <button
              type="button"
              onClick={() => {
                const text = `Login: @${creds.handle}\nPassword: ${creds.password}`
                if (navigator.clipboard) {
                  navigator.clipboard.writeText(text)
                  toast.success('Copied login + password.')
                }
              }}
              className="rounded-full border border-[var(--line)] px-3 py-1.5 text-xs font-semibold text-[var(--sea-ink-soft)]"
            >
              Copy login + password
            </button>
            <button
              type="button"
              onClick={onClose}
              className="rounded-full border border-[rgba(50,143,151,0.3)] bg-[rgba(79,184,178,0.14)] px-3 py-1.5 text-xs font-semibold text-[var(--lagoon-deep)]"
            >
              Done
            </button>
          </div>
        </div>
      ) : null}
    </dialog>
  )
}

function ResetPasswordButton({
  targetUserId,
  targetName,
}: {
  targetUserId: string
  targetName: string
}) {
  const [revealed, setRevealed] = useState<string | null>(null)
  const reset = useMutation({
    mutationFn: (newPassword: string) =>
      resetManagedMemberPasswordFn({
        data: { targetUserId, newPassword },
      }),
    onSuccess: (_, newPassword) => {
      setRevealed(newPassword)
    },
    onError: (err: unknown) =>
      toast.error(err instanceof Error ? err.message : 'Reset failed.'),
  })
  return (
    <>
      <button
        type="button"
        onClick={() => {
          if (
            !confirm(
              `Reset password for ${targetName}? You'll get a new one to hand over.`,
            )
          )
            return
          reset.mutate(generateTempPassword())
        }}
        disabled={reset.isPending}
        className="rounded-md border border-[var(--line)] px-2 py-1 text-xs text-[var(--sea-ink-soft)] hover:text-[var(--sea-ink)] disabled:opacity-50"
      >
        {reset.isPending ? 'Resetting…' : 'Reset pw'}
      </button>
      {revealed && (
        <PasswordRevealDialog
          name={targetName}
          password={revealed}
          onClose={() => setRevealed(null)}
        />
      )}
    </>
  )
}

function PasswordRevealDialog({
  name,
  password,
  onClose,
}: {
  name: string
  password: string
  onClose: () => void
}) {
  const dialogRef = useRef<HTMLDialogElement | null>(null)
  useEffect(() => {
    const el = dialogRef.current
    if (!el) return
    if (!el.open) el.showModal()
  }, [])

  return (
    <dialog
      ref={dialogRef}
      onClose={onClose}
      onClick={(e) => {
        if (e.target === dialogRef.current) onClose()
      }}
      className="m-auto w-[min(420px,calc(100%-1.5rem))] rounded-2xl border border-[var(--line)] bg-[var(--surface)] p-0 text-[var(--sea-ink)] shadow-2xl backdrop:bg-black/40 backdrop:backdrop-blur-sm"
    >
      <div className="flex flex-col gap-4 p-5">
        <div>
          <h3 className="display-title text-lg font-bold text-[var(--sea-ink)]">
            New password for {name}
          </h3>
          <p className="mt-1 text-sm text-[var(--sea-ink-soft)]">
            Hand this over — it won&rsquo;t be shown again.
          </p>
        </div>
        <p className="rounded-xl border border-[var(--line)] bg-[var(--option-bg)] p-3 text-center font-mono text-lg">
          {password}
        </p>
        <div className="flex justify-end gap-2">
          <button
            type="button"
            onClick={() => {
              if (navigator.clipboard) {
                navigator.clipboard.writeText(password)
                toast.success('Copied.')
              }
            }}
            className="rounded-full border border-[var(--line)] px-3 py-1.5 text-xs font-semibold text-[var(--sea-ink-soft)]"
          >
            Copy
          </button>
          <button
            type="button"
            onClick={onClose}
            className="rounded-full border border-[rgba(50,143,151,0.3)] bg-[rgba(79,184,178,0.14)] px-3 py-1.5 text-xs font-semibold text-[var(--lagoon-deep)]"
          >
            Done
          </button>
        </div>
      </div>
    </dialog>
  )
}

function InviteRow({
  inviteId,
  householdName,
  inviterName,
  inviterHandle,
  proposedRole,
  onChanged,
}: {
  inviteId: string
  householdName: string
  inviterName: string
  inviterHandle: string
  proposedRole: 'member' | 'kid'
  onChanged: () => void
}) {
  const accept = useMutation({
    mutationFn: () => acceptInviteFn({ data: { inviteId } }),
    onSuccess: () => {
      toast.success(`Joined ${householdName}.`)
      onChanged()
    },
    onError: (err: unknown) => {
      toast.error(err instanceof Error ? err.message : 'Failed to accept.')
    },
  })
  const decline = useMutation({
    mutationFn: () => declineInviteFn({ data: { inviteId } }),
    onSuccess: () => {
      toast.message('Invite declined.')
      onChanged()
    },
  })
  return (
    <li className="flex items-center justify-between gap-3 rounded-lg border border-[var(--line)] bg-[var(--option-bg)] px-3 py-2">
      <div className="min-w-0 flex-1">
        <div className="truncate font-medium text-[var(--sea-ink)]">
          {householdName}
        </div>
        <div className="text-xs text-[var(--sea-ink-soft)]">
          From {inviterName} (@{inviterHandle}) · as {proposedRole}
        </div>
      </div>
      <div className="flex gap-2">
        <button
          type="button"
          onClick={() => accept.mutate()}
          disabled={accept.isPending}
          className="rounded-lg bg-[var(--btn-primary-bg)] px-3 py-1.5 text-xs font-semibold text-[var(--btn-primary-fg)] disabled:opacity-50"
        >
          Accept
        </button>
        <button
          type="button"
          onClick={() => decline.mutate()}
          disabled={decline.isPending}
          className="rounded-lg border border-[var(--line)] px-3 py-1.5 text-xs"
        >
          Decline
        </button>
      </div>
    </li>
  )
}
