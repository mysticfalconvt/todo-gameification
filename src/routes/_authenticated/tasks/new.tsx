import { useState } from 'react'
import { createFileRoute, useNavigate } from '@tanstack/react-router'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { createTask } from '../../../server/functions/tasks'
import { getLlmStatus } from '../../../server/functions/config'
import type { Recurrence } from '../../../domain/recurrence'
import type { Difficulty } from '../../../domain/events'
import type { TaskVisibility } from '../../../server/services/tasks'

export const Route = createFileRoute('/_authenticated/tasks/new')({
  loader: () => getLlmStatus(),
  component: NewTaskPage,
})

type RecurrenceKind = 'none' | 'daily' | 'weekly_daily' | 'after_completion'
type DueKind = 'someday' | 'anytime' | 'timed'

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

function NewTaskPage() {
  const navigate = useNavigate()
  const qc = useQueryClient()
  const llmStatus = Route.useLoaderData()
  const llmEnabled = llmStatus.enabled
  const [title, setTitle] = useState('')
  const [difficulty, setDifficulty] = useState<Difficulty>('medium')
  const [kind, setKind] = useState<RecurrenceKind>('none')
  const [afterDays, setAfterDays] = useState(7)
  const [dueKind, setDueKind] = useState<DueKind>('anytime')
  const [timeOfDay, setTimeOfDay] = useState('08:00')
  const [visibility, setVisibility] = useState<TaskVisibility>('friends')
  const [error, setError] = useState<string | null>(null)

  const isSomeday = dueKind === 'someday'
  const recurrenceKind = isSomeday ? 'none' : kind

  const mutation = useMutation({
    mutationFn: (input: {
      title: string
      difficulty: Difficulty
      recurrence: Recurrence | null
      timeOfDay: string | null
      someday: boolean
      visibility: TaskVisibility
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
    mutation.mutate({
      title,
      difficulty,
      recurrence: isSomeday
        ? null
        : buildRecurrence(recurrenceKind, afterDays),
      timeOfDay: dueKind === 'timed' ? timeOfDay : null,
      someday: isSomeday,
      visibility,
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
          {isSomeday ? (
            <p className="mt-1 text-xs text-[var(--sea-ink-soft)]">
              Someday tasks don't repeat.
            </p>
          ) : null}
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
