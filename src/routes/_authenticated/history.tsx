import { createFileRoute } from '@tanstack/react-router'
import { useQuery } from '@tanstack/react-query'
import { listCompletionHistory } from '../../server/functions/tasks'

export const Route = createFileRoute('/_authenticated/history')({
  component: HistoryPage,
})

function HistoryPage() {
  const query = useQuery({
    queryKey: ['history', 30],
    queryFn: () => listCompletionHistory({ data: { days: 30 } }),
  })

  const days = query.data ?? []
  const totalXp = days.reduce((acc, d) => acc + d.totalXp, 0)
  const totalItems = days.reduce((acc, d) => acc + d.items.length, 0)

  return (
    <main className="page-wrap space-y-6 px-4 py-8">
      <header>
        <p className="island-kicker mb-1">History</p>
        <h1 className="display-title text-4xl font-bold text-[var(--sea-ink)]">
          Last 30 days
        </h1>
        {query.isLoading ? null : (
          <p className="mt-2 text-sm text-[var(--sea-ink-soft)]">
            {totalItems} completions · {totalXp} XP earned · {days.length}{' '}
            active {days.length === 1 ? 'day' : 'days'}.
          </p>
        )}
      </header>

      {query.isLoading ? (
        <p className="text-[var(--sea-ink-soft)]">Loading…</p>
      ) : days.length === 0 ? (
        <p className="text-[var(--sea-ink-soft)]">
          Nothing in the last 30 days. Go complete something.
        </p>
      ) : (
        <ol className="space-y-6">
          {days.map((day) => (
            <li key={day.date}>
              <header className="mb-2 flex items-baseline justify-between gap-3">
                <h2 className="text-lg font-bold text-[var(--sea-ink)]">
                  {formatDayLabel(day.date)}
                </h2>
                <span className="text-xs font-semibold text-[var(--lagoon-deep)]">
                  +{day.totalXp} XP · {day.items.length} done
                </span>
              </header>
              <ul className="space-y-1">
                {day.items.map((item) => (
                  <li
                    key={item.instanceId}
                    className="island-shell flex items-center gap-3 rounded-xl p-3"
                  >
                    <span className="flex h-6 w-6 flex-shrink-0 items-center justify-center rounded-full border-2 border-[var(--lagoon-deep)] bg-[rgba(79,184,178,0.14)] text-xs font-bold text-[var(--lagoon-deep)]">
                      ✓
                    </span>
                    <div className="min-w-0 flex-1">
                      <p className="truncate text-sm text-[var(--sea-ink)]">
                        {item.title}
                      </p>
                      <p className="text-xs text-[var(--sea-ink-soft)]">
                        {formatTime(item.completedAt)} · +{item.xp} XP
                      </p>
                    </div>
                  </li>
                ))}
              </ul>
            </li>
          ))}
        </ol>
      )}
    </main>
  )
}

function formatDayLabel(iso: string): string {
  // iso is YYYY-MM-DD (user-local via server)
  const d = new Date(iso + 'T00:00:00')
  const today = new Date()
  today.setHours(0, 0, 0, 0)
  const diff = Math.round((today.getTime() - d.getTime()) / 86_400_000)
  if (diff === 0) return 'Today'
  if (diff === 1) return 'Yesterday'
  if (diff < 7) {
    return d.toLocaleDateString(undefined, { weekday: 'long' })
  }
  return d.toLocaleDateString(undefined, {
    month: 'short',
    day: 'numeric',
    year: d.getFullYear() !== new Date().getFullYear() ? 'numeric' : undefined,
  })
}

function formatTime(iso: string): string {
  return new Date(iso).toLocaleTimeString(undefined, {
    hour: 'numeric',
    minute: '2-digit',
  })
}
