import { useEffect, useRef, useState } from 'react'
import { Link } from '@tanstack/react-router'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { toast } from 'sonner'
import { getTask, getTaskStats } from '../server/functions/tasks'
import {
  addTaskStep,
  deleteTaskStep,
  listTaskSteps,
  renameTaskStep,
  reorderTaskSteps,
  toggleTaskStep,
} from '../server/functions/taskSteps'
import { runOrQueue } from '../lib/offline-queue'
import { xpLabel } from '../lib/xp-label'
import type { Difficulty } from '../domain/events'
import type { Recurrence, DurationUnit } from '../domain/recurrence'
import { resolveDuration } from '../domain/recurrence'

export interface TaskDetailsInstance {
  taskId: string
  // The current taskInstance the user is viewing. Subtask completion
  // state is per-instance, so the dialog needs both. Null for views
  // that don't have a current instance (e.g. the someday list before
  // an instance has been picked up).
  instanceId: string | null
  title: string
  difficulty: Difficulty
  xpOverride: number | null
  categorySlug: string | null
  dueAt: string | null
  timeOfDay: string | null
}

interface Props {
  instance: TaskDetailsInstance | null
  onClose: () => void
  catBySlug: Map<string, { label: string; color: string }>
}

export function TaskDetailsDialog({ instance, onClose, catBySlug }: Props) {
  const dialogRef = useRef<HTMLDialogElement | null>(null)
  const qc = useQueryClient()

  // Drive the native <dialog> from React state. showModal gives us focus
  // trap, esc-to-close and a backdrop for free.
  useEffect(() => {
    const el = dialogRef.current
    if (!el) return
    if (instance && !el.open) {
      el.showModal()
    } else if (!instance && el.open) {
      el.close()
    }
  }, [instance])

  const taskId = instance?.taskId ?? null

  const defer = useMutation({
    mutationFn: (instanceId: string) =>
      runOrQueue({ type: 'defer', instanceId }),
    onSuccess: () => {
      toast.success('Moved to tomorrow (−30% XP)')
      qc.invalidateQueries({ queryKey: ['today'] })
      qc.invalidateQueries({ queryKey: ['someday'] })
      onClose()
    },
    onError: (err) => {
      toast.error(err instanceof Error ? err.message : 'Could not defer')
    },
  })

  const taskQuery = useQuery({
    queryKey: ['task', taskId],
    queryFn: () => getTask({ data: { taskId: taskId! } }),
    enabled: !!taskId,
  })

  const statsQuery = useQuery({
    queryKey: ['taskStats', taskId, 'all'],
    queryFn: () => getTaskStats({ data: { taskId: taskId!, days: 'all' } }),
    enabled: !!taskId,
  })

  const cat = instance?.categorySlug
    ? catBySlug.get(instance.categorySlug)
    : null

  const stats = statsQuery.data
  const task = taskQuery.data

  return (
    <dialog
      ref={dialogRef}
      onClose={onClose}
      onClick={(e) => {
        // Close on backdrop click. The dialog itself catches clicks on
        // children, so a click whose target is the dialog element means
        // the user hit the backdrop area outside the inner panel.
        if (e.target === dialogRef.current) onClose()
      }}
      className="m-auto w-[min(560px,calc(100%-1.5rem))] max-w-[100vw] rounded-2xl border border-[var(--line)] bg-[var(--surface)] p-0 text-[var(--sea-ink)] shadow-2xl backdrop:bg-black/40 backdrop:backdrop-blur-sm"
    >
      {instance ? (
        <div className="flex max-h-[85vh] flex-col">
          <header className="flex items-start gap-3 border-b border-[var(--line)] px-5 py-4">
            <div className="min-w-0 flex-1">
              <p className="island-kicker mb-1 flex items-center gap-1.5">
                {cat ? (
                  <>
                    <span
                      aria-hidden
                      className="inline-block h-2 w-2 rounded-full"
                      style={{ backgroundColor: cat.color }}
                    />
                    {cat.label}
                  </>
                ) : (
                  'Uncategorized'
                )}
              </p>
              <h2 className="display-title break-words text-2xl font-bold leading-tight text-[var(--sea-ink)]">
                {instance.title}
              </h2>
            </div>
            <button
              type="button"
              onClick={onClose}
              aria-label="Close"
              className="-mr-1 -mt-1 flex h-8 w-8 flex-shrink-0 items-center justify-center rounded-full border border-[var(--line)] bg-[var(--option-bg)] text-[var(--sea-ink-soft)] hover:text-[var(--sea-ink)]"
            >
              ✕
            </button>
          </header>

          <div className="flex-1 overflow-y-auto px-5 py-4">
            {task?.notes && task.notes.trim() ? (
              <section className="mb-4">
                <p className="mb-1 text-[10px] font-semibold uppercase tracking-wide text-[var(--kicker)]">
                  Notes
                </p>
                <p className="whitespace-pre-wrap break-words text-sm leading-relaxed text-[var(--sea-ink)]">
                  {task.notes}
                </p>
              </section>
            ) : null}

            <TaskStepsSection
              taskId={instance.taskId}
              instanceId={instance.instanceId}
            />

            <section className="mb-4 grid grid-cols-2 gap-x-4 gap-y-2 text-sm">
              <Field label="XP" value={xpLabel(instance.difficulty, instance.xpOverride)} />
              {instance.dueAt ? (
                <Field label="Due" value={dueLabel(instance.dueAt, instance.timeOfDay)} />
              ) : (
                <Field label="Due" value="Someday" />
              )}
              {instance.timeOfDay ? (
                <Field label="Time" value={formatTimeOfDay(instance.timeOfDay)} />
              ) : null}
              {task?.recurrence ? (
                <Field label="Repeats" value={describeRecurrence(task.recurrence)} />
              ) : null}
            </section>

            <section className="mb-2">
              <p className="mb-2 text-[10px] font-semibold uppercase tracking-wide text-[var(--kicker)]">
                All-time
              </p>
              <div className="grid grid-cols-2 gap-2">
                <Stat
                  label="Completions"
                  value={stats ? String(stats.completionCount) : '—'}
                />
                <Stat
                  label="Total XP"
                  value={stats ? `+${stats.totalXp}` : '—'}
                />
              </div>
            </section>

            {stats && stats.recentCompletions.length > 0 ? (
              <section className="mt-4">
                <p className="mb-2 text-[10px] font-semibold uppercase tracking-wide text-[var(--kicker)]">
                  Recent completions
                </p>
                <ul className="space-y-1">
                  {stats.recentCompletions.slice(0, 5).map((item, i) => (
                    <li
                      key={item.instanceId ?? `${item.occurredAt}-${i}`}
                      className="flex items-center justify-between gap-3 rounded-lg border border-[var(--line)] bg-[var(--option-bg)] px-3 py-2 text-xs"
                    >
                      <span className="text-[var(--sea-ink)]">
                        {formatDateTime(item.occurredAt)}
                      </span>
                      <span className="font-semibold text-[var(--lagoon-deep)]">
                        +{item.xp} XP
                      </span>
                    </li>
                  ))}
                </ul>
              </section>
            ) : null}
          </div>

          <footer className="flex flex-wrap items-center justify-end gap-2 border-t border-[var(--line)] px-5 py-3">
            {instance.dueAt && instance.instanceId ? (
              <button
                type="button"
                onClick={() => defer.mutate(instance.instanceId!)}
                disabled={defer.isPending}
                className="mr-auto rounded-full border border-[var(--line)] bg-[var(--option-bg)] px-3 py-1.5 text-xs font-semibold text-[var(--sea-ink-soft)] hover:text-[var(--sea-ink)] disabled:opacity-60"
              >
                🌅 Tomorrow (−30% XP)
              </button>
            ) : null}
            <Link
              to="/stats/task/$taskId"
              params={{ taskId: instance.taskId }}
              onClick={onClose}
              className="rounded-full border border-[var(--line)] bg-[var(--option-bg)] px-3 py-1.5 text-xs font-semibold text-[var(--sea-ink-soft)] no-underline hover:text-[var(--sea-ink)]"
            >
              📊 Stats
            </Link>
            <Link
              to="/tasks/$taskId"
              params={{ taskId: instance.taskId }}
              onClick={onClose}
              className="rounded-full border border-[rgba(50,143,151,0.3)] bg-[rgba(79,184,178,0.14)] px-3 py-1.5 text-xs font-semibold text-[var(--lagoon-deep)] no-underline"
            >
              ✎ Edit
            </Link>
          </footer>
        </div>
      ) : null}
    </dialog>
  )
}

function TaskStepsSection({
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

  const [newTitle, setNewTitle] = useState('')
  const [editingId, setEditingId] = useState<string | null>(null)
  const [editTitle, setEditTitle] = useState('')

  function refresh() {
    qc.invalidateQueries({ queryKey: ['taskSteps', taskId] })
    qc.invalidateQueries({ queryKey: ['today'] })
    qc.invalidateQueries({ queryKey: ['someday'] })
    qc.invalidateQueries({ queryKey: ['progression'] })
  }

  const addMut = useMutation({
    mutationFn: (title: string) => addTaskStep({ data: { taskId, title } }),
    onSuccess: () => {
      setNewTitle('')
      refresh()
    },
  })

  const toggleMut = useMutation({
    mutationFn: (stepId: string) =>
      toggleTaskStep({
        data: { stepId, instanceId: instanceId ?? '' },
      }),
    onSuccess: refresh,
  })

  const renameMut = useMutation({
    mutationFn: (vars: { stepId: string; title: string }) =>
      renameTaskStep({ data: vars }),
    onSuccess: () => {
      setEditingId(null)
      setEditTitle('')
      refresh()
    },
  })

  const reorderMut = useMutation({
    mutationFn: (orderedIds: string[]) =>
      reorderTaskSteps({ data: { taskId, orderedIds } }),
    onSuccess: refresh,
  })

  const deleteMut = useMutation({
    mutationFn: (stepId: string) => deleteTaskStep({ data: { stepId } }),
    onSuccess: refresh,
  })

  const steps = stepsQuery.data ?? []
  const completedCount = steps.filter((s) => s.completedAt).length
  const hasInstance = !!instanceId

  function move(index: number, dir: -1 | 1) {
    const next = [...steps]
    const target = index + dir
    if (target < 0 || target >= next.length) return
    const [moved] = next.splice(index, 1)
    next.splice(target, 0, moved)
    reorderMut.mutate(next.map((s) => s.id))
  }

  return (
    <section className="mb-4">
      <div className="mb-2 flex items-baseline justify-between">
        <p className="text-[10px] font-semibold uppercase tracking-wide text-[var(--kicker)]">
          Steps
        </p>
        {steps.length > 0 ? (
          <p className="text-[11px] font-semibold text-[var(--sea-ink-soft)]">
            {completedCount} / {steps.length}
          </p>
        ) : null}
      </div>

      {steps.length > 0 ? (
        <ul className="space-y-1">
          {steps.map((step, i) => {
            const checked = !!step.completedAt
            const isEditing = editingId === step.id
            return (
              <li
                key={step.id}
                className="group flex items-center gap-2 rounded-lg border border-[var(--line)] bg-[var(--option-bg)] px-2 py-1.5"
              >
                <input
                  type="checkbox"
                  checked={checked}
                  disabled={!hasInstance || toggleMut.isPending}
                  onChange={() => toggleMut.mutate(step.id)}
                  className="h-4 w-4 cursor-pointer accent-[var(--lagoon-deep)]"
                  aria-label={`Toggle ${step.title}`}
                />
                {isEditing ? (
                  <input
                    type="text"
                    value={editTitle}
                    onChange={(e) => setEditTitle(e.target.value)}
                    onBlur={() => {
                      if (editTitle.trim() && editTitle.trim() !== step.title) {
                        renameMut.mutate({
                          stepId: step.id,
                          title: editTitle.trim(),
                        })
                      } else {
                        setEditingId(null)
                      }
                    }}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter') {
                        e.currentTarget.blur()
                      } else if (e.key === 'Escape') {
                        setEditingId(null)
                      }
                    }}
                    autoFocus
                    className="field-input min-w-0 flex-1 px-2 py-1 text-sm"
                  />
                ) : (
                  <button
                    type="button"
                    onClick={() => {
                      setEditingId(step.id)
                      setEditTitle(step.title)
                    }}
                    className={`min-w-0 flex-1 cursor-text bg-transparent text-left text-sm ${
                      checked
                        ? 'text-[var(--sea-ink-soft)] line-through'
                        : 'text-[var(--sea-ink)]'
                    }`}
                  >
                    {step.title}
                  </button>
                )}
                {checked && step.xpEarned ? (
                  <span className="text-[10px] font-semibold text-[var(--lagoon-deep)]">
                    +{step.xpEarned}
                  </span>
                ) : null}
                <div className="flex items-center gap-0.5 opacity-60 group-hover:opacity-100">
                  <button
                    type="button"
                    onClick={() => move(i, -1)}
                    disabled={i === 0 || reorderMut.isPending}
                    aria-label="Move up"
                    className="flex h-5 w-5 items-center justify-center rounded text-[var(--sea-ink-soft)] hover:bg-[var(--option-bg-hover)] disabled:opacity-30"
                  >
                    ↑
                  </button>
                  <button
                    type="button"
                    onClick={() => move(i, 1)}
                    disabled={i === steps.length - 1 || reorderMut.isPending}
                    aria-label="Move down"
                    className="flex h-5 w-5 items-center justify-center rounded text-[var(--sea-ink-soft)] hover:bg-[var(--option-bg-hover)] disabled:opacity-30"
                  >
                    ↓
                  </button>
                  <button
                    type="button"
                    onClick={() => deleteMut.mutate(step.id)}
                    disabled={deleteMut.isPending}
                    aria-label={`Delete ${step.title}`}
                    className="flex h-5 w-5 items-center justify-center rounded text-[var(--sea-ink-soft)] hover:bg-red-100 hover:text-red-600"
                  >
                    ✕
                  </button>
                </div>
              </li>
            )
          })}
        </ul>
      ) : null}

      <form
        onSubmit={(e) => {
          e.preventDefault()
          const trimmed = newTitle.trim()
          if (!trimmed) return
          addMut.mutate(trimmed)
        }}
        className="mt-2 flex items-center gap-2"
      >
        <input
          type="text"
          value={newTitle}
          onChange={(e) => setNewTitle(e.target.value)}
          placeholder="+ Add step"
          className="field-input min-w-0 flex-1 px-2 py-1 text-sm"
        />
        <button
          type="submit"
          disabled={!newTitle.trim() || addMut.isPending}
          className="rounded-full border border-[rgba(50,143,151,0.3)] bg-[rgba(79,184,178,0.14)] px-3 py-1 text-xs font-semibold text-[var(--lagoon-deep)] disabled:opacity-50"
        >
          Add
        </button>
      </form>
    </section>
  )
}

function Field({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <p className="text-[10px] font-semibold uppercase tracking-wide text-[var(--kicker)]">
        {label}
      </p>
      <p className="mt-0.5 break-words text-[var(--sea-ink)]">{value}</p>
    </div>
  )
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="island-shell rounded-xl p-3">
      <p className="text-[10px] font-semibold uppercase tracking-wide text-[var(--sea-ink-soft)]">
        {label}
      </p>
      <p className="mt-0.5 text-lg font-bold text-[var(--sea-ink)]">{value}</p>
    </div>
  )
}

function dueLabel(dueAt: string, timeOfDay: string | null): string {
  const d = new Date(dueAt)
  const now = new Date()
  const dayMs = 86_400_000
  const label =
    d.toDateString() === now.toDateString()
      ? 'Today'
      : d.getTime() - now.getTime() < dayMs
        ? 'Today'
        : d.getTime() - now.getTime() < 2 * dayMs
          ? 'Tomorrow'
          : d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' })
  if (!timeOfDay) return `${label} (anytime)`
  const hhmm = d.toLocaleTimeString(undefined, {
    hour: 'numeric',
    minute: '2-digit',
  })
  return `${label} ${hhmm}`
}

function formatTimeOfDay(hhmm: string): string {
  const [hStr, mStr] = hhmm.split(':')
  const h = Number.parseInt(hStr ?? '', 10)
  const m = Number.parseInt(mStr ?? '', 10)
  if (!Number.isFinite(h) || !Number.isFinite(m)) return hhmm
  const d = new Date()
  d.setHours(h, m, 0, 0)
  return d.toLocaleTimeString(undefined, {
    hour: 'numeric',
    minute: '2-digit',
  })
}

function formatDateTime(iso: string): string {
  return new Date(iso).toLocaleString(undefined, {
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  })
}

const WEEKDAY_NAMES = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']

function unitLabel(amount: number, unit: DurationUnit): string {
  const base = unit === 'minutes' ? 'minute' : unit === 'hours' ? 'hour' : 'day'
  return amount === 1 ? base : `${base}s`
}

function describeRecurrence(r: Recurrence): string {
  if (r.type === 'daily') return 'Every day'
  if (r.type === 'weekly') {
    const days = [...r.daysOfWeek].sort((a, b) => a - b)
    if (days.length === 7) return 'Every day'
    return days.map((d) => WEEKDAY_NAMES[d] ?? '').join(', ')
  }
  if (r.type === 'interval') {
    const { amount, unit } = resolveDuration(r)
    return `Every ${amount} ${unitLabel(amount, unit)}`
  }
  const { amount, unit } = resolveDuration(r)
  return `${amount} ${unitLabel(amount, unit)} after done`
}
