import { useEffect, useState } from 'react'
import {
  createFileRoute,
  useNavigate,
  useParams,
} from '@tanstack/react-router'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import {
  deleteTask,
  getTask,
  reanalyzeTask,
  snoozeTask,
  updateTask,
} from '../../../server/functions/tasks'
import { listCategories } from '../../../server/functions/categories'
import { getLlmStatus } from '../../../server/functions/config'
import type { Recurrence } from '../../../domain/recurrence'
import type { Difficulty } from '../../../domain/events'
import type { TaskVisibility } from '../../../server/services/tasks'

export const Route = createFileRoute('/_authenticated/tasks/$taskId')({
  loader: async ({ params }) => {
    const [task, llmStatus] = await Promise.all([
      getTask({ data: { taskId: params.taskId } }),
      getLlmStatus(),
    ])
    return { task, llmStatus }
  },
  component: EditTaskPage,
})

type RecurrenceKind = 'none' | 'daily' | 'weekly_daily' | 'after_completion'
type DueKind = 'someday' | 'anytime' | 'timed'

function recurrenceToKind(r: Recurrence | null): {
  kind: RecurrenceKind
  afterDays: number
} {
  if (!r) return { kind: 'none', afterDays: 7 }
  if (r.type === 'daily') return { kind: 'daily', afterDays: 7 }
  if (r.type === 'weekly' && r.daysOfWeek.length === 7) {
    return { kind: 'weekly_daily', afterDays: 7 }
  }
  if (r.type === 'after_completion') {
    return { kind: 'after_completion', afterDays: r.days }
  }
  return { kind: 'none', afterDays: 7 }
}

function buildRecurrence(
  kind: RecurrenceKind,
  afterDays: number,
): Recurrence | null {
  switch (kind) {
    case 'none':
      return null
    case 'daily':
      return { type: 'daily' }
    case 'weekly_daily':
      return { type: 'weekly', daysOfWeek: [0, 1, 2, 3, 4, 5, 6] }
    case 'after_completion':
      return { type: 'after_completion', days: afterDays }
  }
}

function EditTaskPage() {
  const { taskId } = useParams({ from: '/_authenticated/tasks/$taskId' })
  const navigate = useNavigate()
  const qc = useQueryClient()
  const loaderData = Route.useLoaderData()

  const taskQuery = useQuery({
    queryKey: ['task', taskId],
    queryFn: () => getTask({ data: { taskId } }),
    initialData: loaderData.task,
  })

  const llmEnabled = loaderData.llmStatus.enabled

  const [title, setTitle] = useState('')
  const [notes, setNotes] = useState('')
  const [difficulty, setDifficulty] = useState<Difficulty>('medium')
  const [kind, setKind] = useState<RecurrenceKind>('none')
  const [afterDays, setAfterDays] = useState(7)
  const [dueKind, setDueKind] = useState<DueKind>('anytime')
  const [timeOfDay, setTimeOfDay] = useState('08:00')
  const [visibility, setVisibility] = useState<TaskVisibility>('friends')
  const [error, setError] = useState<string | null>(null)
  const [loadedFor, setLoadedFor] = useState<string | null>(null)

  useEffect(() => {
    const t = taskQuery.data
    if (!t || loadedFor === t.id) return
    setTitle(t.title)
    setNotes(t.notes ?? '')
    setDifficulty(t.difficulty)
    const rc = recurrenceToKind(t.recurrence)
    setKind(rc.kind)
    setAfterDays(rc.afterDays)
    if (t.timeOfDay) {
      setDueKind('timed')
      setTimeOfDay(t.timeOfDay)
    } else {
      // We can't distinguish "someday" from "anytime today" from task row alone
      // (that distinction lives on the current instance's dueAt). Default to
      // 'anytime'; user can switch to 'someday' if desired.
      setDueKind('anytime')
    }
    setVisibility(t.visibility)
    setLoadedFor(t.id)
  }, [taskQuery.data, loadedFor])

  const isSomeday = dueKind === 'someday'
  const recurrenceKind = isSomeday ? 'none' : kind

  const save = useMutation({
    mutationFn: (input: {
      taskId: string
      title: string
      notes: string | null
      difficulty: Difficulty
      recurrence: Recurrence | null
      timeOfDay: string | null
      visibility: TaskVisibility
    }) => updateTask({ data: input }),
    onSuccess: async () => {
      await qc.invalidateQueries({ queryKey: ['tasks'] })
      await qc.invalidateQueries({ queryKey: ['today'] })
      await qc.invalidateQueries({ queryKey: ['someday'] })
      await qc.invalidateQueries({ queryKey: ['task', taskId] })
      navigate({ to: '/tasks' })
    },
    onError: (err) => {
      setError(err instanceof Error ? err.message : 'Failed to save')
    },
  })

  const reanalyze = useMutation({
    mutationFn: () => reanalyzeTask({ data: { taskId } }),
    onSuccess: async () => {
      await qc.invalidateQueries({ queryKey: ['task', taskId] })
      await qc.invalidateQueries({ queryKey: ['tasks'] })
      await qc.invalidateQueries({ queryKey: ['today'] })
      await qc.invalidateQueries({ queryKey: ['someday'] })
    },
    onError: (err) => {
      setError(err instanceof Error ? err.message : 'Failed to re-analyze')
    },
  })

  const categoriesQuery = useQuery({
    queryKey: ['categories'],
    queryFn: () => listCategories(),
  })
  const categories = Array.isArray(categoriesQuery.data) ? categoriesQuery.data : []
  const currentCategory =
    categories.find((c) => c.slug === taskQuery.data?.categorySlug) ?? null

  const snooze = useMutation({
    mutationFn: (until: string | null) =>
      snoozeTask({ data: { taskId, until } }),
    onSuccess: async () => {
      await qc.invalidateQueries({ queryKey: ['task', taskId] })
      await qc.invalidateQueries({ queryKey: ['tasks'] })
      await qc.invalidateQueries({ queryKey: ['today'] })
      await qc.invalidateQueries({ queryKey: ['someday'] })
    },
    onError: (err) => {
      setError(err instanceof Error ? err.message : 'Failed to snooze task')
    },
  })

  const remove = useMutation({
    mutationFn: () => deleteTask({ data: { taskId } }),
    onSuccess: async () => {
      await qc.invalidateQueries({ queryKey: ['tasks'] })
      await qc.invalidateQueries({ queryKey: ['today'] })
      await qc.invalidateQueries({ queryKey: ['someday'] })
      navigate({ to: '/tasks' })
    },
    onError: (err) => {
      setError(err instanceof Error ? err.message : 'Failed to delete')
    },
  })

  function onSubmit(e: React.FormEvent) {
    e.preventDefault()
    setError(null)
    save.mutate({
      taskId,
      title,
      notes: notes.trim() ? notes : null,
      difficulty,
      recurrence: isSomeday
        ? null
        : buildRecurrence(recurrenceKind, afterDays),
      timeOfDay: dueKind === 'timed' ? timeOfDay : null,
      visibility,
    })
  }

  if (taskQuery.isLoading) {
    return (
      <main className="page-wrap px-4 py-8">
        <p className="text-[var(--sea-ink-soft)]">Loading…</p>
      </main>
    )
  }

  if (taskQuery.isError || !taskQuery.data) {
    return (
      <main className="page-wrap px-4 py-8">
        <p className="text-red-600">Task not found.</p>
      </main>
    )
  }

  const task = taskQuery.data

  return (
    <main className="page-wrap px-4 py-8">
      <h1 className="display-title mb-6 text-4xl font-bold text-[var(--sea-ink)]">
        Edit task
      </h1>

      <form onSubmit={onSubmit} className="island-shell max-w-xl space-y-5 rounded-2xl p-6">
        <label className="block">
          <span className="mb-1 block text-xs font-semibold uppercase tracking-wide text-[var(--kicker)]">
            Title
          </span>
          <input
            type="text"
            required
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            className="field-input"
          />
        </label>

        <label className="block">
          <span className="mb-1 block text-xs font-semibold uppercase tracking-wide text-[var(--kicker)]">
            Notes
          </span>
          <textarea
            value={notes}
            onChange={(e) => setNotes(e.target.value)}
            rows={3}
            className="field-input"
          />
        </label>

        {llmEnabled ? (
          <div className="rounded-xl border border-[var(--line)] bg-[var(--option-bg)] p-3">
            <div className="flex flex-wrap items-center justify-between gap-3">
              <div className="min-w-0 flex-1 space-y-2">
                <div>
                  <p className="text-xs font-semibold uppercase tracking-wide text-[var(--kicker)]">
                    Current XP
                  </p>
                  <p className="text-sm text-[var(--sea-ink)]">
                    {task.xpOverride ?? '—'}
                    {reanalyze.data?.scored ? (
                      <span className="ml-2 text-xs text-[var(--sea-ink-soft)]">
                        ({reanalyze.data.scored.tier})
                      </span>
                    ) : null}
                  </p>
                </div>
                <div>
                  <p className="text-xs font-semibold uppercase tracking-wide text-[var(--kicker)]">
                    Category
                  </p>
                  {currentCategory ? (
                    <p className="inline-flex items-center gap-1.5 text-sm text-[var(--sea-ink)]">
                      <span
                        aria-hidden
                        className="inline-block h-2 w-2 rounded-full"
                        style={{ backgroundColor: currentCategory.color }}
                      />
                      {currentCategory.label}
                    </p>
                  ) : (
                    <p className="text-sm text-[var(--sea-ink-soft)]">
                      Uncategorized
                    </p>
                  )}
                </div>
              </div>
              <button
                type="button"
                onClick={() => reanalyze.mutate()}
                disabled={reanalyze.isPending}
                className="rounded-full border border-[var(--line)] bg-[var(--option-bg-hover)] px-3 py-1 text-xs font-semibold text-[var(--sea-ink-soft)] disabled:opacity-60"
              >
                {reanalyze.isPending ? 'Re-analyzing…' : 'Re-analyze with AI'}
              </button>
            </div>
          </div>
        ) : (
          <label className="block">
            <span className="mb-1 block text-xs font-semibold uppercase tracking-wide text-[var(--kicker)]">
              Difficulty
            </span>
            <select
              value={difficulty}
              onChange={(e) => setDifficulty(e.target.value as Difficulty)}
              className="field-input"
            >
              <option value="small">Small — 10 XP</option>
              <option value="medium">Medium — 25 XP</option>
              <option value="large">Large — 60 XP</option>
            </select>
          </label>
        )}

        <fieldset>
          <legend className="mb-2 block text-xs font-semibold uppercase tracking-wide text-[var(--kicker)]">
            When
          </legend>
          <div className="space-y-2">
            <DueOption
              current={dueKind}
              value="someday"
              onChange={setDueKind}
              label="Someday"
              detail="No deadline. Just there until you get to it."
            />
            <DueOption
              current={dueKind}
              value="anytime"
              onChange={setDueKind}
              label="Today — anytime"
              detail="Due today, no specific hour."
            />
            <DueOption
              current={dueKind}
              value="timed"
              onChange={setDueKind}
              label="At a specific time"
              detail="Punctuality multiplier applies."
            />
          </div>
          {dueKind === 'timed' ? (
            <div className="mt-3">
              <input
                type="time"
                required
                value={timeOfDay}
                onChange={(e) => setTimeOfDay(e.target.value)}
                className="field-input max-w-[10rem]"
              />
            </div>
          ) : null}
          <p className="mt-2 text-xs text-[var(--sea-ink-soft)]">
            Changes affect future instances. The current open instance keeps its
            existing due time.
          </p>
        </fieldset>

        <label className={`block ${isSomeday ? 'opacity-50' : ''}`}>
          <span className="mb-1 block text-xs font-semibold uppercase tracking-wide text-[var(--kicker)]">
            Recurrence
          </span>
          <select
            value={recurrenceKind}
            onChange={(e) => setKind(e.target.value as RecurrenceKind)}
            disabled={isSomeday}
            className="field-input"
          >
            <option value="none">One-off</option>
            <option value="daily">Every day</option>
            <option value="weekly_daily">Every day of the week</option>
            <option value="after_completion">N days after last done</option>
          </select>
        </label>

        {recurrenceKind === 'after_completion' && !isSomeday ? (
          <label className="block">
            <span className="mb-1 block text-xs font-semibold uppercase tracking-wide text-[var(--kicker)]">
              Days after completion
            </span>
            <input
              type="number"
              min={1}
              value={afterDays}
              onChange={(e) => setAfterDays(Number(e.target.value))}
              className="field-input"
            />
          </label>
        ) : null}

        <label className="block">
          <span className="mb-1 block text-xs font-semibold uppercase tracking-wide text-[var(--kicker)]">
            Who can see this
          </span>
          <select
            value={visibility}
            onChange={(e) => setVisibility(e.target.value as TaskVisibility)}
            className="field-input"
          >
            <option value="private">Private — just me</option>
            <option value="friends">Friends — shown in activity feed</option>
            <option value="public">
              Public — shown on my profile
            </option>
          </select>
        </label>

        <fieldset className="rounded-xl border border-[var(--line)] p-3">
          <legend className="px-2 text-xs font-semibold uppercase tracking-wide text-[var(--kicker)]">
            Snooze task
          </legend>
          {task.snoozeUntil ? (
            <p className="mb-2 text-sm text-[var(--sea-ink-soft)]">
              Snoozed until {new Date(task.snoozeUntil).toLocaleString()}
            </p>
          ) : (
            <p className="mb-2 text-sm text-[var(--sea-ink-soft)]">
              Hide from Today + stop reminders until a chosen date. Existing
              instances stay scheduled but won't fire.
            </p>
          )}
          <div className="flex flex-wrap gap-2">
            <SnoozeButton
              label="1 week"
              onClick={() =>
                snooze.mutate(
                  new Date(Date.now() + 7 * 24 * 3_600_000).toISOString(),
                )
              }
              disabled={snooze.isPending}
            />
            <SnoozeButton
              label="1 month"
              onClick={() =>
                snooze.mutate(
                  new Date(Date.now() + 30 * 24 * 3_600_000).toISOString(),
                )
              }
              disabled={snooze.isPending}
            />
            <SnoozeButton
              label="3 months"
              onClick={() =>
                snooze.mutate(
                  new Date(Date.now() + 90 * 24 * 3_600_000).toISOString(),
                )
              }
              disabled={snooze.isPending}
            />
            {task.snoozeUntil ? (
              <SnoozeButton
                label="Un-snooze"
                onClick={() => snooze.mutate(null)}
                disabled={snooze.isPending}
              />
            ) : null}
          </div>
        </fieldset>

        {error ? (
          <p className="text-sm text-red-600" role="alert">
            {error}
          </p>
        ) : null}

        <div className="flex items-center justify-between gap-3 pt-2">
          <button
            type="button"
            onClick={() => {
              if (confirm(`Delete "${task.title}"?`)) remove.mutate()
            }}
            disabled={remove.isPending}
            className="rounded-full border border-[var(--line)] bg-[var(--option-bg)] px-4 py-2 text-sm font-semibold text-[var(--sea-ink-soft)] transition hover:text-red-600 disabled:opacity-60"
          >
            {remove.isPending ? 'Deleting…' : 'Delete'}
          </button>
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={() => navigate({ to: '/tasks' })}
              className="rounded-full border border-[var(--line)] bg-[var(--option-bg)] px-4 py-2 text-sm font-semibold text-[var(--sea-ink-soft)]"
            >
              Cancel
            </button>
            <button
              type="submit"
              disabled={save.isPending}
              className="rounded-full border border-[rgba(50,143,151,0.3)] bg-[rgba(79,184,178,0.14)] px-5 py-2 text-sm font-semibold text-[var(--lagoon-deep)] disabled:opacity-60"
            >
              {save.isPending ? 'Saving…' : 'Save changes'}
            </button>
          </div>
        </div>
      </form>
    </main>
  )
}

function SnoozeButton({
  label,
  onClick,
  disabled,
}: {
  label: string
  onClick: () => void
  disabled?: boolean
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      className="rounded-full border border-[var(--line)] bg-[var(--option-bg)] px-3 py-1 text-xs font-semibold text-[var(--sea-ink-soft)] transition hover:text-[var(--sea-ink)] disabled:opacity-60"
    >
      {label}
    </button>
  )
}

function DueOption({
  current,
  value,
  onChange,
  label,
  detail,
}: {
  current: DueKind
  value: DueKind
  onChange: (v: DueKind) => void
  label: string
  detail: string
}) {
  const selected = current === value
  return (
    <label
      className={`flex cursor-pointer items-start gap-3 rounded-xl border p-3 transition ${
        selected
          ? 'border-[var(--lagoon-deep)] bg-[rgba(79,184,178,0.1)]'
          : 'border-[var(--line)] bg-[var(--option-bg)] hover:bg-[var(--option-bg-hover)] hover:border-[rgba(50,143,151,0.4)]'
      }`}
    >
      <input
        type="radio"
        name="due-kind"
        value={value}
        checked={selected}
        onChange={() => onChange(value)}
        className="mt-0.5"
      />
      <span className="flex-1">
        <span className="block text-sm font-semibold text-[var(--sea-ink)]">
          {label}
        </span>
        <span className="block text-xs text-[var(--sea-ink-soft)]">
          {detail}
        </span>
      </span>
    </label>
  )
}
