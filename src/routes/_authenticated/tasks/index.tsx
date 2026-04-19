import { useMemo, useState } from 'react'
import { Link, createFileRoute } from '@tanstack/react-router'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { toast } from 'sonner'
import { deleteTask, listAllTasks } from '../../../server/functions/tasks'
import type { Recurrence } from '../../../domain/recurrence'
import { xpLabel } from '../../../lib/xp-label'
import { SortSelect } from '../../../components/SortSelect'
import { TASKS_SORTS, compareBy, useStoredSort } from '../../../lib/sort'

export const Route = createFileRoute('/_authenticated/tasks/')({
  component: AllTasksPage,
})

type TaskRow = Awaited<ReturnType<typeof listAllTasks>>[number]

function AllTasksPage() {
  const qc = useQueryClient()
  const [selected, setSelected] = useState<Set<string>>(() => new Set())

  const tasksQuery = useQuery({
    queryKey: ['tasks'],
    queryFn: () => listAllTasks(),
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

  const tasks = tasksQuery.data ?? []

  const allTags = useMemo(() => {
    const counts = new Map<string, number>()
    for (const t of tasks) {
      for (const tag of t.tags ?? []) {
        counts.set(tag, (counts.get(tag) ?? 0) + 1)
      }
    }
    return Array.from(counts.entries()).sort((a, b) => {
      if (b[1] !== a[1]) return b[1] - a[1]
      return a[0].localeCompare(b[0])
    })
  }, [tasks])

  const [sortKey, setSortKey] = useStoredSort(
    'todo-xp-sort-tasks',
    TASKS_SORTS,
    'created-desc',
  )

  const filtered = useMemo(() => {
    const base =
      selected.size === 0
        ? tasks
        : tasks.filter((t) => {
            const tagSet = new Set(t.tags ?? [])
            for (const s of selected) {
              if (!tagSet.has(s)) return false
            }
            return true
          })
    return [...base].sort(compareBy(sortKey))
  }, [tasks, selected, sortKey])

  function toggleTag(tag: string) {
    setSelected((prev) => {
      const next = new Set(prev)
      if (next.has(tag)) next.delete(tag)
      else next.add(tag)
      return next
    })
  }

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

      <div className="mb-3 flex items-center justify-end">
        <SortSelect value={sortKey} options={TASKS_SORTS} onChange={setSortKey} />
      </div>

      {allTags.length > 0 ? (
        <div className="mb-5 flex flex-wrap items-center gap-2">
          <span className="text-xs font-semibold uppercase tracking-wide text-[var(--kicker)]">
            Tags
          </span>
          {allTags.map(([tag, count]) => {
            const isOn = selected.has(tag)
            return (
              <button
                key={tag}
                type="button"
                onClick={() => toggleTag(tag)}
                className={`rounded-full border px-3 py-1 text-xs font-semibold transition ${
                  isOn
                    ? 'border-[var(--lagoon-deep)] bg-[rgba(79,184,178,0.2)] text-[var(--lagoon-deep)]'
                    : 'border-[var(--line)] bg-[var(--option-bg)] text-[var(--sea-ink-soft)] hover:bg-[var(--option-bg-hover)]'
                }`}
              >
                {tag}
                <span className="ml-1 text-[10px] opacity-70">{count}</span>
              </button>
            )
          })}
          {selected.size > 0 ? (
            <button
              type="button"
              onClick={() => setSelected(new Set())}
              className="rounded-full px-3 py-1 text-xs font-semibold text-[var(--sea-ink-soft)] underline-offset-2 hover:underline"
            >
              Clear
            </button>
          ) : null}
        </div>
      ) : null}

      {tasksQuery.isLoading ? (
        <p className="text-[var(--sea-ink-soft)]">Loading…</p>
      ) : filtered.length === 0 ? (
        <p className="text-[var(--sea-ink-soft)]">
          {selected.size > 0 ? (
            <>No tasks match the selected tags.</>
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
          {filtered.map((t) => (
            <li
              key={t.id}
              className="island-shell flex items-center gap-3 rounded-xl p-3"
            >
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
                  {t.tags && t.tags.length > 0 ? (
                    <>
                      {' • '}
                      <span className="font-mono">
                        {t.tags.map((tag) => `#${tag}`).join(' ')}
                      </span>
                    </>
                  ) : null}
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
          ))}
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
