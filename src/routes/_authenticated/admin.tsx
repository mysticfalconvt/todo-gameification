import { useState } from 'react'
import { createFileRoute, Link, redirect } from '@tanstack/react-router'
import { useQuery } from '@tanstack/react-query'
import {
  getAdminLlmMetricsFn,
  getAdminOpenInstancesFn,
  getAdminSummaryFn,
  getIsAdminFn,
  listAdminEventsFn,
  listAdminUsersFn,
} from '../../server/functions/admin'
import type { LlmMetricsWindow } from '../../server/services/llmTracking'

export const Route = createFileRoute('/_authenticated/admin')({
  beforeLoad: async () => {
    // Guard the route at the server level so non-admins can't see anything
    // even if they try to navigate manually.
    const { isAdmin } = await getIsAdminFn()
    if (!isAdmin) throw redirect({ to: '/today' })
  },
  component: AdminPage,
})

function AdminPage() {
  return (
    <main className="page-wrap space-y-6 px-4 py-8">
      <header>
        <p className="island-kicker mb-1">Admin</p>
        <h1 className="display-title text-4xl font-bold text-[var(--sea-ink)]">
          Dashboard
        </h1>
      </header>
      <SummaryGrid />
      <LlmMetricsSection />
      <UsersTable />
      <RecentEvents />
    </main>
  )
}

function LlmMetricsSection() {
  const query = useQuery({
    queryKey: ['admin', 'llm-metrics'],
    queryFn: () => getAdminLlmMetricsFn(),
    refetchInterval: 30_000,
  })

  const windows: LlmMetricsWindow[] = ['1m', '30m', '1h', '24h']
  const data = query.data
  const rows = data ? [data.overall, ...data.rows] : []

  return (
    <section className="space-y-3">
      <header className="flex items-baseline justify-between gap-3">
        <h2 className="text-lg font-bold text-[var(--sea-ink)]">
          LLM latency
        </h2>
        <p className="text-xs text-[var(--sea-ink-soft)]">
          Average + p95 per call kind, per window. Failures are calls that
          errored or returned no usable output.
        </p>
      </header>
      {query.isLoading || !data ? (
        <p className="text-[var(--sea-ink-soft)]">Loading…</p>
      ) : (
        <div className="island-shell overflow-x-auto rounded-2xl">
          <table className="min-w-full text-left text-sm">
            <thead className="border-b border-[var(--line)] bg-[var(--option-bg)] text-xs uppercase tracking-wide text-[var(--sea-ink-soft)]">
              <tr>
                <th className="px-3 py-2">Kind</th>
                {windows.map((w) => (
                  <th key={w} className="px-3 py-2" colSpan={2}>
                    {w}
                  </th>
                ))}
              </tr>
              <tr className="text-[10px]">
                <th className="px-3 py-1" />
                {windows.map((w) => (
                  <>
                    <th key={`${w}-avg`} className="px-3 py-1">
                      avg / p95
                    </th>
                    <th key={`${w}-n`} className="px-3 py-1">
                      n · ok%
                    </th>
                  </>
                ))}
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr
                  key={r.kind}
                  className={`border-b border-[var(--line)] last:border-none ${
                    r.kind === 'all'
                      ? 'bg-[rgba(79,184,178,0.06)] font-semibold'
                      : ''
                  }`}
                >
                  <td className="px-3 py-2 text-[var(--sea-ink)]">
                    {r.kind}
                  </td>
                  {windows.map((w) => {
                    const cell = r.windows[w]
                    const okPct =
                      cell.count === 0
                        ? '—'
                        : `${Math.round((cell.successCount / cell.count) * 100)}%`
                    return (
                      <>
                        <td key={`${r.kind}-${w}-avg`} className="px-3 py-2">
                          {cell.count === 0 ? (
                            <span className="text-[var(--sea-ink-soft)]">
                              —
                            </span>
                          ) : (
                            <span>
                              {formatMs(cell.avgMs)} /{' '}
                              <span className="text-[var(--sea-ink-soft)]">
                                {formatMs(cell.p95Ms)}
                              </span>
                            </span>
                          )}
                        </td>
                        <td
                          key={`${r.kind}-${w}-n`}
                          className="px-3 py-2 text-[var(--sea-ink-soft)]"
                        >
                          {cell.count === 0
                            ? '—'
                            : `${cell.count} · ${okPct}`}
                        </td>
                      </>
                    )
                  })}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {data && data.recentFailures.length > 0 ? (
        <details className="island-shell rounded-2xl p-3 text-sm">
          <summary className="cursor-pointer font-semibold text-[var(--sea-ink)]">
            Recent failures ({data.recentFailures.length})
          </summary>
          <ul className="mt-3 space-y-1 text-xs">
            {data.recentFailures.map((f, i) => (
              <li
                key={i}
                className="flex flex-wrap items-baseline gap-2 text-[var(--sea-ink-soft)]"
              >
                <span>{relativeTime(f.startedAt)}</span>
                <span className="font-semibold text-[var(--sea-ink)]">
                  {f.kind}
                </span>
                <span>{formatMs(f.durationMs)}</span>
                {f.errorMessage ? (
                  <code className="min-w-0 flex-1 truncate text-[11px]">
                    {f.errorMessage}
                  </code>
                ) : null}
              </li>
            ))}
          </ul>
        </details>
      ) : null}
    </section>
  )
}

function formatMs(ms: number): string {
  if (ms < 1000) return `${ms}ms`
  return `${(ms / 1000).toFixed(ms < 10_000 ? 1 : 0)}s`
}

function SummaryGrid() {
  const summary = useQuery({
    queryKey: ['admin', 'summary'],
    queryFn: () => getAdminSummaryFn(),
  })
  const open = useQuery({
    queryKey: ['admin', 'open-instances'],
    queryFn: () => getAdminOpenInstancesFn(),
  })
  if (summary.isLoading || !summary.data) {
    return <p className="text-[var(--sea-ink-soft)]">Loading…</p>
  }
  const s = summary.data
  const o = open.data
  return (
    <section className="space-y-4">
      <div className="grid gap-3 sm:grid-cols-2 md:grid-cols-4">
        <Stat label="Users" value={s.totalUsers} />
        <Stat label="Signups today" value={s.signupsToday} />
        <Stat label="Signups 7d" value={s.signupsLast7} />
        <Stat label="Signups 30d" value={s.signupsLast30} />
        <Stat
          label="Active 7d"
          value={s.activeLast7}
          hint={`${s.activeLast30} in 30d`}
        />
        <Stat
          label="Inactive"
          value={s.inactiveCount}
          hint="No completion in 30d"
        />
        <Stat label="Active tasks" value={s.totalTasks} />
        <Stat label="Total completions" value={s.totalCompletions} />
        {o ? (
          <>
            <Stat
              label="Open instances"
              value={o.count}
              hint={`${o.withDueAt} timed · ${o.someday} someday`}
            />
          </>
        ) : null}
        <Stat label="Push subs" value={s.pushSubscriptions} />
      </div>
      <div className="island-shell rounded-2xl p-4 text-sm text-[var(--sea-ink-soft)]">
        <p className="mb-2 text-xs font-semibold uppercase tracking-wide text-[var(--kicker)]">
          System
        </p>
        <div className="flex flex-wrap gap-4">
          <Flag label="LLM" on={s.system.llm} />
          <Flag label="SMTP" on={s.system.smtp} />
          <Flag label="VAPID" on={s.system.vapid} />
          <span>Admins configured: {s.system.adminCount}</span>
        </div>
      </div>
    </section>
  )
}

function UsersTable() {
  const query = useQuery({
    queryKey: ['admin', 'users'],
    queryFn: () => listAdminUsersFn(),
  })
  const [sort, setSort] = useState<
    'created-desc' | 'xp-desc' | 'completions-desc' | 'active-desc'
  >('created-desc')

  const rows = [...(Array.isArray(query.data) ? query.data : [])].sort((a, b) => {
    switch (sort) {
      case 'xp-desc':
        return b.xp - a.xp
      case 'completions-desc':
        return b.totalCompletions - a.totalCompletions
      case 'active-desc': {
        const ax = a.lastCompletionAt ?? ''
        const bx = b.lastCompletionAt ?? ''
        return bx.localeCompare(ax)
      }
      case 'created-desc':
      default:
        return b.createdAt.localeCompare(a.createdAt)
    }
  })

  return (
    <section className="space-y-3">
      <header className="flex items-baseline justify-between gap-3">
        <h2 className="text-lg font-bold text-[var(--sea-ink)]">
          Users ({rows.length})
        </h2>
        <select
          value={sort}
          onChange={(e) => setSort(e.target.value as typeof sort)}
          className="field-input max-w-[12rem]"
        >
          <option value="created-desc">Newest first</option>
          <option value="active-desc">Recently active</option>
          <option value="xp-desc">Highest XP</option>
          <option value="completions-desc">Most completions</option>
        </select>
      </header>
      {query.isLoading ? (
        <p className="text-[var(--sea-ink-soft)]">Loading…</p>
      ) : rows.length === 0 ? (
        <p className="text-[var(--sea-ink-soft)]">No users yet.</p>
      ) : (
        <div className="island-shell overflow-x-auto rounded-2xl">
          <table className="min-w-full text-left text-sm">
            <thead className="border-b border-[var(--line)] bg-[var(--option-bg)] text-xs uppercase tracking-wide text-[var(--sea-ink-soft)]">
              <tr>
                <th className="px-3 py-2">User</th>
                <th className="px-3 py-2">Email</th>
                <th className="px-3 py-2">Joined</th>
                <th className="px-3 py-2">Last active</th>
                <th className="px-3 py-2">Lvl</th>
                <th className="px-3 py-2">XP</th>
                <th className="px-3 py-2">Streak</th>
                <th className="px-3 py-2">Tasks</th>
                <th className="px-3 py-2">Done</th>
                <th className="px-3 py-2">Visibility</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((u) => (
                <tr
                  key={u.id}
                  className="border-b border-[var(--line)] last:border-none"
                >
                  <td className="px-3 py-2">
                    <Link
                      to="/u/$handle"
                      params={{ handle: u.handle }}
                      className="font-semibold text-[var(--sea-ink)] no-underline"
                    >
                      {u.name}
                    </Link>
                    <div className="text-xs text-[var(--sea-ink-soft)]">
                      @{u.handle}
                      {u.isAdmin ? ' · admin' : ''}
                      {!u.emailVerified ? ' · unverified' : ''}
                    </div>
                  </td>
                  <td className="px-3 py-2 text-[var(--sea-ink-soft)]">
                    {u.email}
                  </td>
                  <td className="px-3 py-2 text-[var(--sea-ink-soft)]">
                    {formatDate(u.createdAt)}
                  </td>
                  <td className="px-3 py-2 text-[var(--sea-ink-soft)]">
                    {u.lastCompletionAt
                      ? relativeTime(u.lastCompletionAt)
                      : '—'}
                  </td>
                  <td className="px-3 py-2">{u.level}</td>
                  <td className="px-3 py-2">{u.xp}</td>
                  <td className="px-3 py-2">
                    {u.currentStreak}
                    {u.longestStreak > u.currentStreak
                      ? ` (max ${u.longestStreak})`
                      : ''}
                  </td>
                  <td className="px-3 py-2">{u.activeTaskCount}</td>
                  <td className="px-3 py-2">{u.totalCompletions}</td>
                  <td className="px-3 py-2 text-[var(--sea-ink-soft)]">
                    {u.profileVisibility}
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

function RecentEvents() {
  const query = useQuery({
    queryKey: ['admin', 'events'],
    queryFn: () => listAdminEventsFn({ data: { limit: 50 } }),
    refetchInterval: 30_000,
  })
  const rows = Array.isArray(query.data) ? query.data : []
  return (
    <section className="space-y-3">
      <h2 className="text-lg font-bold text-[var(--sea-ink)]">
        Recent events
      </h2>
      {query.isLoading ? (
        <p className="text-[var(--sea-ink-soft)]">Loading…</p>
      ) : rows.length === 0 ? (
        <p className="text-[var(--sea-ink-soft)]">No events yet.</p>
      ) : (
        <ul className="space-y-1 text-sm">
          {rows.map((e) => (
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
              {e.userHandle ? (
                <Link
                  to="/u/$handle"
                  params={{ handle: e.userHandle }}
                  className="text-xs text-[var(--lagoon-deep)] no-underline"
                >
                  @{e.userHandle}
                </Link>
              ) : (
                <span className="text-xs text-[var(--sea-ink-soft)]">
                  ({e.userName})
                </span>
              )}
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

function Stat({
  label,
  value,
  hint,
}: {
  label: string
  value: number | string
  hint?: string
}) {
  return (
    <div className="island-shell rounded-2xl p-4">
      <div className="text-xs uppercase tracking-wide text-[var(--sea-ink-soft)]">
        {label}
      </div>
      <div className="mt-1 text-2xl font-bold text-[var(--sea-ink)]">
        {value}
      </div>
      {hint ? (
        <div className="mt-1 text-xs text-[var(--sea-ink-soft)]">{hint}</div>
      ) : null}
    </div>
  )
}

function Flag({ label, on }: { label: string; on: boolean }) {
  return (
    <span
      className={`inline-flex items-center gap-2 rounded-full border px-3 py-1 text-xs font-semibold ${
        on
          ? 'border-[var(--lagoon-deep)] bg-[rgba(79,184,178,0.14)] text-[var(--lagoon-deep)]'
          : 'border-[var(--line)] bg-[var(--option-bg)] text-[var(--sea-ink-soft)]'
      }`}
    >
      <span
        className={`inline-block h-1.5 w-1.5 rounded-full ${
          on ? 'bg-[var(--lagoon-deep)]' : 'bg-[var(--sea-ink-soft)]'
        }`}
      />
      {label} {on ? 'on' : 'off'}
    </span>
  )
}

function formatDate(iso: string): string {
  const d = new Date(iso)
  return d.toLocaleDateString(undefined, {
    month: 'short',
    day: 'numeric',
    year: d.getFullYear() !== new Date().getFullYear() ? 'numeric' : undefined,
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
