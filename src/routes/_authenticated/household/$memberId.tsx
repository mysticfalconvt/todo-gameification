import { useState } from 'react'
import { createFileRoute, Link } from '@tanstack/react-router'
import { useQuery } from '@tanstack/react-query'
import {
  getHouseholdMemberStatsFn,
  getMyHouseholdFn,
} from '../../../server/functions/households'
import { XpLineSection } from '../../../components/stats/charts'

export const Route = createFileRoute('/_authenticated/household/$memberId')({
  component: HouseholdMemberStatsPage,
})

type Range = 7 | 30 | 90 | 'all'

function HouseholdMemberStatsPage() {
  const { memberId } = Route.useParams()
  const [days, setDays] = useState<Range>(30)

  // Pulls the household summary so we can show the member's display
  // name + role in the header without an extra request.
  const householdQuery = useQuery({
    queryKey: ['my-household'],
    queryFn: () => getMyHouseholdFn(),
  })

  const statsQuery = useQuery({
    queryKey: ['household-member-stats', memberId, days],
    queryFn: () =>
      getHouseholdMemberStatsFn({
        data: { targetUserId: memberId, days },
      }),
  })

  const member = householdQuery.data?.members.find(
    (m) => m.userId === memberId,
  )
  const stats = statsQuery.data
  const ranges: Range[] = [7, 30, 90, 'all']

  return (
    <main className="page-wrap space-y-6 px-4 py-8">
      <header className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <Link
            to="/household"
            className="text-xs font-semibold text-[var(--sea-ink-soft)] underline"
          >
            ← Household
          </Link>
          <p className="island-kicker mb-1 mt-2">Household member</p>
          <h1 className="display-title text-4xl font-bold text-[var(--sea-ink)]">
            {member?.name ?? 'Member'}
          </h1>
          {member ? (
            <p className="mt-1 text-sm text-[var(--sea-ink-soft)]">
              @{member.handle} ·{' '}
              {member.role === 'admin' ? 'an' : 'a'} {member.role}
            </p>
          ) : null}
        </div>
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
      </header>

      {statsQuery.isLoading || !stats ? (
        <p className="text-[var(--sea-ink-soft)]">Loading…</p>
      ) : (
        <>
          <SummaryCards xpByDay={stats.xpByDay} />
          <XpLineSection data={stats.xpByDay} />
        </>
      )}
    </main>
  )
}

function SummaryCards({
  xpByDay,
}: {
  xpByDay: Array<{ date: string; xp: number; count: number }>
}) {
  const totalXp = xpByDay.reduce((s, r) => s + r.xp, 0)
  const totalCount = xpByDay.reduce((s, r) => s + r.count, 0)
  const activeDays = xpByDay.filter((r) => r.count > 0).length
  return (
    <section className="grid grid-cols-1 gap-3 sm:grid-cols-3">
      <Stat label="Total XP" value={totalXp.toLocaleString()} />
      <Stat label="Chores completed" value={totalCount.toLocaleString()} />
      <Stat
        label="Active days"
        value={`${activeDays}${
          xpByDay.length > 0 ? ` of ${xpByDay.length}` : ''
        }`}
      />
    </section>
  )
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="island-shell rounded-2xl p-4">
      <p className="text-xs font-semibold uppercase tracking-wide text-[var(--kicker)]">
        {label}
      </p>
      <p className="mt-1 text-2xl font-bold text-[var(--sea-ink)]">{value}</p>
    </div>
  )
}
