import { useMemo, useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { categoryCounts } from '../server/functions/tasks'
import { listCategories } from '../server/functions/categories'

type Scope = 'active' | 'completed'

interface Bar {
  slug: string | null
  label: string
  color: string
  count: number
}

/** Reorder bars so the tallest sits near the center and heights taper to
 *  each side — a "bell curve" shape. */
function toBellOrder(bars: Bar[]): Bar[] {
  const sorted = [...bars].sort((a, b) => b.count - a.count)
  const n = sorted.length
  const result = new Array<Bar>(n)
  const center = Math.floor(n / 2)
  let pos = 0
  result[center] = sorted[pos++]
  for (let off = 1; off <= Math.ceil(n / 2) && pos < n; off++) {
    if (center + off < n && pos < n) result[center + off] = sorted[pos++]
    if (center - off >= 0 && pos < n) result[center - off] = sorted[pos++]
  }
  return result.filter(Boolean)
}

export function CategoryHistogram() {
  const [scope, setScope] = useState<Scope>('active')

  const countsQuery = useQuery({
    queryKey: ['category-counts', scope],
    queryFn: () => categoryCounts({ data: { scope } }),
  })

  const categoriesQuery = useQuery({
    queryKey: ['categories'],
    queryFn: () => listCategories(),
  })

  const bars = useMemo<Bar[]>(() => {
    if (!countsQuery.data || !categoriesQuery.data) return []
    const countBySlug = new Map<string | null, number>()
    for (const c of countsQuery.data) countBySlug.set(c.slug, c.count)
    const list: Bar[] = categoriesQuery.data.map((cat) => ({
      slug: cat.slug,
      label: cat.label,
      color: cat.color,
      count: countBySlug.get(cat.slug) ?? 0,
    }))
    const uncategorized = countBySlug.get(null) ?? 0
    if (uncategorized > 0) {
      list.push({
        slug: null,
        label: 'Uncategorized',
        color: '#8f8f8f',
        count: uncategorized,
      })
    }
    return toBellOrder(list.filter((b) => b.count > 0))
  }, [countsQuery.data, categoriesQuery.data])

  const max = bars.reduce((acc, b) => Math.max(acc, b.count), 0)
  const total = bars.reduce((acc, b) => acc + b.count, 0)

  return (
    <section className="island-shell mb-5 rounded-2xl p-4">
      <header className="mb-3 flex items-center justify-between gap-3">
        <div>
          <h2 className="text-sm font-bold text-[var(--sea-ink)]">
            By category
          </h2>
          <p className="text-xs text-[var(--sea-ink-soft)]">
            {total} {scope === 'active' ? 'active' : 'completed in 30d'}
          </p>
        </div>
        <div
          className="flex gap-1 rounded-full border border-[var(--line)] bg-[var(--option-bg)] p-1"
          role="radiogroup"
          aria-label="Scope"
        >
          <ScopeButton
            on={scope === 'active'}
            onClick={() => setScope('active')}
          >
            Active
          </ScopeButton>
          <ScopeButton
            on={scope === 'completed'}
            onClick={() => setScope('completed')}
          >
            Completed (30d)
          </ScopeButton>
        </div>
      </header>

      {bars.length === 0 ? (
        <p className="py-6 text-center text-xs text-[var(--sea-ink-soft)]">
          {countsQuery.isLoading ? 'Loading…' : 'No data for this scope yet.'}
        </p>
      ) : (
        <div className="flex items-end gap-1.5">
          {bars.map((b) => {
            // Render bars in concrete pixels so the percentage-height trap
            // (flex-column parents with auto height) doesn't collapse them.
            const BAR_MAX_PX = 96
            const MIN_PX = 6
            const barHeight =
              max === 0 ? MIN_PX : Math.max((b.count / max) * BAR_MAX_PX, MIN_PX)
            return (
              <div
                key={b.slug ?? 'uncategorized'}
                className="flex min-w-0 flex-1 flex-col items-center gap-1"
                title={`${b.label}: ${b.count}`}
              >
                <span className="text-[10px] font-semibold text-[var(--sea-ink-soft)]">
                  {b.count}
                </span>
                <div
                  className="w-full rounded-t-md"
                  style={{
                    height: `${barHeight}px`,
                    backgroundColor: b.color,
                  }}
                />
                <span
                  className="max-w-full truncate text-[10px] text-[var(--sea-ink-soft)]"
                  title={b.label}
                >
                  {b.label}
                </span>
              </div>
            )
          })}
        </div>
      )}
    </section>
  )
}

function ScopeButton({
  on,
  onClick,
  children,
}: {
  on: boolean
  onClick: () => void
  children: React.ReactNode
}) {
  return (
    <button
      type="button"
      role="radio"
      aria-checked={on}
      onClick={onClick}
      className={`rounded-full px-2.5 py-0.5 text-[11px] font-semibold transition ${
        on
          ? 'bg-[var(--btn-primary-bg)] text-[var(--btn-primary-fg)]'
          : 'text-[var(--sea-ink-soft)] hover:text-[var(--sea-ink)]'
      }`}
    >
      {children}
    </button>
  )
}
