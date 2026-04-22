import { createFileRoute, Link, redirect } from '@tanstack/react-router'
import { useQuery } from '@tanstack/react-query'
import {
  getAdminUserDetailFn,
  getIsAdminFn,
} from '../../../server/functions/admin'

export const Route = createFileRoute('/_authenticated/admin/users/$userId')({
  beforeLoad: async () => {
    const { isAdmin } = await getIsAdminFn()
    if (!isAdmin) throw redirect({ to: '/today' })
  },
  component: AdminUserDetailPage,
})

function AdminUserDetailPage() {
  const { userId } = Route.useParams()
  const query = useQuery({
    queryKey: ['admin', 'user-detail', userId],
    queryFn: () => getAdminUserDetailFn({ data: { userId } }),
  })
  const data = query.data

  return (
    <main className="page-wrap space-y-6 px-4 py-8">
      <header className="space-y-2">
        <p className="island-kicker mb-1">
          <Link to="/admin" className="no-underline">
            ← Admin
          </Link>
        </p>
        <h1 className="display-title text-4xl font-bold text-[var(--sea-ink)]">
          {data ? data.user.name : 'User'}
        </h1>
        {data ? (
          <p className="text-sm text-[var(--sea-ink-soft)]">
            @{data.user.handle} · {data.user.email}
            {data.user.isAdmin ? ' · admin' : ''}
            {!data.user.emailVerified ? ' · unverified' : ''}
          </p>
        ) : null}
      </header>

      {query.isLoading ? (
        <p className="text-[var(--sea-ink-soft)]">Loading…</p>
      ) : query.isError ? (
        <p className="text-red-600">
          Failed to load user: {(query.error as Error)?.message ?? 'unknown error'}
        </p>
      ) : !data ? (
        <p className="text-[var(--sea-ink-soft)]">User not found.</p>
      ) : (
        <>
          <SummaryGrid data={data} />
          <OpenInstancesTable data={data} />
          <RecentTasksTable data={data} />
          <RecentEventsList data={data} />
          <PushSubscriptionsTable data={data} />
          <RecentLlmCallsTable data={data} />
        </>
      )}
    </main>
  )
}

function SummaryGrid({ data }: { data: UserDetail }) {
  return (
    <section className="space-y-4">
      <div className="grid gap-3 sm:grid-cols-2 md:grid-cols-4">
        <Stat label="Level" value={data.progression.level} />
        <Stat
          label="XP"
          value={data.progression.xp}
          hint={`streak ${data.progression.currentStreak}`}
        />
        <Stat
          label="Longest streak"
          value={data.progression.longestStreak}
          hint={
            data.progression.lastCompletionAt
              ? `last done ${relativeTime(data.progression.lastCompletionAt)}`
              : 'no completions yet'
          }
        />
        <Stat label="Active tasks" value={data.counts.activeTasks} />
        <Stat
          label="Open instances"
          value={data.counts.openInstances}
          hint={`${data.counts.openWithDue} timed · ${data.counts.openSomeday} someday`}
        />
        <Stat label="Total completions" value={data.counts.totalCompletions} />
        <Stat
          label="Push devices"
          value={data.pushSubscriptions.length}
          hint={
            data.pushSubscriptions.some((p) => p.failureCount > 0)
              ? 'some failing'
              : undefined
          }
        />
        <Stat
          label="Timezone"
          value={data.user.timezone}
          small
          hint={
            data.user.quietHoursStart && data.user.quietHoursEnd
              ? `quiet ${data.user.quietHoursStart}–${data.user.quietHoursEnd}`
              : 'no quiet hours'
          }
        />
      </div>
      <div className="island-shell rounded-2xl p-4 text-sm text-[var(--sea-ink-soft)]">
        <p>
          Joined {formatDate(data.user.createdAt)} · visibility{' '}
          {data.user.profileVisibility}
        </p>
        <Link
          to="/u/$handle"
          params={{ handle: data.user.handle }}
          className="text-[var(--lagoon-deep)] no-underline"
        >
          View public profile →
        </Link>
      </div>
    </section>
  )
}

function OpenInstancesTable({ data }: { data: UserDetail }) {
  return (
    <section className="space-y-3">
      <h2 className="text-lg font-bold text-[var(--sea-ink)]">
        Open instances ({data.openInstances.length})
      </h2>
      {data.openInstances.length === 0 ? (
        <p className="text-[var(--sea-ink-soft)]">Inbox zero.</p>
      ) : (
        <div className="island-shell overflow-x-auto rounded-2xl">
          <table className="min-w-full text-left text-sm">
            <thead className="border-b border-[var(--line)] bg-[var(--option-bg)] text-xs uppercase tracking-wide text-[var(--sea-ink-soft)]">
              <tr>
                <th className="px-3 py-2">Task</th>
                <th className="px-3 py-2">Due</th>
                <th className="px-3 py-2">Snoozed until</th>
                <th className="px-3 py-2">Created</th>
              </tr>
            </thead>
            <tbody>
              {data.openInstances.map((i) => (
                <tr
                  key={i.id}
                  className="border-b border-[var(--line)] last:border-none"
                >
                  <td className="px-3 py-2 font-semibold text-[var(--sea-ink)]">
                    {i.title}
                  </td>
                  <td className="px-3 py-2 text-[var(--sea-ink-soft)]">
                    {i.dueAt ? formatDateTime(i.dueAt) : 'someday'}
                  </td>
                  <td className="px-3 py-2 text-[var(--sea-ink-soft)]">
                    {i.snoozedUntil ? formatDateTime(i.snoozedUntil) : '—'}
                  </td>
                  <td className="px-3 py-2 text-[var(--sea-ink-soft)]">
                    {relativeTime(i.createdAt)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  )
}

function RecentTasksTable({ data }: { data: UserDetail }) {
  return (
    <section className="space-y-3">
      <h2 className="text-lg font-bold text-[var(--sea-ink)]">
        Recent tasks ({data.recentTasks.length})
      </h2>
      {data.recentTasks.length === 0 ? (
        <p className="text-[var(--sea-ink-soft)]">No tasks yet.</p>
      ) : (
        <div className="island-shell overflow-x-auto rounded-2xl">
          <table className="min-w-full text-left text-sm">
            <thead className="border-b border-[var(--line)] bg-[var(--option-bg)] text-xs uppercase tracking-wide text-[var(--sea-ink-soft)]">
              <tr>
                <th className="px-3 py-2">Title</th>
                <th className="px-3 py-2">Difficulty</th>
                <th className="px-3 py-2">XP override</th>
                <th className="px-3 py-2">Category</th>
                <th className="px-3 py-2">Created</th>
                <th className="px-3 py-2">Active</th>
              </tr>
            </thead>
            <tbody>
              {data.recentTasks.map((t) => (
                <tr
                  key={t.id}
                  className="border-b border-[var(--line)] last:border-none"
                >
                  <td className="px-3 py-2 font-semibold text-[var(--sea-ink)]">
                    {t.title}
                  </td>
                  <td className="px-3 py-2">{t.difficulty}</td>
                  <td className="px-3 py-2">{t.xpOverride ?? '—'}</td>
                  <td className="px-3 py-2 text-[var(--sea-ink-soft)]">
                    {t.categorySlug ?? '—'}
                  </td>
                  <td className="px-3 py-2 text-[var(--sea-ink-soft)]">
                    {relativeTime(t.createdAt)}
                  </td>
                  <td className="px-3 py-2">{t.active ? 'yes' : 'archived'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  )
}

function RecentEventsList({ data }: { data: UserDetail }) {
  return (
    <section className="space-y-3">
      <h2 className="text-lg font-bold text-[var(--sea-ink)]">
        Recent events ({data.recentEvents.length})
      </h2>
      {data.recentEvents.length === 0 ? (
        <p className="text-[var(--sea-ink-soft)]">No events.</p>
      ) : (
        <ul className="space-y-1 text-sm">
          {data.recentEvents.map((e) => (
            <li
              key={e.id}
              className="island-shell flex flex-wrap items-baseline gap-2 rounded-xl p-2"
            >
              <span className="text-xs text-[var(--sea-ink-soft)]">
                {relativeTime(e.occurredAt)}
              </span>
              <span className="font-semibold text-[var(--sea-ink)]">
                {e.type}
              </span>
              <code className="min-w-0 flex-1 truncate text-[11px] text-[var(--sea-ink-soft)]">
                {e.payload}
              </code>
            </li>
          ))}
        </ul>
      )}
    </section>
  )
}

function PushSubscriptionsTable({ data }: { data: UserDetail }) {
  return (
    <section className="space-y-3">
      <h2 className="text-lg font-bold text-[var(--sea-ink)]">
        Push subscriptions ({data.pushSubscriptions.length})
      </h2>
      {data.pushSubscriptions.length === 0 ? (
        <p className="text-[var(--sea-ink-soft)]">No devices registered.</p>
      ) : (
        <div className="island-shell overflow-x-auto rounded-2xl">
          <table className="min-w-full text-left text-sm">
            <thead className="border-b border-[var(--line)] bg-[var(--option-bg)] text-xs uppercase tracking-wide text-[var(--sea-ink-soft)]">
              <tr>
                <th className="px-3 py-2">Device</th>
                <th className="px-3 py-2">Endpoint</th>
                <th className="px-3 py-2">Failures</th>
                <th className="px-3 py-2">Last failure</th>
                <th className="px-3 py-2">Created</th>
              </tr>
            </thead>
            <tbody>
              {data.pushSubscriptions.map((p) => {
                const danger = p.failureCount > 0
                return (
                  <tr
                    key={p.id}
                    className={`border-b border-[var(--line)] last:border-none ${
                      danger ? 'bg-[rgba(230,90,90,0.08)]' : ''
                    }`}
                  >
                    <td className="px-3 py-2 font-semibold text-[var(--sea-ink)]">
                      {p.deviceLabel ?? '—'}
                    </td>
                    <td className="px-3 py-2 text-xs text-[var(--sea-ink-soft)]">
                      <code className="truncate">{shortEndpoint(p.endpoint)}</code>
                    </td>
                    <td
                      className={`px-3 py-2 ${
                        danger ? 'font-semibold text-red-600' : ''
                      }`}
                    >
                      {p.failureCount}
                    </td>
                    <td className="px-3 py-2 text-[var(--sea-ink-soft)]">
                      {p.lastFailureAt ? relativeTime(p.lastFailureAt) : '—'}
                    </td>
                    <td className="px-3 py-2 text-[var(--sea-ink-soft)]">
                      {relativeTime(p.createdAt)}
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>
      )}
    </section>
  )
}

function RecentLlmCallsTable({ data }: { data: UserDetail }) {
  return (
    <section className="space-y-3">
      <header className="flex items-baseline justify-between gap-3">
        <h2 className="text-lg font-bold text-[var(--sea-ink)]">
          Recent LLM calls ({data.recentLlmCalls.length})
        </h2>
        <Link
          to="/admin/llm"
          search={{ userId: data.user.id }}
          className="text-xs text-[var(--lagoon-deep)] no-underline"
        >
          Full history →
        </Link>
      </header>
      {data.recentLlmCalls.length === 0 ? (
        <p className="text-[var(--sea-ink-soft)]">No LLM calls recorded.</p>
      ) : (
        <div className="island-shell overflow-x-auto rounded-2xl">
          <table className="min-w-full text-left text-sm">
            <thead className="border-b border-[var(--line)] bg-[var(--option-bg)] text-xs uppercase tracking-wide text-[var(--sea-ink-soft)]">
              <tr>
                <th className="px-3 py-2">Started</th>
                <th className="px-3 py-2">Kind</th>
                <th className="px-3 py-2">Duration</th>
                <th className="px-3 py-2">Tokens</th>
                <th className="px-3 py-2">Result</th>
              </tr>
            </thead>
            <tbody>
              {data.recentLlmCalls.map((l) => (
                <tr
                  key={l.id}
                  className="border-b border-[var(--line)] last:border-none"
                >
                  <td className="px-3 py-2 text-[var(--sea-ink-soft)]">
                    <Link
                      to="/admin/llm/$callId"
                      params={{ callId: l.id }}
                      className="text-[var(--lagoon-deep)] no-underline"
                    >
                      {relativeTime(l.startedAt)}
                    </Link>
                  </td>
                  <td className="px-3 py-2">{l.kind}</td>
                  <td className="px-3 py-2">{formatMs(l.durationMs)}</td>
                  <td className="px-3 py-2">{l.totalTokens ?? '—'}</td>
                  <td
                    className={`px-3 py-2 ${
                      l.success ? '' : 'text-red-600'
                    }`}
                  >
                    {l.success ? 'ok' : (l.errorMessage ?? 'fail')}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  )
}

type UserDetail = NonNullable<
  Awaited<ReturnType<typeof getAdminUserDetailFn>>
>

function Stat({
  label,
  value,
  hint,
  small,
}: {
  label: string
  value: number | string
  hint?: string
  // Shrinks the value font + allows arbitrary break points. Use for long
  // strings (IANA timezones, etc.) that would otherwise overflow the card.
  small?: boolean
}) {
  return (
    <div className="island-shell overflow-hidden rounded-2xl p-4">
      <div className="text-xs uppercase tracking-wide text-[var(--sea-ink-soft)]">
        {label}
      </div>
      <div
        className={`mt-1 break-words font-bold text-[var(--sea-ink)] ${
          small ? 'text-base' : 'text-2xl'
        }`}
      >
        {value}
      </div>
      {hint ? (
        <div className="mt-1 text-xs text-[var(--sea-ink-soft)]">{hint}</div>
      ) : null}
    </div>
  )
}

function shortEndpoint(endpoint: string): string {
  try {
    const u = new URL(endpoint)
    const last = u.pathname.split('/').filter(Boolean).pop() ?? ''
    return `${u.hostname}${last ? ` · …${last.slice(-8)}` : ''}`
  } catch {
    return endpoint.slice(-32)
  }
}

function formatMs(ms: number): string {
  if (ms < 1000) return `${ms}ms`
  return `${(ms / 1000).toFixed(ms < 10_000 ? 1 : 0)}s`
}

function formatDate(iso: string): string {
  const d = new Date(iso)
  return d.toLocaleDateString(undefined, {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
  })
}

function formatDateTime(iso: string): string {
  const d = new Date(iso)
  return d.toLocaleString(undefined, {
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  })
}

function relativeTime(iso: string): string {
  const t = new Date(iso)
  const diff = Date.now() - t.getTime()
  const min = Math.round(diff / 60_000)
  if (min < 1) return 'just now'
  if (min < 60) return `${min}m ago`
  const hr = Math.round(min / 60)
  if (hr < 24) return `${hr}h ago`
  const d = Math.round(hr / 24)
  return `${d}d ago`
}
