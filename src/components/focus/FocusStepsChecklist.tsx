import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { listTaskSteps, toggleTaskStep } from '../../server/functions/taskSteps'

// Focus-time subtask checklist. Read-only in structure — you can only
// tick steps off, not add/rename/reorder (that lives in the task editor,
// TaskStepsSection). Shares the ['taskSteps', taskId, instanceId] query
// key with TaskContextCard so both dedupe on one fetch.
export function FocusStepsChecklist({
  taskId,
  instanceId,
}: {
  taskId: string
  instanceId: string | null
}) {
  const qc = useQueryClient()
  const stepsQuery = useQuery({
    queryKey: ['taskSteps', taskId, instanceId],
    queryFn: () =>
      listTaskSteps({ data: { taskId, instanceId: instanceId ?? null } }),
  })

  const toggleMut = useMutation({
    mutationFn: (stepId: string) =>
      toggleTaskStep({ data: { stepId, instanceId: instanceId ?? '' } }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['taskSteps', taskId] })
      qc.invalidateQueries({ queryKey: ['today'] })
      qc.invalidateQueries({ queryKey: ['progression'] })
    },
  })

  const steps = stepsQuery.data ?? []
  if (steps.length === 0) return null

  const completedCount = steps.filter((s) => s.completedAt).length
  const hasInstance = !!instanceId

  return (
    <section className="w-full max-w-sm">
      <div className="mb-2 flex items-baseline justify-between">
        <p className="text-[10px] font-semibold uppercase tracking-wide text-[var(--kicker)]">
          Steps
        </p>
        <p className="text-[11px] font-semibold text-[var(--sea-ink-soft)]">
          {completedCount} / {steps.length}
        </p>
      </div>
      <ul className="space-y-1">
        {steps.map((step) => {
          const checked = !!step.completedAt
          return (
            <li
              key={step.id}
              className="flex items-center gap-2 rounded-lg border border-[var(--line)] bg-[var(--option-bg)] px-2 py-1.5"
            >
              <input
                type="checkbox"
                checked={checked}
                disabled={!hasInstance || toggleMut.isPending}
                onChange={() => toggleMut.mutate(step.id)}
                className="h-4 w-4 cursor-pointer accent-[var(--lagoon-deep)]"
                aria-label={`Toggle ${step.title}`}
              />
              <span
                className={`min-w-0 flex-1 text-left text-sm ${
                  checked
                    ? 'text-[var(--sea-ink-soft)] line-through'
                    : 'text-[var(--sea-ink)]'
                }`}
              >
                {step.title}
              </span>
              {checked && step.xpEarned ? (
                <span className="text-[10px] font-semibold text-[var(--lagoon-deep)]">
                  +{step.xpEarned}
                </span>
              ) : null}
            </li>
          )
        })}
      </ul>
    </section>
  )
}
