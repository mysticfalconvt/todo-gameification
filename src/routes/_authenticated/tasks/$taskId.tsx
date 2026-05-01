import { useEffect, useState } from 'react'
import {
  createFileRoute,
  useNavigate,
  useParams,
} from '@tanstack/react-router'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { toast } from 'sonner'
import {
  deleteTask,
  getTask,
  reanalyzeTask,
  reopenLastCompletion,
  snoozeTask,
  updateTask,
} from '../../../server/functions/tasks'
import { listCategories } from '../../../server/functions/categories'
import { getLlmStatus } from '../../../server/functions/config'
import type {
  DurationUnit,
  MonthlyWeekIndex,
  Recurrence,
} from '../../../domain/recurrence'
import { resolveDuration } from '../../../domain/recurrence'
import type { Difficulty } from '../../../domain/events'
import type { TaskVisibility } from '../../../server/services/tasks'
import { WeekdayPicker } from '../../../components/WeekdayPicker'
import { PositiveNumberInput } from '../../../components/NumberInput'

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

type RecurrenceKind =
  | 'none'
  | 'daily'
  | 'weekly'
  | 'interval'
  | 'after_completion'
  | 'monthly_day'
  | 'monthly_weekday'
type DueKind = 'someday' | 'anytime' | 'timed'

interface RecurrenceForm {
  kind: RecurrenceKind
  intervalAmount: number
  intervalUnit: DurationUnit
  afterAmount: number
  afterUnit: DurationUnit
  weekdays: number[]
  monthlyDay: number
  monthlyWeek: MonthlyWeekIndex
  monthlyDayOfWeek: number
}

const DEFAULT_FORM: RecurrenceForm = {
  kind: 'none',
  intervalAmount: 2,
  intervalUnit: 'hours',
  afterAmount: 7,
  afterUnit: 'days',
  weekdays: [1],
  monthlyDay: 1,
  monthlyWeek: 1,
  monthlyDayOfWeek: 1,
}

function recurrenceToForm(r: Recurrence | null): RecurrenceForm {
  if (!r) return DEFAULT_FORM
  if (r.type === 'daily') return { ...DEFAULT_FORM, kind: 'daily' }
  if (r.type === 'weekly') {
    // Legacy tasks saved as weekly with all seven days are semantically
    // "every day" — keep them as 'daily' so the dropdown matches the
    // cleaner option.
    if (r.daysOfWeek.length === 7) return { ...DEFAULT_FORM, kind: 'daily' }
    return {
      ...DEFAULT_FORM,
      kind: 'weekly',
      weekdays: [...r.daysOfWeek].sort((a, b) => a - b),
    }
  }
  if (r.type === 'interval') {
    const { amount, unit } = resolveDuration(r)
    return {
      ...DEFAULT_FORM,
      kind: 'interval',
      intervalAmount: amount,
      intervalUnit: unit,
    }
  }
  if (r.type === 'after_completion') {
    const { amount, unit } = resolveDuration(r)
    return {
      ...DEFAULT_FORM,
      kind: 'after_completion',
      afterAmount: amount,
      afterUnit: unit,
    }
  }
  if (r.type === 'monthly_day') {
    return {
      ...DEFAULT_FORM,
      kind: 'monthly_day',
      monthlyDay: r.dayOfMonth,
    }
  }
  if (r.type === 'monthly_weekday') {
    return {
      ...DEFAULT_FORM,
      kind: 'monthly_weekday',
      monthlyWeek: r.week,
      monthlyDayOfWeek: r.dayOfWeek,
    }
  }
  return DEFAULT_FORM
}

function buildRecurrence(f: RecurrenceForm): Recurrence | null {
  switch (f.kind) {
    case 'none':
      return null
    case 'daily':
      return { type: 'daily' }
    case 'weekly':
      return { type: 'weekly', daysOfWeek: [...f.weekdays].sort((a, b) => a - b) }
    case 'interval':
      return {
        type: 'interval',
        amount: f.intervalAmount,
        unit: f.intervalUnit,
      }
    case 'after_completion':
      return {
        type: 'after_completion',
        amount: f.afterAmount,
        unit: f.afterUnit,
      }
    case 'monthly_day':
      return { type: 'monthly_day', dayOfMonth: f.monthlyDay }
    case 'monthly_weekday':
      return {
        type: 'monthly_weekday',
        week: f.monthlyWeek,
        dayOfWeek: f.monthlyDayOfWeek,
      }
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
  const [form, setForm] = useState<RecurrenceForm>(DEFAULT_FORM)
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
    setForm(recurrenceToForm(t.recurrence))
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
  const recurrenceKind: RecurrenceKind = isSomeday ? 'none' : form.kind

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

  const reopen = useMutation({
    mutationFn: () => reopenLastCompletion({ data: { taskId } }),
    onSuccess: async () => {
      toast.success('Reopened the last completion.')
      await qc.invalidateQueries({ queryKey: ['tasks'] })
      await qc.invalidateQueries({ queryKey: ['today'] })
      await qc.invalidateQueries({ queryKey: ['someday'] })
      await qc.invalidateQueries({ queryKey: ['progression'] })
      await qc.invalidateQueries({ queryKey: ['history'] })
      await qc.invalidateQueries({ queryKey: ['garden'] })
      await qc.invalidateQueries({ queryKey: ['recent-activity'] })
    },
    onError: (err) =>
      toast.error(err instanceof Error ? err.message : 'Failed to reopen'),
  })

  function onSubmit(e: React.FormEvent) {
    e.preventDefault()
    setError(null)
    if (
      !isSomeday &&
      recurrenceKind === 'weekly' &&
      form.weekdays.length === 0
    ) {
      setError('Pick at least one day of the week.')
      return
    }
    save.mutate({
      taskId,
      title,
      notes: notes.trim() ? notes : null,
      difficulty,
      recurrence: isSomeday
        ? null
        : buildRecurrence({ ...form, kind: recurrenceKind }),
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
            onChange={(e) =>
              setForm((f) => ({
                ...f,
                kind: e.target.value as RecurrenceKind,
              }))
            }
            disabled={isSomeday}
            className="field-input"
          >
            <option value="none">One-off</option>
            <option value="daily">Every day</option>
            <option value="weekly">On specific days of the week</option>
            <option value="interval">Every N minutes / hours / days</option>
            <option value="after_completion">N after last done</option>
            <option value="monthly_day">Monthly — on a specific date</option>
            <option value="monthly_weekday">
              Monthly — on the Nth weekday
            </option>
          </select>
        </label>

        {recurrenceKind === 'weekly' && !isSomeday ? (
          <fieldset>
            <legend className="mb-1 block text-xs font-semibold uppercase tracking-wide text-[var(--kicker)]">
              Days of the week
            </legend>
            <WeekdayPicker
              value={form.weekdays}
              onChange={(w) => setForm((f) => ({ ...f, weekdays: w }))}
            />
          </fieldset>
        ) : null}

        {recurrenceKind === 'interval' && !isSomeday ? (
          <fieldset>
            <legend className="mb-1 block text-xs font-semibold uppercase tracking-wide text-[var(--kicker)]">
              Every
            </legend>
            <AmountUnitPicker
              amount={form.intervalAmount}
              unit={form.intervalUnit}
              onAmountChange={(n) =>
                setForm((f) => ({ ...f, intervalAmount: n }))
              }
              onUnitChange={(u) =>
                setForm((f) => ({ ...f, intervalUnit: u }))
              }
            />
          </fieldset>
        ) : null}

        {recurrenceKind === 'after_completion' && !isSomeday ? (
          <fieldset>
            <legend className="mb-1 block text-xs font-semibold uppercase tracking-wide text-[var(--kicker)]">
              After completion
            </legend>
            <AmountUnitPicker
              amount={form.afterAmount}
              unit={form.afterUnit}
              onAmountChange={(n) =>
                setForm((f) => ({ ...f, afterAmount: n }))
              }
              onUnitChange={(u) =>
                setForm((f) => ({ ...f, afterUnit: u }))
              }
            />
          </fieldset>
        ) : null}

        {recurrenceKind === 'monthly_day' && !isSomeday ? (
          <fieldset>
            <legend className="mb-1 block text-xs font-semibold uppercase tracking-wide text-[var(--kicker)]">
              Day of the month
            </legend>
            <MonthlyDayPicker
              value={form.monthlyDay}
              onChange={(n) => setForm((f) => ({ ...f, monthlyDay: n }))}
            />
            <p className="mt-1 text-xs text-[var(--sea-ink-soft)]">
              Months without that day (e.g. 31st in February) fire on the
              last day instead.
            </p>
          </fieldset>
        ) : null}

        {recurrenceKind === 'monthly_weekday' && !isSomeday ? (
          <fieldset>
            <legend className="mb-1 block text-xs font-semibold uppercase tracking-wide text-[var(--kicker)]">
              Which weekday each month
            </legend>
            <MonthlyWeekdayPicker
              week={form.monthlyWeek}
              dayOfWeek={form.monthlyDayOfWeek}
              onWeekChange={(w) =>
                setForm((f) => ({ ...f, monthlyWeek: w }))
              }
              onDayOfWeekChange={(d) =>
                setForm((f) => ({ ...f, monthlyDayOfWeek: d }))
              }
            />
          </fieldset>
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

        <fieldset className="rounded-xl border border-[var(--line)] p-3">
          <legend className="px-2 text-xs font-semibold uppercase tracking-wide text-[var(--kicker)]">
            Correction
          </legend>
          <p className="mb-2 text-sm text-[var(--sea-ink-soft)]">
            Checked off the wrong one? Reopen the most recent completion
            and it'll move back into your Today list. If the task is
            recurring, the speculative follow-up instance is cleaned up
            so you don't end up with duplicates. XP and streaks are
            re-computed from the event log.
          </p>
          <button
            type="button"
            onClick={() => {
              if (confirm('Reopen the most recent completion of this task?')) {
                reopen.mutate()
              }
            }}
            disabled={reopen.isPending}
            className="rounded-full border border-[var(--line)] bg-[var(--option-bg)] px-4 py-2 text-sm font-semibold text-[var(--sea-ink-soft)] disabled:opacity-60"
          >
            {reopen.isPending ? 'Reopening…' : 'Reopen last completion'}
          </button>
        </fieldset>

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

function AmountUnitPicker({
  amount,
  unit,
  onAmountChange,
  onUnitChange,
}: {
  amount: number
  unit: DurationUnit
  onAmountChange: (n: number) => void
  onUnitChange: (u: DurationUnit) => void
}) {
  return (
    <div className="flex gap-2">
      <PositiveNumberInput
        value={amount}
        onChange={onAmountChange}
        className="field-input max-w-[6rem]"
      />
      <select
        value={unit}
        onChange={(e) => onUnitChange(e.target.value as DurationUnit)}
        className="field-input max-w-[10rem]"
      >
        <option value="minutes">minutes</option>
        <option value="hours">hours</option>
        <option value="days">days</option>
      </select>
    </div>
  )
}

function MonthlyDayPicker({
  value,
  onChange,
}: {
  value: number
  onChange: (n: number) => void
}) {
  return (
    <div className="flex items-center gap-2">
      <span className="text-sm text-[var(--sea-ink-soft)]">On the</span>
      <select
        value={value}
        onChange={(e) => onChange(Number(e.target.value))}
        className="field-input max-w-[8rem]"
      >
        {Array.from({ length: 31 }, (_, i) => i + 1).map((d) => (
          <option key={d} value={d}>
            {ordinal(d)}
          </option>
        ))}
      </select>
      <span className="text-sm text-[var(--sea-ink-soft)]">of every month</span>
    </div>
  )
}

const MONTHLY_WEEK_OPTIONS: { value: MonthlyWeekIndex; label: string }[] = [
  { value: 1, label: 'First' },
  { value: 2, label: 'Second' },
  { value: 3, label: 'Third' },
  { value: 4, label: 'Fourth' },
  { value: -1, label: 'Last' },
]

const MONTHLY_DOW_OPTIONS = [
  { value: 0, label: 'Sunday' },
  { value: 1, label: 'Monday' },
  { value: 2, label: 'Tuesday' },
  { value: 3, label: 'Wednesday' },
  { value: 4, label: 'Thursday' },
  { value: 5, label: 'Friday' },
  { value: 6, label: 'Saturday' },
]

function MonthlyWeekdayPicker({
  week,
  dayOfWeek,
  onWeekChange,
  onDayOfWeekChange,
}: {
  week: MonthlyWeekIndex
  dayOfWeek: number
  onWeekChange: (w: MonthlyWeekIndex) => void
  onDayOfWeekChange: (d: number) => void
}) {
  return (
    <div className="flex flex-wrap items-center gap-2">
      <span className="text-sm text-[var(--sea-ink-soft)]">The</span>
      <select
        value={week}
        onChange={(e) =>
          onWeekChange(Number(e.target.value) as MonthlyWeekIndex)
        }
        className="field-input max-w-[8rem]"
      >
        {MONTHLY_WEEK_OPTIONS.map((o) => (
          <option key={o.value} value={o.value}>
            {o.label}
          </option>
        ))}
      </select>
      <select
        value={dayOfWeek}
        onChange={(e) => onDayOfWeekChange(Number(e.target.value))}
        className="field-input max-w-[10rem]"
      >
        {MONTHLY_DOW_OPTIONS.map((o) => (
          <option key={o.value} value={o.value}>
            {o.label}
          </option>
        ))}
      </select>
      <span className="text-sm text-[var(--sea-ink-soft)]">of every month</span>
    </div>
  )
}

function ordinal(n: number): string {
  const mod100 = n % 100
  if (mod100 >= 11 && mod100 <= 13) return `${n}th`
  switch (n % 10) {
    case 1:
      return `${n}st`
    case 2:
      return `${n}nd`
    case 3:
      return `${n}rd`
    default:
      return `${n}th`
  }
}
