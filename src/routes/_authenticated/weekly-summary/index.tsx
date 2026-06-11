import { useState } from 'react'
import { createFileRoute, Link } from '@tanstack/react-router'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { toast } from 'sonner'
import {
  getWeeklySummaryFn,
  regenerateWeeklyAnalysisFn,
} from '../../../server/functions/weeklySummary'
import { getProfile, updatePrefs } from '../../../server/functions/user'
import { XpLineSection } from '../../../components/stats/charts'
import {
  HouseholdCompletionBar,
  HouseholdXpMultiLine,
} from '../../../components/household/charts'
import { MembersOnlyUpsell } from '../../../components/membership/MembersOnlyUpsell'
import { findGame } from '../../../games/registry'

export const Route = createFileRoute('/_authenticated/weekly-summary/')({
  component: WeeklySummaryPage,
})

type SummaryData = Extract<
  Awaited<ReturnType<typeof getWeeklySummaryFn>>,
  { gated: false }
>

function WeeklySummaryPage() {
  const query = useQuery({
    queryKey: ['weekly-summary'],
    queryFn: () => getWeeklySummaryFn(),
  })
  const data = query.data

  return (
    <main className="page-wrap space-y-6 px-4 py-8">
      <header>
        <p className="island-kicker mb-1">Weekly summary</p>
        <h1 className="display-title text-4xl font-bold text-[var(--sea-ink)]">
          {data && !data.gated
            ? `Week of ${data.summary.weekStartLabel}–${data.summary.weekEndLabel}`
            : 'Your week, recapped'}
        </h1>
        <p className="mt-2 text-sm text-[var(--sea-ink-soft)]">
          A recap of the week just finished. This is exactly what lands in your
          Monday email if you turn it on in{' '}
          <Link to="/settings" className="underline">
            settings
          </Link>
          .
        </p>
      </header>

      {query.isLoading || !data ? (
        <p className="text-[var(--sea-ink-soft)]">Loading…</p>
      ) : data.gated ? (
        <GatedCard />
      ) : (
        <SummaryBody data={data} />
      )}
    </main>
  )
}

function GatedCard() {
  const [open, setOpen] = useState(false)
  return (
    <section className="island-shell rounded-2xl p-6">
      <h2 className="display-title mb-1 text-xl font-bold text-[var(--sea-ink)]">
        The weekly summary is a members feature
      </h2>
      <p className="mb-4 text-sm text-[var(--sea-ink-soft)]">
        Get a Monday-morning recap of your completions, streaks, habits, arcade
        runs, and how you stack up against friends — topped with a short AI
        review of how the week went and one nudge for the next one.
      </p>
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="rounded-full bg-[var(--btn-primary-bg)] px-5 py-2.5 text-sm font-semibold text-[var(--btn-primary-fg)]"
      >
        Upgrade to unlock
      </button>
      <MembersOnlyUpsell
        open={open}
        onClose={() => setOpen(false)}
        headline="Weekly summaries are a members feature"
        subline="Members get the weekly recap email and page, plus the full arcade, AI Coach voices, and the Garden."
      />
    </section>
  )
}

function SummaryBody({ data }: { data: SummaryData }) {
  const { summary, analysis } = data
  const k = summary.kpis
  return (
    <>
      <EmailToggleCard />
      <AnalysisCard analysis={analysis} />

      <div className="grid gap-3 sm:grid-cols-2 md:grid-cols-4">
        <KpiCard
          label="Completions"
          value={k.completionsThisWeek}
          delta={k.completionsThisWeek - k.completionsLastWeek}
          unit=""
        />
        <KpiCard
          label="XP earned"
          value={k.xpThisWeek}
          delta={k.xpThisWeek - k.xpLastWeek}
          unit="XP"
        />
        <StatCard
          label="Current streak"
          value={`${k.currentStreak}d`}
          hint={`longest ${k.longestStreak}d`}
        />
        <StatCard
          label="Tokens"
          value={k.tokens}
          hint={`level ${k.level} · ${k.totalXp} XP`}
        />
      </div>

      <XpLineSection data={summary.xpByDay} label="XP this week" />
      <WeekdayBar counts={k.byWeekday} />

      <TopTasksSection tasks={summary.topTasks} />
      <RepeatingSection rows={summary.repeatingTasks} />
      <ArcadeSection arcade={summary.arcade} />
      <LeaderboardSection rows={summary.leaderboard} />
      {summary.household ? (
        <HouseholdSection household={summary.household} />
      ) : null}
    </>
  )
}

function EmailToggleCard() {
  const qc = useQueryClient()
  const profileQuery = useQuery({
    queryKey: ['profile'],
    queryFn: () => getProfile(),
  })
  const optedIn = profileQuery.data?.weeklyEmailOptIn ?? false
  const setOptIn = useMutation({
    mutationFn: (weeklyEmailOptIn: boolean) =>
      updatePrefs({ data: { weeklyEmailOptIn } }),
    onSuccess: (_d, v) => {
      qc.invalidateQueries({ queryKey: ['profile'] })
      toast.success(v ? 'Weekly email on.' : 'Weekly email off.')
    },
    onError: (err) =>
      toast.error(err instanceof Error ? err.message : 'Update failed'),
  })

  return (
    <label className="island-shell flex cursor-pointer items-center justify-between gap-3 rounded-2xl p-4">
      <span className="flex-1">
        <span className="block text-sm font-semibold text-[var(--sea-ink)]">
          Email me this every Monday
        </span>
        <span className="block text-xs text-[var(--sea-ink-soft)]">
          Sent around 8am your time. You can also manage this in settings.
        </span>
      </span>
      <button
        type="button"
        role="switch"
        aria-checked={optedIn}
        aria-label="Email me the weekly summary"
        disabled={setOptIn.isPending || profileQuery.isLoading}
        onClick={() => setOptIn.mutate(!optedIn)}
        className={`relative inline-flex h-6 w-11 shrink-0 cursor-pointer items-center rounded-full border transition disabled:opacity-60 ${
          optedIn
            ? 'border-[var(--lagoon-deep)] bg-[rgba(79,184,178,0.5)]'
            : 'border-[var(--line)] bg-[var(--option-bg)]'
        }`}
      >
        <span
          aria-hidden
          className={`inline-block h-4 w-4 transform rounded-full bg-white shadow transition ${
            optedIn ? 'translate-x-6' : 'translate-x-1'
          }`}
        />
      </button>
    </label>
  )
}

function AnalysisCard({
  analysis,
}: {
  analysis: SummaryData['analysis']
}) {
  const qc = useQueryClient()
  const regenerate = useMutation({
    mutationFn: () => regenerateWeeklyAnalysisFn(),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['weekly-summary'] }),
    onError: (err) =>
      toast.error(err instanceof Error ? err.message : 'Could not regenerate'),
  })

  if (!analysis && !regenerate.isPending) {
    return (
      <section className="island-shell rounded-2xl p-4">
        <header className="mb-2 flex items-baseline justify-between gap-3">
          <h2 className="text-sm font-bold text-[var(--sea-ink)]">
            Your week in review
          </h2>
          <RegenerateButton regenerate={regenerate} />
        </header>
        <p className="text-sm text-[var(--sea-ink-soft)]">
          No AI review available right now. Try regenerating, or check the LLM
          connection.
        </p>
      </section>
    )
  }

  return (
    <section className="island-shell rounded-2xl p-5">
      <header className="mb-2 flex items-baseline justify-between gap-3">
        <h2 className="text-sm font-bold text-[var(--sea-ink)]">
          Your week in review
        </h2>
        <RegenerateButton regenerate={regenerate} />
      </header>
      {regenerate.isPending ? (
        <p className="text-sm text-[var(--sea-ink-soft)]">Thinking…</p>
      ) : (
        <p className="whitespace-pre-line text-[15px] leading-relaxed text-[var(--sea-ink)]">
          {analysis?.analysis}
        </p>
      )}
    </section>
  )
}

function RegenerateButton({
  regenerate,
}: {
  regenerate: { mutate: () => void; isPending: boolean }
}) {
  return (
    <button
      type="button"
      onClick={() => regenerate.mutate()}
      disabled={regenerate.isPending}
      className="rounded-full border border-[var(--line)] bg-[var(--option-bg)] px-3 py-1 text-xs font-semibold text-[var(--sea-ink-soft)] transition hover:text-[var(--sea-ink)] disabled:opacity-60"
    >
      {regenerate.isPending ? 'Regenerating…' : 'Regenerate now'}
    </button>
  )
}

function KpiCard({
  label,
  value,
  delta,
  unit,
}: {
  label: string
  value: number
  delta: number
  unit: string
}) {
  const deltaLabel =
    delta === 0
      ? 'same as last week'
      : `${delta > 0 ? '+' : '−'}${Math.abs(delta)}${unit ? ` ${unit}` : ''} vs last week`
  const tone =
    delta > 0
      ? 'text-[var(--lagoon-deep)]'
      : delta < 0
        ? 'text-[var(--sea-ink-soft)]'
        : 'text-[var(--sea-ink-soft)]'
  return (
    <div className="island-shell rounded-2xl p-4">
      <div className="text-xs uppercase tracking-wide text-[var(--sea-ink-soft)]">
        {label}
      </div>
      <div className="mt-1 text-2xl font-bold text-[var(--sea-ink)]">
        {value}
        {unit ? <span className="ml-1 text-sm font-semibold">{unit}</span> : null}
      </div>
      <div className={`mt-1 text-xs font-semibold ${tone}`}>{deltaLabel}</div>
    </div>
  )
}

function StatCard({
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

// Mon..Sun bar chart for the subject week (kpis.byWeekday is Mon-first).
function WeekdayBar({ counts }: { counts: number[] }) {
  const labels = ['M', 'T', 'W', 'T', 'F', 'S', 'S']
  const full = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun']
  const max = counts.reduce((a, b) => Math.max(a, b), 0) || 1
  return (
    <section className="island-shell rounded-2xl p-4">
      <header className="mb-3">
        <h2 className="text-sm font-bold text-[var(--sea-ink)]">By weekday</h2>
      </header>
      <div className="flex items-end gap-1.5">
        {counts.map((count, i) => {
          const h = Math.max(6, (count / max) * 96)
          return (
            <div
              key={i}
              className="flex min-w-0 flex-1 flex-col items-center gap-1"
              title={`${full[i]}: ${count}`}
            >
              <span className="text-[10px] font-semibold text-[var(--sea-ink-soft)]">
                {count}
              </span>
              <div
                className="w-full rounded-t-md bg-[var(--lagoon-deep)]"
                style={{ height: `${h}px` }}
              />
              <span className="text-[10px] text-[var(--sea-ink-soft)]">
                {labels[i]}
              </span>
            </div>
          )
        })}
      </div>
    </section>
  )
}

function TopTasksSection({
  tasks,
}: {
  tasks: SummaryData['summary']['topTasks']
}) {
  return (
    <section className="island-shell rounded-2xl p-4">
      <header className="mb-3">
        <h2 className="text-sm font-bold text-[var(--sea-ink)]">
          Most-completed this week
        </h2>
      </header>
      {tasks.length === 0 ? (
        <p className="text-sm text-[var(--sea-ink-soft)]">
          No completions this week.
        </p>
      ) : (
        <ol className="space-y-2">
          {tasks.map((t, i) => (
            <li
              key={`${t.taskId}-${i}`}
              className="flex items-center gap-3 rounded-xl border border-[var(--line)] bg-[var(--option-bg)] p-3"
            >
              <span className="flex h-6 w-6 flex-shrink-0 items-center justify-center rounded-full bg-[var(--btn-primary-bg)] text-xs font-bold text-[var(--btn-primary-fg)]">
                {i + 1}
              </span>
              <span className="min-w-0 flex-1 truncate text-sm font-semibold text-[var(--sea-ink)]">
                {t.title}
              </span>
              <span className="text-xs font-semibold text-[var(--sea-ink-soft)]">
                {t.count}×
              </span>
            </li>
          ))}
        </ol>
      )}
    </section>
  )
}

function RepeatingSection({
  rows,
}: {
  rows: SummaryData['summary']['repeatingTasks']
}) {
  return (
    <section className="island-shell rounded-2xl p-4">
      <header className="mb-3">
        <h2 className="text-sm font-bold text-[var(--sea-ink)]">
          Repeating habits
        </h2>
        <p className="mt-1 text-xs text-[var(--sea-ink-soft)]">
          All-time completions, with this week in focus.
        </p>
      </header>
      {rows.length === 0 ? (
        <p className="text-sm text-[var(--sea-ink-soft)]">
          No repeating tasks yet. Set a task to recur to build a habit streak.
        </p>
      ) : (
        <ul className="space-y-2">
          {rows.map((r) => (
            <li
              key={r.taskId}
              className="flex items-center gap-3 rounded-xl border border-[var(--line)] bg-[var(--option-bg)] p-3"
            >
              <span className="min-w-0 flex-1 truncate text-sm font-semibold text-[var(--sea-ink)]">
                {r.title}
              </span>
              <span className="flex-shrink-0 text-xs font-semibold text-[var(--lagoon-deep)]">
                {r.thisWeekCount}× this week
              </span>
              <span className="flex-shrink-0 text-xs text-[var(--sea-ink-soft)]">
                {r.allTimeCount} all-time
              </span>
            </li>
          ))}
        </ul>
      )}
    </section>
  )
}

function ArcadeSection({
  arcade,
}: {
  arcade: SummaryData['summary']['arcade']
}) {
  const played = arcade.personal.filter((g) => g.played > 0)
  return (
    <section className="space-y-3">
      <header className="flex items-baseline justify-between gap-3">
        <h2 className="text-lg font-bold text-[var(--sea-ink)]">Arcade</h2>
        <Link
          to="/arcade"
          className="text-xs font-semibold text-[var(--lagoon-deep)] underline"
        >
          Play →
        </Link>
      </header>

      {played.length === 0 ? (
        <p className="text-sm text-[var(--sea-ink-soft)]">
          No games played yet. Spend a few tokens in the arcade.
        </p>
      ) : (
        <div className="island-shell overflow-x-auto rounded-2xl">
          <table className="min-w-full text-left text-sm">
            <thead className="border-b border-[var(--line)] bg-[var(--option-bg)] text-xs uppercase tracking-wide text-[var(--sea-ink-soft)]">
              <tr>
                <th className="px-3 py-2">Game</th>
                <th className="px-3 py-2">Played</th>
                <th className="px-3 py-2">Won</th>
                <th className="px-3 py-2">Best</th>
              </tr>
            </thead>
            <tbody>
              {played.map((g) => (
                <tr
                  key={g.gameId}
                  className="border-b border-[var(--line)] last:border-none"
                >
                  <td className="px-3 py-2 font-semibold text-[var(--sea-ink)]">
                    {findGame(g.gameId)?.name ?? g.gameId}
                  </td>
                  <td className="px-3 py-2">{g.played}</td>
                  <td className="px-3 py-2">{g.won}</td>
                  <td className="px-3 py-2 text-[var(--sea-ink-soft)]">
                    {g.bestScore ?? '—'}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {arcade.friendBests.length > 0 ? (
        <div className="island-shell rounded-2xl p-4">
          <h3 className="mb-2 text-sm font-bold text-[var(--sea-ink)]">
            Friends' best scores
          </h3>
          <ul className="space-y-1.5">
            {arcade.friendBests.map((f) => (
              <li
                key={`${f.gameId}-${f.handle}`}
                className="flex items-baseline justify-between gap-2 text-xs"
              >
                <span className="text-[var(--sea-ink)]">
                  <span className="font-semibold">
                    {findGame(f.gameId.split(':')[0])?.name ?? f.gameId}
                  </span>{' '}
                  · {f.name}
                </span>
                <span className="tabular-nums text-[var(--sea-ink-soft)]">
                  {f.bestScore}
                </span>
              </li>
            ))}
          </ul>
        </div>
      ) : null}
    </section>
  )
}

function LeaderboardSection({
  rows,
}: {
  rows: SummaryData['summary']['leaderboard']
}) {
  if (rows.length <= 1) {
    return (
      <section className="island-shell rounded-2xl p-4">
        <header className="mb-2">
          <h2 className="text-sm font-bold text-[var(--sea-ink)]">
            Friends leaderboard
          </h2>
        </header>
        <p className="text-sm text-[var(--sea-ink-soft)]">
          Add friends to see how your week's XP stacks up.{' '}
          <Link to="/friends" className="underline">
            Find friends →
          </Link>
        </p>
      </section>
    )
  }
  return (
    <section className="island-shell rounded-2xl p-4">
      <header className="mb-3 flex items-baseline justify-between gap-3">
        <h2 className="text-sm font-bold text-[var(--sea-ink)]">
          Friends leaderboard
        </h2>
        <p className="text-xs text-[var(--sea-ink-soft)]">XP · last 7 days</p>
      </header>
      <ol className="space-y-1.5">
        {rows.map((r) => (
          <li
            key={r.userId}
            className={`flex items-center gap-3 rounded-xl border p-2.5 text-sm ${
              r.isMe
                ? 'border-[var(--lagoon-deep)] bg-[rgba(79,184,178,0.12)]'
                : 'border-[var(--line)] bg-[var(--option-bg)]'
            }`}
          >
            <span className="flex h-6 w-6 flex-shrink-0 items-center justify-center rounded-full bg-[var(--btn-primary-bg)] text-xs font-bold text-[var(--btn-primary-fg)]">
              {r.rank}
            </span>
            <span className="min-w-0 flex-1 truncate font-semibold text-[var(--sea-ink)]">
              {r.isMe ? 'You' : r.name || `@${r.handle}`}
            </span>
            <span className="flex-shrink-0 tabular-nums text-[var(--sea-ink-soft)]">
              {r.value} XP
            </span>
          </li>
        ))}
      </ol>
    </section>
  )
}

function HouseholdSection({
  household,
}: {
  household: NonNullable<SummaryData['summary']['household']>
}) {
  return (
    <section className="space-y-3">
      <header className="flex items-baseline justify-between gap-3">
        <h2 className="text-lg font-bold text-[var(--sea-ink)]">
          {household.name}
        </h2>
        <Link
          to="/household"
          className="text-xs font-semibold text-[var(--lagoon-deep)] underline"
        >
          Open →
        </Link>
      </header>
      <HouseholdCompletionBar
        members={household.stats.members}
        totalCompletions={household.stats.totalCompletions}
        title="Chores this week"
      />
      <HouseholdXpMultiLine
        members={household.stats.members}
        dateKeys={household.stats.dateKeys}
        label="XP this week per family member"
      />
    </section>
  )
}
