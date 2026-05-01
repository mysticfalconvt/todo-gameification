import { useState } from 'react'
import { createFileRoute, useNavigate } from '@tanstack/react-router'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { createTask } from '../../../server/functions/tasks'
import { getLlmStatus } from '../../../server/functions/config'
import type {
  DurationUnit,
  MonthlyWeekIndex,
  Recurrence,
} from '../../../domain/recurrence'
import type { Difficulty } from '../../../domain/events'
import type { TaskVisibility } from '../../../server/services/tasks'
import { WeekdayPicker } from '../../../components/WeekdayPicker'
import { PositiveNumberInput } from '../../../components/NumberInput'

export const Route = createFileRoute('/_authenticated/tasks/new')({
  loader: () => getLlmStatus(),
  component: NewTaskPage,
})

type RecurrenceKind =
  | 'none'
  | 'daily'
  | 'weekly'
  | 'interval'
  | 'after_completion'
  | 'monthly_day'
  | 'monthly_weekday'
type DueKind = 'someday' | 'anytime' | 'timed' | 'in' | 'date'

interface MonthlyForm {
  dayOfMonth: number
  week: MonthlyWeekIndex
  dayOfWeek: number
}

function buildRecurrence(
  kind: RecurrenceKind,
  intervalAmount: number,
  intervalUnit: DurationUnit,
  afterAmount: number,
  afterUnit: DurationUnit,
  weekdays: number[],
  monthly: MonthlyForm,
): Recurrence | null {
  switch (kind) {
    case 'none':
      return null
    case 'daily':
      return { type: 'daily' }
    case 'weekly':
      return { type: 'weekly', daysOfWeek: [...weekdays].sort((a, b) => a - b) }
    case 'interval':
      return { type: 'interval', amount: intervalAmount, unit: intervalUnit }
    case 'after_completion':
      return {
        type: 'after_completion',
        amount: afterAmount,
        unit: afterUnit,
      }
    case 'monthly_day':
      return { type: 'monthly_day', dayOfMonth: monthly.dayOfMonth }
    case 'monthly_weekday':
      return {
        type: 'monthly_weekday',
        week: monthly.week,
        dayOfWeek: monthly.dayOfWeek,
      }
  }
}

function NewTaskPage() {
  const navigate = useNavigate()
  const qc = useQueryClient()
  const llmStatus = Route.useLoaderData()
  const llmEnabled = llmStatus.enabled
  const [title, setTitle] = useState('')
  const [notes, setNotes] = useState('')
  const [difficulty, setDifficulty] = useState<Difficulty>('medium')
  const [kind, setKind] = useState<RecurrenceKind>('none')
  const [afterAmount, setAfterAmount] = useState(7)
  const [afterUnit, setAfterUnit] = useState<DurationUnit>('days')
  const [intervalAmount, setIntervalAmount] = useState(2)
  const [intervalUnit, setIntervalUnit] = useState<DurationUnit>('hours')
  const [weekdays, setWeekdays] = useState<number[]>([1]) // default Monday
  const [monthlyDay, setMonthlyDay] = useState(1)
  const [monthlyWeek, setMonthlyWeek] = useState<MonthlyWeekIndex>(1)
  const [monthlyDayOfWeek, setMonthlyDayOfWeek] = useState(1) // Mon
  const [dueKind, setDueKind] = useState<DueKind>('anytime')
  const [timeOfDay, setTimeOfDay] = useState('08:00')
  const [inAmount, setInAmount] = useState(2)
  const [inUnit, setInUnit] = useState<'minutes' | 'hours'>('hours')
  const [dateStr, setDateStr] = useState(() => {
    // Default to a week from today in the browser's local tz.
    const d = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000)
    return d.toISOString().slice(0, 10)
  })
  const [dateTime, setDateTime] = useState('')
  const [visibility, setVisibility] = useState<TaskVisibility>('friends')
  const [steps, setSteps] = useState<string[]>([])
  const [error, setError] = useState<string | null>(null)

  const isSomeday = dueKind === 'someday'
  const recurrenceKind = isSomeday ? 'none' : kind

  const mutation = useMutation({
    mutationFn: (input: {
      title: string
      notes: string | null
      difficulty: Difficulty
      recurrence: Recurrence | null
      timeOfDay: string | null
      someday: boolean
      visibility: TaskVisibility
      dueAtOverride?: string | null
      steps?: string[] | null
    }) => createTask({ data: input }),
    onSuccess: async () => {
      await qc.invalidateQueries({ queryKey: ['today'] })
      await qc.invalidateQueries({ queryKey: ['someday'] })
      await qc.invalidateQueries({ queryKey: ['tasks'] })
      navigate({ to: '/today' })
    },
    onError: (err) => {
      setError(err instanceof Error ? err.message : 'Something went wrong')
    },
  })

  function onSubmit(e: React.FormEvent) {
    e.preventDefault()
    setError(null)
    if (
      !isSomeday &&
      recurrenceKind === 'weekly' &&
      weekdays.length === 0
    ) {
      setError('Pick at least one day of the week.')
      return
    }
    let dueAtOverride: string | null = null
    if (dueKind === 'in') {
      const ms =
        inUnit === 'minutes' ? inAmount * 60_000 : inAmount * 60 * 60_000
      dueAtOverride = new Date(Date.now() + ms).toISOString()
    } else if (dueKind === 'date') {
      // Combine the picked date with optional time in the browser's
      // local tz, then pass as ISO. If no time, anchor to 09:00 local
      // (a sensible morning default for a date-only task).
      const time = dateTime || '09:00'
      const local = new Date(`${dateStr}T${time}:00`)
      if (isNaN(local.getTime())) {
        setError('Pick a valid date.')
        return
      }
      dueAtOverride = local.toISOString()
    }
    const effectiveTimeOfDay =
      dueKind === 'timed'
        ? timeOfDay
        : dueKind === 'date' && dateTime
          ? dateTime
          : null
    const cleanedSteps = steps
      .map((s) => s.trim())
      .filter((s) => s.length > 0)
    mutation.mutate({
      title,
      notes: notes.trim() ? notes : null,
      difficulty,
      recurrence: isSomeday
        ? null
        : buildRecurrence(
            recurrenceKind,
            intervalAmount,
            intervalUnit,
            afterAmount,
            afterUnit,
            weekdays,
            {
              dayOfMonth: monthlyDay,
              week: monthlyWeek,
              dayOfWeek: monthlyDayOfWeek,
            },
          ),
      timeOfDay: effectiveTimeOfDay,
      someday: isSomeday,
      visibility,
      dueAtOverride,
      steps: cleanedSteps.length > 0 ? cleanedSteps : null,
    })
  }

  return (
    <main className="page-wrap px-4 py-8">
      <h1 className="display-title mb-6 text-4xl font-bold text-[var(--sea-ink)]">
        New task
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
            autoFocus
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
            placeholder="Optional — any details, links, or context."
            className="field-input"
          />
        </label>

        <StepsField steps={steps} onChange={setSteps} />

        {llmEnabled ? null : (
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
              detail="Due today, no specific hour. Full XP whenever you finish it."
            />
            <DueOption
              current={dueKind}
              value="timed"
              onChange={setDueKind}
              label="At a specific time"
              detail="100% XP within 1h of due; 80% later same day; 50% after."
            />
            <DueOption
              current={dueKind}
              value="in"
              onChange={setDueKind}
              label="In a bit"
              detail="Remind me N minutes or hours from now. Good for “fold laundry in 2h”."
            />
            <DueOption
              current={dueKind}
              value="date"
              onChange={setDueKind}
              label="On a specific date"
              detail="Pick any calendar date (with optional time). One-off unless you also set recurrence."
            />
          </div>
          {dueKind === 'date' ? (
            <div className="mt-3 flex flex-wrap gap-2">
              <input
                type="date"
                required
                value={dateStr}
                onChange={(e) => setDateStr(e.target.value)}
                className="field-input max-w-[12rem]"
              />
              <input
                type="time"
                value={dateTime}
                onChange={(e) => setDateTime(e.target.value)}
                placeholder="09:00"
                className="field-input max-w-[10rem]"
              />
              <p className="w-full text-xs text-[var(--sea-ink-soft)]">
                {dateTime
                  ? `Due on ${dateStr} at ${dateTime}.`
                  : `Due on ${dateStr} (defaults to 09:00 local if no time set).`}
              </p>
            </div>
          ) : null}
          {dueKind === 'in' ? (
            <div className="mt-3">
              <div className="flex gap-2">
                <PositiveNumberInput
                  value={inAmount}
                  onChange={setInAmount}
                  className="field-input max-w-[6rem]"
                />
                <select
                  value={inUnit}
                  onChange={(e) =>
                    setInUnit(e.target.value as 'minutes' | 'hours')
                  }
                  className="field-input max-w-[10rem]"
                >
                  <option value="minutes">minutes</option>
                  <option value="hours">hours</option>
                </select>
              </div>
              <p className="mt-1 text-xs text-[var(--sea-ink-soft)]">
                {formatRelativeDue(inAmount, inUnit)}
              </p>
            </div>
          ) : null}
          {dueKind === 'timed' ? (
            <div className="mt-3 space-y-1">
              <input
                type="time"
                required
                value={timeOfDay}
                onChange={(e) => setTimeOfDay(e.target.value)}
                className="field-input max-w-[10rem]"
              />
              <PastTimeHint
                time={timeOfDay}
                recurring={recurrenceKind !== 'none'}
              />
            </div>
          ) : null}
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
            <option value="weekly">On specific days of the week</option>
            <option value="interval">Every N minutes / hours / days</option>
            <option value="after_completion">N after last done</option>
            <option value="monthly_day">Monthly — on a specific date</option>
            <option value="monthly_weekday">
              Monthly — on the Nth weekday
            </option>
          </select>
          {isSomeday ? (
            <p className="mt-1 text-xs text-[var(--sea-ink-soft)]">
              Someday tasks don't repeat.
            </p>
          ) : null}
        </label>

        {recurrenceKind === 'weekly' && !isSomeday ? (
          <fieldset>
            <legend className="mb-1 block text-xs font-semibold uppercase tracking-wide text-[var(--kicker)]">
              Days of the week
            </legend>
            <WeekdayPicker value={weekdays} onChange={setWeekdays} />
          </fieldset>
        ) : null}

        {recurrenceKind === 'interval' && !isSomeday ? (
          <fieldset>
            <legend className="mb-1 block text-xs font-semibold uppercase tracking-wide text-[var(--kicker)]">
              Every
            </legend>
            <AmountUnitPicker
              amount={intervalAmount}
              unit={intervalUnit}
              onAmountChange={setIntervalAmount}
              onUnitChange={setIntervalUnit}
            />
          </fieldset>
        ) : null}

        {recurrenceKind === 'after_completion' && !isSomeday ? (
          <fieldset>
            <legend className="mb-1 block text-xs font-semibold uppercase tracking-wide text-[var(--kicker)]">
              After completion
            </legend>
            <AmountUnitPicker
              amount={afterAmount}
              unit={afterUnit}
              onAmountChange={setAfterAmount}
              onUnitChange={setAfterUnit}
            />
          </fieldset>
        ) : null}

        {recurrenceKind === 'monthly_day' && !isSomeday ? (
          <fieldset>
            <legend className="mb-1 block text-xs font-semibold uppercase tracking-wide text-[var(--kicker)]">
              Day of the month
            </legend>
            <MonthlyDayPicker value={monthlyDay} onChange={setMonthlyDay} />
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
              week={monthlyWeek}
              dayOfWeek={monthlyDayOfWeek}
              onWeekChange={setMonthlyWeek}
              onDayOfWeekChange={setMonthlyDayOfWeek}
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

        {error ? (
          <p className="text-sm text-red-600" role="alert">
            {error}
          </p>
        ) : null}

        <button
          type="submit"
          disabled={mutation.isPending}
          className="w-full rounded-full border border-[rgba(50,143,151,0.3)] bg-[rgba(79,184,178,0.14)] px-5 py-2.5 text-sm font-semibold text-[var(--lagoon-deep)] disabled:opacity-60"
        >
          {mutation.isPending ? 'Creating…' : 'Create task'}
        </button>
      </form>
    </main>
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


function PastTimeHint({
  time,
  recurring,
}: {
  time: string
  recurring: boolean
}) {
  // Parse the user's HH:MM pick and compare against now in local clock
  // time. A one-off past time fires today as overdue; a recurring task
  // rolls to its next occurrence. Both are explicit here so there's no
  // surprise at create time.
  const m = /^(\d{2}):(\d{2})$/.exec(time)
  if (!m) return null
  const pickedMin = Number(m[1]) * 60 + Number(m[2])
  const now = new Date()
  const nowMin = now.getHours() * 60 + now.getMinutes()
  if (pickedMin >= nowMin) return null
  return (
    <p className="text-xs text-[var(--sea-ink-soft)]">
      {recurring
        ? 'That time has passed today — the first instance will be tomorrow.'
        : 'That time has passed today — this will be overdue right away.'}
    </p>
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

function StepsField({
  steps,
  onChange,
}: {
  steps: string[]
  onChange: (next: string[]) => void
}) {
  const [newTitle, setNewTitle] = useState('')

  function update(i: number, value: string) {
    const next = [...steps]
    next[i] = value
    onChange(next)
  }
  function remove(i: number) {
    onChange(steps.filter((_, idx) => idx !== i))
  }
  function move(index: number, dir: -1 | 1) {
    const next = [...steps]
    const target = index + dir
    if (target < 0 || target >= next.length) return
    const [moved] = next.splice(index, 1)
    next.splice(target, 0, moved)
    onChange(next)
  }
  function add() {
    const trimmed = newTitle.trim()
    if (!trimmed) return
    onChange([...steps, trimmed])
    setNewTitle('')
  }

  return (
    <fieldset>
      <legend className="mb-2 block text-xs font-semibold uppercase tracking-wide text-[var(--kicker)]">
        Steps
        {steps.filter((s) => s.trim()).length > 0
          ? ` (${steps.filter((s) => s.trim()).length})`
          : ''}
      </legend>
      {steps.length > 0 ? (
        <ul className="mb-2 space-y-1">
          {steps.map((s, i) => (
            <li
              key={i}
              className="group flex items-center gap-2 rounded-lg border border-[var(--line)] bg-[var(--option-bg)] px-2 py-1.5"
            >
              <input
                type="text"
                value={s}
                onChange={(e) => update(i, e.target.value)}
                placeholder={`Step ${i + 1}`}
                className="field-input min-w-0 flex-1 px-2 py-1 text-sm"
              />
              <div className="flex items-center gap-0.5 opacity-60 group-hover:opacity-100">
                <button
                  type="button"
                  onClick={() => move(i, -1)}
                  disabled={i === 0}
                  aria-label="Move up"
                  className="flex h-5 w-5 items-center justify-center rounded text-[var(--sea-ink-soft)] hover:bg-[var(--option-bg-hover)] disabled:opacity-30"
                >
                  ↑
                </button>
                <button
                  type="button"
                  onClick={() => move(i, 1)}
                  disabled={i === steps.length - 1}
                  aria-label="Move down"
                  className="flex h-5 w-5 items-center justify-center rounded text-[var(--sea-ink-soft)] hover:bg-[var(--option-bg-hover)] disabled:opacity-30"
                >
                  ↓
                </button>
                <button
                  type="button"
                  onClick={() => remove(i)}
                  aria-label={`Remove step ${i + 1}`}
                  className="flex h-5 w-5 items-center justify-center rounded text-[var(--sea-ink-soft)] hover:bg-red-100 hover:text-red-600"
                >
                  ✕
                </button>
              </div>
            </li>
          ))}
        </ul>
      ) : null}
      <div className="flex items-center gap-2">
        <input
          type="text"
          value={newTitle}
          onChange={(e) => setNewTitle(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              e.preventDefault()
              add()
            }
          }}
          placeholder="+ Add step"
          className="field-input min-w-0 flex-1 px-2 py-1 text-sm"
        />
        <button
          type="button"
          onClick={add}
          disabled={!newTitle.trim()}
          className="rounded-full border border-[rgba(50,143,151,0.3)] bg-[rgba(79,184,178,0.14)] px-3 py-1 text-xs font-semibold text-[var(--lagoon-deep)] disabled:opacity-50"
        >
          Add
        </button>
      </div>
    </fieldset>
  )
}

function formatRelativeDue(amount: number, unit: 'minutes' | 'hours'): string {
  const ms = unit === 'minutes' ? amount * 60_000 : amount * 60 * 60_000
  const at = new Date(Date.now() + ms)
  const clock = at.toLocaleTimeString(undefined, {
    hour: 'numeric',
    minute: '2-digit',
  })
  return `Will be due at about ${clock}.`
}
