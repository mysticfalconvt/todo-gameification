import { useMemo } from 'react'
import { useQuery } from '@tanstack/react-query'
import { getTask } from '../../server/functions/tasks'
import { listTaskSteps } from '../../server/functions/taskSteps'
import { listCategories } from '../../server/functions/categories'
import { baseXp } from '../../lib/xp-label'

// Compact task summary shown across the focus phases: category chip, XP
// reward, step progress, and notes. Self-fetches so focus.tsx stays thin;
// query keys match the Today/task-detail pages so results are cached.
export function TaskContextCard({
  taskId,
  instanceId,
  fallbackTitle,
  compact = false,
}: {
  taskId: string | null
  instanceId: string | null
  // Shown while getTask is loading, or when no taskId is available (e.g.
  // a pocket resume where we only have the title from search params).
  fallbackTitle?: string
  compact?: boolean
}) {
  const taskQuery = useQuery({
    queryKey: ['task', taskId],
    queryFn: () => getTask({ data: { taskId: taskId! } }),
    enabled: !!taskId,
  })
  const stepsQuery = useQuery({
    queryKey: ['taskSteps', taskId, instanceId],
    queryFn: () =>
      listTaskSteps({ data: { taskId: taskId!, instanceId: instanceId ?? null } }),
    enabled: !!taskId,
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

  const task = taskQuery.data
  const title = task?.title ?? fallbackTitle
  if (!title) return null

  const cat = task?.categorySlug ? catBySlug.get(task.categorySlug) : undefined
  const xp = task ? baseXp(task.difficulty, task.xpOverride) : null
  const steps = stepsQuery.data ?? []
  const stepsTotal = steps.length
  const stepsDone = steps.filter((s) => s.completedAt).length

  return (
    <section className="island-shell w-full max-w-sm rounded-2xl p-4 text-left">
      <div
        className={`font-semibold text-[var(--sea-ink)] ${
          compact ? 'text-base' : 'text-lg'
        }`}
      >
        {title}
      </div>

      <div className="mt-2 flex flex-wrap items-center gap-2 text-[11px] font-semibold">
        {cat ? (
          <span
            className="inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[var(--sea-ink)]"
            style={{ backgroundColor: `${cat.color}33` }}
          >
            <span
              className="h-2 w-2 rounded-full"
              style={{ backgroundColor: cat.color }}
            />
            {cat.label}
          </span>
        ) : null}
        {xp != null ? (
          <span className="text-[var(--lagoon-deep)]">+{xp} XP</span>
        ) : null}
        {stepsTotal > 0 ? (
          <span className="text-[var(--sea-ink-soft)]">
            {stepsDone}/{stepsTotal} steps
          </span>
        ) : null}
      </div>

      {!compact && task?.notes ? (
        <p className="mt-2 whitespace-pre-wrap text-xs text-[var(--sea-ink-soft)]">
          {task.notes}
        </p>
      ) : null}
    </section>
  )
}
