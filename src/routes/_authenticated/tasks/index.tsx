import { useMemo, useState } from 'react'
import { Link, createFileRoute } from '@tanstack/react-router'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { toast } from 'sonner'
import { deleteTask, listAllTasks } from '../../../server/functions/tasks'
import { listCategories } from '../../../server/functions/categories'
import type { Recurrence } from '../../../domain/recurrence'
import { xpLabel } from '../../../lib/xp-label'
import { SortSelect } from '../../../components/SortSelect'
import { CategoryHistogram } from '../../../components/CategoryHistogram'
import { TASKS_SORTS, compareBy, useStoredSort } from '../../../lib/sort'

export const Route = createFileRoute('/_authenticated/tasks/')({
  component: AllTasksPage,
})

type TaskRow = Awaited<ReturnType<typeof listAllTasks>>[number]
type Category = Awaited<ReturnType<typeof listCategories>>[number]

const UNCATEGORIZED = '__uncategorized__'

function AllTasksPage() {
  const qc = useQueryClient()
  const [selectedCategory, setSelectedCategory] = useState<string | null>(null)
  const [search, setSearch] = useState('')

  const tasksQuery = useQuery({
    queryKey: ['tasks'],
    queryFn: () => listAllTasks(),
  })

  const categoriesQuery = useQuery({
    queryKey: ['categories'],
    queryFn: () => listCategories(),
  })

  const remove = useMutation({
    mutationFn: (taskId: string) => deleteTask({ data: { taskId } }),
    onMutate: async (taskId) => {
      await qc.cancelQueries({ queryKey: ['tasks'] })
      const prev = qc.getQueryData<TaskRow[]>(['tasks'])
      qc.setQueryData<TaskRow[]>(['tasks'], (old) =>
        old?.filter((t) => t.id !== taskId),
      )
      return { prev }
    },
    onError: (err, _id, ctx) => {
      if (ctx?.prev) qc.setQueryData(['tasks'], ctx.prev)
      toast.error(err instanceof Error ? err.message : 'Delete failed')
    },
    onSettled: () => {
      qc.invalidateQueries({ queryKey: ['tasks'] })
      qc.invalidateQueries({ queryKey: ['today'] })
    },
  })

  const tasks = Array.isArray(tasksQuery.data) ? tasksQuery.data : []
  const categories = Array.isArray(categoriesQuery.data) ? categoriesQuery.data : []

  const catBySlug = useMemo(() => {
    const m = new Map<string, Category>()
    for (const c of categories) m.set(c.slug, c)
    return m
  }, [categories])

  const categoryCounts = useMemo(() => {
    const counts = new Map<string, number>()
    let uncategorized = 0
    for (const t of tasks) {
      if (t.categorySlug) {
        counts.set(t.categorySlug, (counts.get(t.categorySlug) ?? 0) + 1)
      } else {
        uncategorized += 1
      }
    }
    return { counts, uncategorized }
  }, [tasks])

  const [sortKey, setSortKey] = useStoredSort(
    'todo-xp-sort-tasks',
    TASKS_SORTS,
    'created-desc',
  )

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase()
    const base = tasks.filter((t) => {
      if (
        selectedCategory === UNCATEGORIZED
          ? t.categorySlug !== null
          : selectedCategory !== null && t.categorySlug !== selectedCategory
      ) {
        return false
      }
      if (q && !t.title.toLowerCase().includes(q)) return false
      return true
    })
    return [...base].sort(compareBy(sortKey))
  }, [tasks, selectedCategory, sortKey, search])

  return (
    <main className="page-wrap px-4 py-8">
      <div className="mb-6 flex items-center justify-between gap-3">
        <h1 className="display-title text-4xl font-bold text-[var(--sea-ink)]">
          All tasks
        </h1>
        <Link
          to="/tasks/new"
          className="rounded-full border border-[rgba(50,143,151,0.3)] bg-[rgba(79,184,178,0.14)] px-4 py-2 text-sm font-semibold text-[var(--lagoon-deep)] no-underline"
        >
          + New task
        </Link>
      </div>

      <CategoryHistogram />

      <div className="mb-3 flex flex-wrap items-center gap-3">
        <input
          type="search"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="Search tasks…"
          className="field-input flex-1 min-w-[12rem]"
        />
        <SortSelect value={sortKey} options={TASKS_SORTS} onChange={setSortKey} />
      </div>

      {categories.length > 0 ? (
        <div className="mb-5 flex flex-wrap items-center gap-2">
          <button
            type="button"
            onClick={() => setSelectedCategory(null)}
            className={`rounded-full border px-3 py-1 text-xs font-semibold transition ${
              selectedCategory === null
                ? 'border-[var(--lagoon-deep)] bg-[rgba(79,184,178,0.2)] text-[var(--lagoon-deep)]'
                : 'border-[var(--line)] bg-[var(--option-bg)] text-[var(--sea-ink-soft)] hover:bg-[var(--option-bg-hover)]'
            }`}
          >
            All
            <span className="ml-1 text-[10px] opacity-70">{tasks.length}</span>
          </button>
          {categories.map((c) => {
            const count = categoryCounts.counts.get(c.slug) ?? 0
            const on = selectedCategory === c.slug
            return (
              <button
                key={c.slug}
                type="button"
                onClick={() => setSelectedCategory(on ? null : c.slug)}
                className={`inline-flex items-center gap-1.5 rounded-full border px-3 py-1 text-xs font-semibold transition ${
                  on
                    ? 'border-[var(--lagoon-deep)] bg-[rgba(79,184,178,0.2)] text-[var(--lagoon-deep)]'
                    : 'border-[var(--line)] bg-[var(--option-bg)] text-[var(--sea-ink-soft)] hover:bg-[var(--option-bg-hover)]'
                }`}
              >
                <span
                  aria-hidden
                  className="inline-block h-2 w-2 rounded-full"
                  style={{ backgroundColor: c.color }}
                />
                {c.label}
                <span className="text-[10px] opacity-70">{count}</span>
              </button>
            )
          })}
          {categoryCounts.uncategorized > 0 ? (
            <button
              type="button"
              onClick={() =>
                setSelectedCategory(
                  selectedCategory === UNCATEGORIZED ? null : UNCATEGORIZED,
                )
              }
              className={`rounded-full border px-3 py-1 text-xs font-semibold transition ${
                selectedCategory === UNCATEGORIZED
                  ? 'border-[var(--lagoon-deep)] bg-[rgba(79,184,178,0.2)] text-[var(--lagoon-deep)]'
                  : 'border-[var(--line)] bg-[var(--option-bg)] text-[var(--sea-ink-soft)]'
              }`}
            >
              Uncategorized
              <span className="ml-1 text-[10px] opacity-70">
                {categoryCounts.uncategorized}
              </span>
            </button>
          ) : null}
        </div>
      ) : null}

      {tasksQuery.isLoading ? (
        <p className="text-[var(--sea-ink-soft)]">Loading…</p>
      ) : filtered.length === 0 ? (
        <p className="text-[var(--sea-ink-soft)]">
          {selectedCategory ? (
            <>No tasks in this category.</>
          ) : (
            <>
              No tasks yet.{' '}
              <Link to="/tasks/new" className="font-semibold">
                Create one
              </Link>
              .
            </>
          )}
        </p>
      ) : (
        <ul className="space-y-2">
          {filtered.map((t) => {
            const cat = t.categorySlug ? catBySlug.get(t.categorySlug) : null
            return (
              <li
                key={t.id}
                className="island-shell flex items-center gap-3 rounded-xl p-3"
              >
                <span
                  aria-hidden
                  title={cat?.label ?? 'Uncategorized'}
                  className="h-3 w-3 flex-shrink-0 rounded-full"
                  style={{ backgroundColor: cat?.color ?? 'transparent', border: cat ? 'none' : '1px dashed var(--line)' }}
                />
                <Link
                  to="/tasks/$taskId"
                  params={{ taskId: t.id }}
                  className="min-w-0 flex-1 no-underline"
                >
                  <p className="truncate font-semibold text-[var(--sea-ink)]">
                    {t.title}
                  </p>
                  <p className="text-xs text-[var(--sea-ink-soft)]">
                    {xpLabel(t.difficulty, t.xpOverride)}
                    {' • '}
                    {recurrenceLabel(t.recurrence)}
                    {cat ? ` • ${cat.label}` : ''}
                  </p>
                </Link>
                <Link
                  to="/tasks/$taskId"
                  params={{ taskId: t.id }}
                  className="rounded-full border border-[var(--line)] bg-[var(--option-bg)] px-3 py-1 text-xs font-semibold text-[var(--sea-ink-soft)] no-underline"
                >
                  Edit
                </Link>
                <button
                  type="button"
                  aria-label={`Delete ${t.title}`}
                  onClick={() => {
                    if (confirm(`Delete "${t.title}"?`)) {
                      remove.mutate(t.id)
                    }
                  }}
                  className="rounded-full border border-[var(--line)] bg-[var(--option-bg)] px-3 py-1 text-xs font-semibold text-[var(--sea-ink-soft)] transition hover:text-red-600"
                >
                  Delete
                </button>
              </li>
            )
          })}
        </ul>
      )}
    </main>
  )
}

function recurrenceLabel(r: Recurrence | null) {
  if (!r) return 'One-off'
  switch (r.type) {
    case 'daily':
      return 'Daily'
    case 'weekly':
      return r.daysOfWeek.length === 7
        ? 'Every day'
        : `Weekly (${r.daysOfWeek.length}d)`
    case 'interval':
      return `Every ${r.days} days`
    case 'after_completion':
      return `${r.days}d after done`
  }
}
