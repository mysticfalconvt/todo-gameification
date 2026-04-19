import { useState } from 'react'
import { createFileRoute, Link } from '@tanstack/react-router'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { toast } from 'sonner'
import { getLeaderboardFn } from '../../server/functions/leaderboard'
import {
  cheerCompletionFn,
  getFriendActivityFn,
  getReceivedCheersFn,
} from '../../server/functions/activity'
import { getFriendsCategoryHistogramsFn } from '../../server/functions/categoryStats'
import { CategoryHistogramView } from '../../components/CategoryHistogramView'
import type {
  LeaderboardMetric,
  LeaderboardScope,
  LeaderboardWindow,
} from '../../server/services/leaderboard'
import type { CategoryScope } from '../../server/services/categoryStats'

export const Route = createFileRoute('/_authenticated/friends')({
  component: FriendsPage,
})

type Tab = 'leaderboard' | 'activity' | 'categories'

const METRIC_LABEL: Record<LeaderboardMetric, string> = {
  xp: 'XP earned',
  streak: 'Longest streak',
  'showed-up': 'Days shown up',
}

const METRIC_HINT: Record<LeaderboardMetric, string> = {
  xp: 'Sum of XP from completed tasks in the window.',
  streak: 'Longest run of consecutive days with a completion, in the window.',
  'showed-up': 'Distinct days with at least one completion.',
}

function FriendsPage() {
  const [tab, setTab] = useState<Tab>('leaderboard')

  return (
    <main className="page-wrap space-y-6 px-4 py-8">
      <header>
        <p className="island-kicker mb-1">Friends</p>
        <h1 className="display-title text-4xl font-bold text-[var(--sea-ink)]">
          {tab === 'leaderboard'
            ? 'Leaderboard'
            : tab === 'activity'
              ? 'Activity'
              : 'Categories'}
        </h1>
      </header>
      <div
        className="flex gap-1 rounded-full border border-[var(--line)] bg-[var(--option-bg)] p-1"
        role="tablist"
        aria-label="Friends tabs"
      >
        {(['leaderboard', 'activity', 'categories'] as Tab[]).map((t) => (
          <button
            key={t}
            type="button"
            role="tab"
            aria-selected={tab === t}
            onClick={() => setTab(t)}
            className={`rounded-full px-4 py-1.5 text-xs font-semibold capitalize transition ${
              tab === t
                ? 'bg-[var(--btn-primary-bg)] text-[var(--btn-primary-fg)]'
                : 'text-[var(--sea-ink-soft)] hover:text-[var(--sea-ink)]'
            }`}
          >
            {t}
          </button>
        ))}
      </div>
      {tab === 'leaderboard' ? (
        <LeaderboardTab />
      ) : tab === 'activity' ? (
        <ActivityTab />
      ) : (
        <CategoriesTab />
      )}
    </main>
  )
}

function CategoriesTab() {
  const [scope, setScope] = useState<CategoryScope>('active')
  const query = useQuery({
    queryKey: ['friends-categories', scope],
    queryFn: () => getFriendsCategoryHistogramsFn({ data: { scope } }),
  })
  const rows = Array.isArray(query.data) ? query.data : []

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <p className="text-sm text-[var(--sea-ink-soft)]">
          {scope === 'active'
            ? 'Active tasks grouped by category.'
            : 'Tasks completed in the last 30 days, by category.'}
        </p>
        <div
          className="flex gap-1 rounded-full border border-[var(--line)] bg-[var(--option-bg)] p-1"
          role="radiogroup"
          aria-label="Scope"
        >
          {(['active', 'completed'] as CategoryScope[]).map((s) => (
            <button
              key={s}
              type="button"
              role="radio"
              aria-checked={scope === s}
              onClick={() => setScope(s)}
              className={`rounded-full px-3 py-1 text-xs font-semibold transition ${
                scope === s
                  ? 'bg-[var(--btn-primary-bg)] text-[var(--btn-primary-fg)]'
                  : 'text-[var(--sea-ink-soft)] hover:text-[var(--sea-ink)]'
              }`}
            >
              {s === 'active' ? 'Active' : 'Completed (30d)'}
            </button>
          ))}
        </div>
      </div>

      {query.isLoading ? (
        <p className="text-[var(--sea-ink-soft)]">Loading…</p>
      ) : rows.length <= 1 ? (
        <p className="text-sm text-[var(--sea-ink-soft)]">
          Add some friends to compare category breakdowns.
        </p>
      ) : (
        <div className="space-y-3">
          {rows.map((r) => (
            <section
              key={r.userId}
              className={`rounded-2xl border p-4 ${
                r.isMe
                  ? 'border-[var(--lagoon-deep)] bg-[rgba(79,184,178,0.08)]'
                  : 'border-[var(--line)] bg-[var(--option-bg)]'
              }`}
            >
              <header className="mb-3 flex items-center gap-3">
                <Initials name={r.name ?? '?'} />
                <div className="min-w-0 flex-1">
                  {r.isMe ? (
                    <p className="truncate text-sm font-semibold text-[var(--sea-ink)]">
                      You
                    </p>
                  ) : (
                    <Link
                      to="/u/$handle"
                      params={{ handle: r.handle ?? '' }}
                      className="truncate text-sm font-semibold text-[var(--sea-ink)] no-underline"
                    >
                      {r.name}
                    </Link>
                  )}
                  <p className="truncate text-xs text-[var(--sea-ink-soft)]">
                    {r.handle ? `@${r.handle}` : ''}
                    {r.shared ? ` · ${r.total} total` : ''}
                  </p>
                </div>
              </header>
              {!r.canView ? (
                <p className="py-4 text-center text-xs text-[var(--sea-ink-soft)]">
                  Profile not visible.
                </p>
              ) : !r.shared ? (
                <p className="py-4 text-center text-xs text-[var(--sea-ink-soft)]">
                  Activity sharing is off.
                </p>
              ) : r.bars.length === 0 ? (
                <p className="py-4 text-center text-xs text-[var(--sea-ink-soft)]">
                  No tasks in this scope.
                </p>
              ) : (
                <CategoryHistogramView bars={r.bars} compact />
              )}
            </section>
          ))}
        </div>
      )}
    </div>
  )
}

function LeaderboardTab() {
  const [scope, setScope] = useState<LeaderboardScope>('friends')
  const [metric, setMetric] = useState<LeaderboardMetric>('xp')
  const [days, setDays] = useState<LeaderboardWindow>(30)

  const query = useQuery({
    queryKey: ['leaderboard', scope, metric, days],
    queryFn: () => getLeaderboardFn({ data: { scope, metric, days } }),
  })

  const rows = Array.isArray(query.data) ? query.data : []

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <p className="text-sm text-[var(--sea-ink-soft)]">
          {METRIC_HINT[metric]}
        </p>
        <div
          className="flex gap-1 rounded-full border border-[var(--line)] bg-[var(--option-bg)] p-1"
          role="radiogroup"
          aria-label="Window"
        >
          {([7, 30, 90, 'all'] as LeaderboardWindow[]).map((r) => (
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

      <div className="flex flex-wrap items-center justify-between gap-3">
        <div
          className="flex gap-1 rounded-full border border-[var(--line)] bg-[var(--option-bg)] p-1"
          role="radiogroup"
          aria-label="Scope"
        >
          {(['friends', 'global'] as LeaderboardScope[]).map((s) => (
            <button
              key={s}
              type="button"
              role="radio"
              aria-checked={scope === s}
              onClick={() => setScope(s)}
              className={`rounded-full px-3 py-1 text-xs font-semibold capitalize transition ${
                scope === s
                  ? 'bg-[var(--btn-primary-bg)] text-[var(--btn-primary-fg)]'
                  : 'text-[var(--sea-ink-soft)] hover:text-[var(--sea-ink)]'
              }`}
            >
              {s}
            </button>
          ))}
        </div>

        <div
          className="flex gap-1 rounded-full border border-[var(--line)] bg-[var(--option-bg)] p-1"
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
              {METRIC_LABEL[m]}
            </button>
          ))}
        </div>
      </div>

      <section className="island-shell rounded-2xl p-4">
        {query.isLoading ? (
          <p className="text-[var(--sea-ink-soft)]">Loading…</p>
        ) : rows.length === 0 ? (
          <p className="text-sm text-[var(--sea-ink-soft)]">
            {scope === 'friends'
              ? 'No friends yet. Add some from settings.'
              : 'No one on the global leaderboard yet.'}
          </p>
        ) : (
          <ol className="space-y-2">
            {rows.map((r) => (
              <li
                key={r.userId}
                className={`rounded-xl border ${
                  r.isMe
                    ? 'border-[var(--lagoon-deep)] bg-[rgba(79,184,178,0.1)]'
                    : 'border-[var(--line)] bg-[var(--option-bg)]'
                }`}
              >
                <Link
                  to="/u/$handle"
                  params={{ handle: r.handle }}
                  className="flex items-center gap-3 rounded-xl p-3 no-underline"
                >
                  <span className="flex h-7 w-7 flex-shrink-0 items-center justify-center rounded-full bg-[var(--btn-primary-bg)] text-xs font-bold text-[var(--btn-primary-fg)]">
                    {r.rank}
                  </span>
                  <Initials name={r.name} />
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-sm font-semibold text-[var(--sea-ink)]">
                      {r.name}
                      {r.isMe ? (
                        <span className="ml-2 text-xs font-normal text-[var(--sea-ink-soft)]">
                          (you)
                        </span>
                      ) : null}
                    </p>
                    <p className="truncate text-xs text-[var(--sea-ink-soft)]">
                      @{r.handle}
                    </p>
                  </div>
                  <span className="text-sm font-semibold text-[var(--sea-ink)]">
                    {formatMetric(metric, r.value)}
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

type ActivitySub = 'friends' | 'received'

function ActivityTab() {
  const [sub, setSub] = useState<ActivitySub>('friends')
  return (
    <div className="space-y-4">
      <div
        className="flex gap-1 rounded-full border border-[var(--line)] bg-[var(--option-bg)] p-1"
        role="tablist"
        aria-label="Activity tabs"
      >
        <button
          type="button"
          role="tab"
          aria-selected={sub === 'friends'}
          onClick={() => setSub('friends')}
          className={`rounded-full px-3 py-1 text-xs font-semibold transition ${
            sub === 'friends'
              ? 'bg-[var(--btn-primary-bg)] text-[var(--btn-primary-fg)]'
              : 'text-[var(--sea-ink-soft)] hover:text-[var(--sea-ink)]'
          }`}
        >
          Friends
        </button>
        <button
          type="button"
          role="tab"
          aria-selected={sub === 'received'}
          onClick={() => setSub('received')}
          className={`rounded-full px-3 py-1 text-xs font-semibold transition ${
            sub === 'received'
              ? 'bg-[var(--btn-primary-bg)] text-[var(--btn-primary-fg)]'
              : 'text-[var(--sea-ink-soft)] hover:text-[var(--sea-ink)]'
          }`}
        >
          Cheers for you
        </button>
      </div>
      {sub === 'friends' ? <FriendsActivity /> : <ReceivedCheers />}
    </div>
  )
}

function FriendsActivity() {
  const qc = useQueryClient()
  const [days, setDays] = useState<7 | 30>(7)

  const query = useQuery({
    queryKey: ['activity', days],
    queryFn: () => getFriendActivityFn({ data: { days } }),
  })

  const cheer = useMutation({
    mutationFn: (completionEventId: string) =>
      cheerCompletionFn({ data: { completionEventId } }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['activity'] }),
    onError: (err) =>
      toast.error(err instanceof Error ? err.message : 'Cheer failed'),
  })

  const rows = Array.isArray(query.data) ? query.data : []

  return (
    <div className="space-y-4">
      <div
        className="flex gap-1 rounded-full border border-[var(--line)] bg-[var(--option-bg)] p-1"
        role="radiogroup"
        aria-label="Window"
      >
        {([7, 30] as const).map((d) => (
          <button
            key={d}
            type="button"
            role="radio"
            aria-checked={days === d}
            onClick={() => setDays(d)}
            className={`rounded-full px-3 py-1 text-xs font-semibold transition ${
              days === d
                ? 'bg-[var(--btn-primary-bg)] text-[var(--btn-primary-fg)]'
                : 'text-[var(--sea-ink-soft)] hover:text-[var(--sea-ink)]'
            }`}
          >
            {d}d
          </button>
        ))}
      </div>

      {query.isLoading ? (
        <p className="text-[var(--sea-ink-soft)]">Loading…</p>
      ) : rows.length === 0 ? (
        <p className="text-sm text-[var(--sea-ink-soft)]">
          Nothing from friends yet. When they finish a task, you’ll see it
          here.
        </p>
      ) : (
        <ul className="space-y-2">
          {rows.map((r) => (
            <li
              key={r.eventId}
              className="flex items-center gap-3 rounded-xl border border-[var(--line)] bg-[var(--option-bg)] p-3"
            >
              <Initials name={r.name} />
              <div className="min-w-0 flex-1">
                <p className="truncate text-sm text-[var(--sea-ink)]">
                  <span className="font-semibold">{r.name}</span>
                  <span className="text-[var(--sea-ink-soft)]">
                    {' '}
                    {r.taskTitle
                      ? 'finished '
                      : 'completed a task'}
                  </span>
                  {r.taskTitle ? (
                    <span className="font-semibold">“{r.taskTitle}”</span>
                  ) : null}
                </p>
                <p className="truncate text-xs text-[var(--sea-ink-soft)]">
                  @{r.handle} · {relativeTime(r.occurredAt)} · {r.xp} XP
                </p>
              </div>
              <button
                type="button"
                onClick={() => cheer.mutate(r.eventId)}
                disabled={r.viewerCheered || cheer.isPending}
                className={`flex items-center gap-1 rounded-full border px-3 py-1 text-xs font-semibold transition ${
                  r.viewerCheered
                    ? 'border-[var(--lagoon-deep)] bg-[rgba(79,184,178,0.2)] text-[var(--lagoon-deep)]'
                    : 'border-[var(--line)] bg-[var(--option-bg)] text-[var(--sea-ink-soft)] hover:text-[var(--sea-ink)]'
                } disabled:opacity-60`}
                aria-label="Cheer"
              >
                <span>{r.viewerCheered ? 'Cheered' : 'Cheer'}</span>
                {r.cheerCount > 0 ? <span>· {r.cheerCount}</span> : null}
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}

function ReceivedCheers() {
  const [days, setDays] = useState<7 | 30 | 90>(30)
  const query = useQuery({
    queryKey: ['cheers-received', days],
    queryFn: () => getReceivedCheersFn({ data: { days } }),
  })
  const rows = Array.isArray(query.data) ? query.data : []

  return (
    <div className="space-y-4">
      <div
        className="flex gap-1 rounded-full border border-[var(--line)] bg-[var(--option-bg)] p-1"
        role="radiogroup"
        aria-label="Window"
      >
        {([7, 30, 90] as const).map((d) => (
          <button
            key={d}
            type="button"
            role="radio"
            aria-checked={days === d}
            onClick={() => setDays(d)}
            className={`rounded-full px-3 py-1 text-xs font-semibold transition ${
              days === d
                ? 'bg-[var(--btn-primary-bg)] text-[var(--btn-primary-fg)]'
                : 'text-[var(--sea-ink-soft)] hover:text-[var(--sea-ink)]'
            }`}
          >
            {d}d
          </button>
        ))}
      </div>

      {query.isLoading ? (
        <p className="text-[var(--sea-ink-soft)]">Loading…</p>
      ) : rows.length === 0 ? (
        <p className="text-sm text-[var(--sea-ink-soft)]">
          No cheers yet in this window.
        </p>
      ) : (
        <ul className="space-y-2">
          {rows.map((r) => (
            <li
              key={r.eventId}
              className="flex items-center gap-3 rounded-xl border border-[var(--line)] bg-[var(--option-bg)] p-3"
            >
              <Initials name={r.giverName} />
              <div className="min-w-0 flex-1">
                <p className="truncate text-sm text-[var(--sea-ink)]">
                  <span className="font-semibold">{r.giverName}</span>
                  <span className="text-[var(--sea-ink-soft)]"> cheered </span>
                  {r.taskTitle ? (
                    <span className="font-semibold">“{r.taskTitle}”</span>
                  ) : (
                    <span className="text-[var(--sea-ink-soft)]">
                      a task
                    </span>
                  )}
                </p>
                <p className="truncate text-xs text-[var(--sea-ink-soft)]">
                  @{r.giverHandle} · {relativeTime(r.occurredAt)} · +{r.xp} XP
                </p>
              </div>
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}

function relativeTime(iso: string | Date): string {
  const t = typeof iso === 'string' ? new Date(iso) : iso
  const diffMs = Date.now() - t.getTime()
  const min = Math.round(diffMs / 60_000)
  if (min < 1) return 'just now'
  if (min < 60) return `${min}m ago`
  const hr = Math.round(min / 60)
  if (hr < 24) return `${hr}h ago`
  const d = Math.round(hr / 24)
  return `${d}d ago`
}

function Initials({ name }: { name: string }) {
  const letters = name
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((w) => w[0]?.toUpperCase() ?? '')
    .join('')
  return (
    <span
      className="flex h-8 w-8 flex-shrink-0 items-center justify-center rounded-full bg-[var(--btn-primary-bg)] text-xs font-bold text-[var(--btn-primary-fg)]"
      aria-hidden
    >
      {letters || '?'}
    </span>
  )
}

function formatMetric(metric: LeaderboardMetric, value: number): string {
  if (metric === 'xp') return `${value} XP`
  if (metric === 'streak') return value === 1 ? '1 day' : `${value} days`
  // showed-up
  return value === 1 ? '1 day' : `${value} days`
}
