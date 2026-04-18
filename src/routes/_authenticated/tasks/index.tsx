import { Link, createFileRoute } from '@tanstack/react-router'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { deleteTask, listAllTasks } from '../../../server/functions/tasks'
import type { Recurrence } from '../../../domain/recurrence'
import { xpLabel } from '../../../lib/xp-label'

export const Route = createFileRoute('/_authenticated/tasks/')({
  component: AllTasksPage,
})

type TaskRow = Awaited<ReturnType<typeof listAllTasks>>[number]

function AllTasksPage() {
  const qc = useQueryClient()

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
    onError: (_err, _id, ctx) => {
      if (ctx?.prev) qc.setQueryData(['tasks'], ctx.prev)
    },
    onSettled: () => {
      qc.invalidateQueries({ queryKey: ['tasks'] })
      qc.invalidateQueries({ queryKey: ['today'] })
    },
  })

  const tasks = tasksQuery.data ?? []

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

      {tasksQuery.isLoading ? (
        <p className="text-[var(--sea-ink-soft)]">Loading…</p>
      ) : tasks.length === 0 ? (
        <p className="text-[var(--sea-ink-soft)]">
          No tasks yet.{' '}
          <Link to="/tasks/new" className="font-semibold">
            Create one
          </Link>
          .
        </p>
      ) : (
        <ul className="space-y-2">
          {tasks.map((t) => (
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
