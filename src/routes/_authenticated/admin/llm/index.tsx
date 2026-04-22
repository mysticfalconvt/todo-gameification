import { useMemo, useState } from 'react'
import { createFileRoute, Link, redirect } from '@tanstack/react-router'
import { useQuery } from '@tanstack/react-query'
import {
  getAdminLlmUsageFn,
  getIsAdminFn,
  listAdminLlmCallsFn,
} from '../../../../server/functions/admin'

// Admin "LLM usage" page: totals, per-kind + per-user + per-day breakdowns,
// and a paginated call log you can drill into.
type Search = {
  kind?: string
  userId?: string
  windowDays?: number
}

export const Route = createFileRoute('/_authenticated/admin/llm/')({
  validateSearch: (s: Record<string, unknown>): Search => ({
    kind: typeof s.kind === 'string' ? s.kind : undefined,
    userId: typeof s.userId === 'string' ? s.userId : undefined,
    windowDays:
      typeof s.windowDays === 'number' && s.windowDays > 0
        ? Math.min(90, Math.floor(s.windowDays))
        : undefined,
  }),
  beforeLoad: async () => {
    const { isAdmin } = await getIsAdminFn()
    if (!isAdmin) throw redirect({ to: '/today' })
  },
  component: AdminLlmPage,
})

function AdminLlmPage() {
  const search = Route.useSearch()
  const windowDays = search.windowDays ?? 14
  const usage = useQuery({
    queryKey: ['admin', 'llm-usage', windowDays],
    queryFn: () => getAdminLlmUsageFn({ data: { windowDays } }),
  })

  return (
    <main className="page-wrap space-y-6 px-4 py-8">
      <header className="space-y-1">
        <p className="island-kicker mb-1">
          <Link to="/admin" className="no-underline">
            ← Admin
          </Link>
        </p>
        <h1 className="display-title text-4xl font-bold text-[var(--sea-ink)]">
          LLM usage
        </h1>
        <p className="text-sm text-[var(--sea-ink-soft)]">
          Cost + volume across all LLM calls. Window defaults to 14 days; log
          below shows every call regardless of window.
        </p>
      </header>

      {usage.isLoading || !usage.data ? (
        <p className="text-[var(--sea-ink-soft)]">Loading…</p>
      ) : (
        <>
          <TotalsSection data={usage.data} />
          <PerKindSection data={usage.data} />
          <PerDaySection data={usage.data} />
          <PerUserSection data={usage.data} />
        </>
      )}

      <CallLogSection initialFilters={search} />
    </main>
  )
}

type UsageData = Awaited<ReturnType<typeof getAdminLlmUsageFn>>

function TotalsSection({ data }: { data: UsageData }) {
  const w = data.totalsInWindow
  const all = data.totalsAllTime
  return (
    <section className="space-y-3">
      <h2 className="text-lg font-bold text-[var(--sea-ink)]">
        Totals (last {data.windowDays}d)
      </h2>
      <div className="grid gap-3 sm:grid-cols-2 md:grid-cols-4">
        <Stat
          label="Calls"
          value={w.callCount}
          hint={`${all.callCount} all-time`}
        />
        <Stat
          label="Success rate"
          value={
            w.callCount === 0
              ? '—'
              : `${Math.round((w.successCount / w.callCount) * 100)}%`
          }
          hint={`${w.successCount}/${w.callCount}`}
        />
        <Stat
          label="Total LLM time"
          value={formatDuration(w.totalDurationMs)}
          hint={`${formatDuration(all.totalDurationMs)} all-time`}
        />
        <Stat
          label="Avg per call"
          value={
            w.callCount === 0
              ? '—'
              : formatMs(Math.round(w.totalDurationMs / w.callCount))
          }
        />
        <Stat
          label="Total tokens"
          value={w.totalTokens.toLocaleString()}
          hint={`${all.totalTokens.toLocaleString()} all-time`}
        />
        <Stat
          label="Prompt tokens"
          value={w.promptTokens.toLocaleString()}
        />
        <Stat
          label="Completion tokens"
          value={w.completionTokens.toLocaleString()}
        />
        <Stat
          label="Avg tokens / call"
          value={
            w.callCount === 0
              ? '—'
              : Math.round(w.totalTokens / w.callCount).toLocaleString()
          }
        />
      </div>
    </section>
  )
}

function PerKindSection({ data }: { data: UsageData }) {
  return (
    <section className="space-y-3">
      <h2 className="text-lg font-bold text-[var(--sea-ink)]">By kind</h2>
      {data.perKind.length === 0 ? (
        <p className="text-[var(--sea-ink-soft)]">No calls in window.</p>
      ) : (
        <div className="island-shell overflow-x-auto rounded-2xl">
          <table className="min-w-full text-left text-sm">
            <thead className="border-b border-[var(--line)] bg-[var(--option-bg)] text-xs uppercase tracking-wide text-[var(--sea-ink-soft)]">
              <tr>
                <th className="px-3 py-2">Kind</th>
                <th className="px-3 py-2">Calls</th>
                <th className="px-3 py-2">Success</th>
                <th className="px-3 py-2">Total time</th>
                <th className="px-3 py-2">Avg / call</th>
                <th className="px-3 py-2">Tokens</th>
              </tr>
            </thead>
            <tbody>
              {data.perKind.map((r) => (
                <tr
                  key={r.kind}
                  className="border-b border-[var(--line)] last:border-none"
                >
                  <td className="px-3 py-2 font-semibold text-[var(--sea-ink)]">
                    {r.kind}
                  </td>
                  <td className="px-3 py-2">{r.callCount}</td>
                  <td className="px-3 py-2 text-[var(--sea-ink-soft)]">
                    {r.successCount}/{r.callCount}
                  </td>
                  <td className="px-3 py-2">
                    {formatDuration(r.totalDurationMs)}
                  </td>
                  <td className="px-3 py-2 text-[var(--sea-ink-soft)]">
                    {r.callCount === 0
                      ? '—'
                      : formatMs(Math.round(r.totalDurationMs / r.callCount))}
                  </td>
                  <td className="px-3 py-2">{r.totalTokens.toLocaleString()}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  )
}

function PerDaySection({ data }: { data: UsageData }) {
  const max = Math.max(1, ...data.perDay.map((d) => d.totalDurationMs))
  return (
    <section className="space-y-3">
      <h2 className="text-lg font-bold text-[var(--sea-ink)]">By day</h2>
      {data.perDay.length === 0 ? (
        <p className="text-[var(--sea-ink-soft)]">No calls in window.</p>
      ) : (
        <div className="island-shell overflow-x-auto rounded-2xl">
          <table className="min-w-full text-left text-sm">
            <thead className="border-b border-[var(--line)] bg-[var(--option-bg)] text-xs uppercase tracking-wide text-[var(--sea-ink-soft)]">
              <tr>
                <th className="px-3 py-2">Day</th>
                <th className="px-3 py-2">Calls</th>
                <th className="px-3 py-2">Success</th>
                <th className="px-3 py-2">Total time</th>
                <th className="px-3 py-2 w-48">Load</th>
                <th className="px-3 py-2">Tokens</th>
              </tr>
            </thead>
            <tbody>
              {data.perDay.map((d) => (
                <tr
                  key={d.day}
                  className="border-b border-[var(--line)] last:border-none"
                >
                  <td className="px-3 py-2 font-semibold text-[var(--sea-ink)]">
                    {d.day}
                  </td>
                  <td className="px-3 py-2">{d.callCount}</td>
                  <td className="px-3 py-2 text-[var(--sea-ink-soft)]">
                    {d.successCount}/{d.callCount}
                  </td>
                  <td className="px-3 py-2">
                    {formatDuration(d.totalDurationMs)}
                  </td>
                  <td className="px-3 py-2">
                    <div className="h-2 rounded bg-[var(--option-bg)]">
                      <div
                        className="h-2 rounded bg-[var(--lagoon-deep)]"
                        style={{
                          width: `${Math.round((d.totalDurationMs / max) * 100)}%`,
                        }}
                      />
                    </div>
                  </td>
                  <td className="px-3 py-2">{d.totalTokens.toLocaleString()}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  )
}

function PerUserSection({ data }: { data: UsageData }) {
  return (
    <section className="space-y-3">
      <h2 className="text-lg font-bold text-[var(--sea-ink)]">By user</h2>
      {data.perUser.length === 0 ? (
        <p className="text-[var(--sea-ink-soft)]">No calls in window.</p>
      ) : (
        <div className="island-shell overflow-x-auto rounded-2xl">
          <table className="min-w-full text-left text-sm">
            <thead className="border-b border-[var(--line)] bg-[var(--option-bg)] text-xs uppercase tracking-wide text-[var(--sea-ink-soft)]">
              <tr>
                <th className="px-3 py-2">User</th>
                <th className="px-3 py-2">Calls</th>
                <th className="px-3 py-2">Success</th>
                <th className="px-3 py-2">Total time</th>
                <th className="px-3 py-2">Tokens</th>
                <th className="px-3 py-2">Last call</th>
              </tr>
            </thead>
            <tbody>
              {data.perUser.map((r, idx) => (
                <tr
                  key={r.userId ?? `anon-${idx}`}
                  className="border-b border-[var(--line)] last:border-none"
                >
                  <td className="px-3 py-2">
                    {r.userId && r.userHandle ? (
                      <Link
                        to="/admin/users/$userId"
                        params={{ userId: r.userId }}
                        className="font-semibold text-[var(--sea-ink)] no-underline"
                      >
                        {r.userName ?? r.userHandle}
                      </Link>
                    ) : (
                      <span className="text-[var(--sea-ink-soft)]">
                        (unattributed)
                      </span>
                    )}
                    {r.email ? (
                      <div className="text-xs text-[var(--sea-ink-soft)]">
                        {r.email}
                      </div>
                    ) : null}
                  </td>
                  <td className="px-3 py-2">{r.callCount}</td>
                  <td className="px-3 py-2 text-[var(--sea-ink-soft)]">
                    {r.successCount}/{r.callCount}
                  </td>
                  <td className="px-3 py-2">
                    {formatDuration(r.totalDurationMs)}
                  </td>
                  <td className="px-3 py-2">{r.totalTokens.toLocaleString()}</td>
                  <td className="px-3 py-2 text-[var(--sea-ink-soft)]">
                    {r.lastCallAt ? relativeTime(r.lastCallAt) : '—'}
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

function CallLogSection({ initialFilters }: { initialFilters: Search }) {
  const [kind, setKind] = useState<string>(initialFilters.kind ?? '')
  const [userId, setUserId] = useState<string>(initialFilters.userId ?? '')
  // Pages stack cursors so "back" is cheap. Each cursor is the `startedAt`
  // of the last row on the previous page.
  const [cursors, setCursors] = useState<Array<string | null>>([null])
  const currentCursor = cursors[cursors.length - 1]

  const filters = useMemo(
    () => ({ kind: kind || undefined, userId: userId || undefined }),
    [kind, userId],
  )

  const query = useQuery({
    queryKey: ['admin', 'llm-calls', filters, currentCursor],
    queryFn: () =>
      listAdminLlmCallsFn({
        data: { ...filters, before: currentCursor, limit: 50 },
      }),
  })
  const rows = query.data?.rows ?? []

  return (
    <section className="space-y-3">
      <header className="flex flex-wrap items-center justify-between gap-3">
        <h2 className="text-lg font-bold text-[var(--sea-ink)]">Call log</h2>
        <div className="flex flex-wrap items-center gap-2 text-xs">
          <label className="flex items-center gap-1">
            <span className="text-[var(--sea-ink-soft)]">Kind</span>
            <select
              value={kind}
              onChange={(e) => {
                setKind(e.target.value)
                setCursors([null])
              }}
              className="field-input max-w-[10rem]"
            >
              <option value="">all</option>
              <option value="score">score</option>
              <option value="categorize">categorize</option>
              <option value="coach">coach</option>
            </select>
          </label>
          <label className="flex items-center gap-1">
            <span className="text-[var(--sea-ink-soft)]">User id</span>
            <input
              type="text"
              value={userId}
              onChange={(e) => {
                setUserId(e.target.value)
                setCursors([null])
              }}
              placeholder="optional"
              className="field-input max-w-[14rem] text-xs"
            />
          </label>
        </div>
      </header>

      {query.isLoading ? (
        <p className="text-[var(--sea-ink-soft)]">Loading…</p>
      ) : rows.length === 0 ? (
        <p className="text-[var(--sea-ink-soft)]">No calls match the filter.</p>
      ) : (
        <div className="island-shell overflow-x-auto rounded-2xl">
          <table className="min-w-full text-left text-sm">
            <thead className="border-b border-[var(--line)] bg-[var(--option-bg)] text-xs uppercase tracking-wide text-[var(--sea-ink-soft)]">
              <tr>
                <th className="px-3 py-2">Started</th>
                <th className="px-3 py-2">Kind</th>
                <th className="px-3 py-2">User</th>
                <th className="px-3 py-2">Duration</th>
                <th className="px-3 py-2">Tokens</th>
                <th className="px-3 py-2">Model</th>
                <th className="px-3 py-2">Result</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr
                  key={r.id}
                  className={`border-b border-[var(--line)] last:border-none ${
                    r.success ? '' : 'bg-[rgba(230,90,90,0.08)]'
                  }`}
                >
                  <td className="px-3 py-2 text-[var(--sea-ink-soft)]">
                    <Link
                      to="/admin/llm/$callId"
                      params={{ callId: r.id }}
                      className="text-[var(--lagoon-deep)] no-underline"
                    >
                      {relativeTime(r.startedAt)}
                    </Link>
                  </td>
                  <td className="px-3 py-2">{r.kind}</td>
                  <td className="px-3 py-2 text-xs">
                    {r.userId && r.userHandle ? (
                      <Link
                        to="/admin/users/$userId"
                        params={{ userId: r.userId }}
                        className="text-[var(--sea-ink)] no-underline"
                      >
                        @{r.userHandle}
                      </Link>
                    ) : (
                      <span className="text-[var(--sea-ink-soft)]">—</span>
                    )}
                  </td>
                  <td className="px-3 py-2">{formatMs(r.durationMs)}</td>
                  <td className="px-3 py-2">{r.totalTokens ?? '—'}</td>
                  <td className="px-3 py-2 text-xs text-[var(--sea-ink-soft)]">
                    {r.model ?? '—'}
                  </td>
                  <td className="px-3 py-2">
                    {r.success ? (
                      <span className="text-[var(--sea-ink-soft)]">ok</span>
                    ) : (
                      <span className="text-red-600">
                        {r.errorMessage ?? 'fail'}
                      </span>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <div className="flex items-center justify-between text-xs text-[var(--sea-ink-soft)]">
        <button
          type="button"
          disabled={cursors.length <= 1}
          onClick={() => setCursors((prev) => prev.slice(0, -1))}
          className="field-input max-w-[6rem] disabled:opacity-50"
        >
          ← Prev
        </button>
        <button
          type="button"
          disabled={!query.data?.nextCursor}
          onClick={() =>
            setCursors((prev) => [...prev, query.data?.nextCursor ?? null])
          }
          className="field-input max-w-[6rem] disabled:opacity-50"
        >
          Next →
        </button>
      </div>
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

function formatMs(ms: number): string {
  if (ms < 1000) return `${ms}ms`
  return `${(ms / 1000).toFixed(ms < 10_000 ? 1 : 0)}s`
}

function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`
  const seconds = ms / 1000
  if (seconds < 60) return `${seconds.toFixed(1)}s`
  const minutes = seconds / 60
  if (minutes < 60) return `${minutes.toFixed(1)}m`
  const hours = minutes / 60
  return `${hours.toFixed(1)}h`
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
