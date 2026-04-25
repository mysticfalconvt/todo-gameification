import { useEffect, useRef } from 'react'
import { Link } from '@tanstack/react-router'
import { useQuery } from '@tanstack/react-query'
import { getTask, getTaskStats } from '../server/functions/tasks'
import { xpLabel } from '../lib/xp-label'
import type { Difficulty } from '../domain/events'
import type { Recurrence, DurationUnit } from '../domain/recurrence'
import { resolveDuration } from '../domain/recurrence'

export interface TaskDetailsInstance {
  taskId: string
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
