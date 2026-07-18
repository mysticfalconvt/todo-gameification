import { useMemo } from 'react'
import { useQuery } from '@tanstack/react-query'
import { listTodayInstances } from '../../server/functions/tasks'
import { listCategories } from '../../server/functions/categories'
import { baseXp } from '../../lib/xp-label'

const MAX_ROWS = 5

// Read-only glance at what's on deck today, shown on the general (task-less)
// focus timer. Reuses the Today page's cached ['today'] + ['categories']
// queries — no new data source.
export function UpcomingTasksPreview({
  excludeInstanceId,
}: {
  excludeInstanceId?: string
}) {
  const todayQuery = useQuery({
    queryKey: ['today'],
    queryFn: () => listTodayInstances(),
  })
  const categoriesQuery = useQuery({
    queryKey: ['categories'],
    queryFn: () => listCategories(),
  })

  const catBySlug = useMemo(() => {
    const m = new Map<string, { label: string; color: string }>()
    const raw = categoriesQuery.data
    const list = Array.isArray(raw) ? raw : []
    for (const c of list) m.set(c.slug, { label: c.label, color: c.color })
    return m
  }, [categoriesQuery.data])

  const rows = useMemo(() => {
    const raw = todayQuery.data
    const list = Array.isArray(raw) ? raw : []
    return list
      .filter((i) => i.instanceId !== excludeInstanceId)
      .slice(0, MAX_ROWS)
  }, [todayQuery.data, excludeInstanceId])

  if (rows.length === 0) return null

  return (
    <section className="island-shell mb-4 rounded-2xl p-4">
      <div className="mb-2 text-xs font-semibold uppercase tracking-wide text-[var(--sea-ink-soft)]">
        Coming up today
      </div>
      <ul className="space-y-1.5">
        {rows.map((inst) => {
          const cat = inst.categorySlug
            ? catBySlug.get(inst.categorySlug)
            : undefined
          const xp = baseXp(inst.difficulty, inst.xpOverride)
          return (
            <li
              key={inst.instanceId}
              className="flex items-center gap-2 rounded-lg border border-[var(--line)] bg-[var(--option-bg)] px-2.5 py-1.5"
            >
              <span className="min-w-0 flex-1 truncate text-sm text-[var(--sea-ink)]">
                {inst.title}
              </span>
              <div className="flex flex-shrink-0 items-center gap-2 text-[11px] font-semibold">
                {inst.stepsTotal > 0 ? (
                  <span className="text-[var(--sea-ink-soft)]">
                    {inst.stepsCompleted}/{inst.stepsTotal}
                  </span>
                ) : null}
                {cat ? (
                  <span
                    className="inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[var(--sea-ink)]"
                    style={{ backgroundColor: `${cat.color}33` }}
                  >
                    <span
                      className="h-1.5 w-1.5 rounded-full"
                      style={{ backgroundColor: cat.color }}
                    />
                    {cat.label}
                  </span>
                ) : null}
                <span className="text-[var(--lagoon-deep)]">+{xp}</span>
              </div>
            </li>
          )
        })}
      </ul>
    </section>
  )
}
