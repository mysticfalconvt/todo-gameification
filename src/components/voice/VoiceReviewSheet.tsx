// Confirm-before-create for a dictated task.
//
// Speech plus an LLM will occasionally get something wrong, so nothing is
// written until the user says so. On confirm this hands the draft to the
// ordinary createTask path — auto-categorise, XP scoring and the event log
// all behave exactly as they do for a typed task.
import { useEffect, useMemo, useRef, useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useNavigate } from '@tanstack/react-router'
import { toast } from 'sonner'
import { resolveDuration, type Recurrence } from '../../domain/recurrence'
import { getMyHouseholdFn } from '../../server/functions/households'
import { createTask } from '../../server/functions/tasks'
import type { VoiceDraft } from '../../server/services/voice'
import { formatWeeklyLabel } from '../WeekdayPicker'

const WEEKDAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday']

function plural(amount: number, unit: string): string {
  return amount === 1 ? unit.replace(/s$/, '') : unit
}

function ordinal(n: number): string {
  const suffix =
    n % 10 === 1 && n !== 11
      ? 'st'
      : n % 10 === 2 && n !== 12
        ? 'nd'
        : n % 10 === 3 && n !== 13
          ? 'rd'
          : 'th'
  return `${n}${suffix}`
}

export function describeRepeat(r: Recurrence | null): string | null {
  if (!r) return null
  switch (r.type) {
    case 'daily':
      return 'Every day'
    case 'weekly':
      return formatWeeklyLabel(r.daysOfWeek)
    case 'interval': {
      const { amount, unit } = resolveDuration(r)
      return `Every ${amount} ${plural(amount, unit)}`
    }
    case 'after_completion': {
      const { amount, unit } = resolveDuration(r)
      return `${amount} ${plural(amount, unit)} after done`
    }
    case 'monthly_day':
      return `Monthly on the ${ordinal(r.dayOfMonth)}`
    case 'monthly_weekday': {
      const week = r.week === -1 ? 'last' : ordinal(r.week)
      return `Monthly — ${week} ${WEEKDAYS[r.dayOfWeek] ?? ''}`.trim()
    }
  }
}

/** ISO instant -> the date and time inputs' local values. */
export function splitLocal(iso: string | null): { date: string; time: string } {
  if (!iso) return { date: '', time: '' }
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return { date: '', time: '' }
  const pad = (n: number) => String(n).padStart(2, '0')
  return {
    date: `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`,
    time: `${pad(d.getHours())}:${pad(d.getMinutes())}`,
  }
}

/**
 * Rebuild the submitted instant from the two inputs. An empty time means
 * "sometime that day", which is stored as end-of-day so the punctuality
 * curve only starts docking once the day is actually over.
 */
export function joinLocal(date: string, time: string): string | null {
  if (!date) return null
  const at = new Date(`${date}T${time || '23:59'}:00`)
  return Number.isNaN(at.getTime()) ? null : at.toISOString()
}

function HeardHeader({ transcript, degraded }: { transcript: string | null; degraded?: boolean }) {
  return (
    <>
      {transcript && (
        <p className="m-0 text-sm italic text-[var(--sea-ink-soft)]">“{transcript}”</p>
      )}
      {degraded && (
        <p className="m-0 rounded-lg bg-[rgba(79,184,178,0.14)] px-3 py-2 text-xs text-[var(--sea-ink-soft)]">
          Heard you, but couldn’t work out the details — check the title and date.
        </p>
      )}
    </>
  )
}

/**
 * The assignee picker collapses three separate task fields (householdId,
 * assignedToUserId, assigneeGroup) into one select value, because to the
 * user they are a single "who is this for?" choice.
 */
export type WhoValue = 'personal' | 'ffa' | 'group:adults' | 'group:kids' | `user:${string}`

export function whoFromDraft(draft: {
  householdId: string | null
  assignedToUserId: string | null
  assigneeGroup: 'adults' | 'kids' | null
}): WhoValue {
  if (!draft.householdId) return 'personal'
  if (draft.assigneeGroup) return `group:${draft.assigneeGroup}`
  return draft.assignedToUserId ? `user:${draft.assignedToUserId}` : 'ffa'
}

export function whoToFields(
  who: WhoValue,
  householdId: string | null,
): {
  householdId: string | null
  assignedToUserId: string | null
  assigneeGroup: 'adults' | 'kids' | null
} {
  if (who === 'personal' || !householdId) {
    return { householdId: null, assignedToUserId: null, assigneeGroup: null }
  }
  if (who === 'ffa') return { householdId, assignedToUserId: null, assigneeGroup: null }
  if (who === 'group:adults')
    return { householdId, assignedToUserId: null, assigneeGroup: 'adults' }
  if (who === 'group:kids') return { householdId, assignedToUserId: null, assigneeGroup: 'kids' }
  return { householdId, assignedToUserId: who.slice('user:'.length), assigneeGroup: null }
}

interface FieldsProps {
  title: string
  setTitle: (v: string) => void
  notes: string
  setNotes: (v: string) => void
  date: string
  setDate: (v: string) => void
  time: string
  setTime: (v: string) => void
  repeatLabel: string | null
  clearRepeat: () => void
  who: WhoValue
  setWho: (v: WhoValue) => void
  /** Null when the speaker isn't in a household; the picker then hides. */
  household: {
    id: string
    members: Array<{ userId: string; name: string; role: string }>
  } | null
}

const LABEL = 'flex flex-col gap-1 text-xs font-semibold text-[var(--sea-ink-soft)]'
const VALUE = 'field-input font-normal text-[var(--sea-ink)]'

function DraftFields(p: FieldsProps) {
  return (
    <>
      <label className={LABEL}>
        Task
        <input
          value={p.title}
          onChange={(e) => p.setTitle(e.target.value)}
          className={`${VALUE} text-base`}
          placeholder="What needs doing?"
        />
      </label>

      <div className="flex gap-2">
        <label className={`${LABEL} flex-1`}>
          Due
          <input
            type="date"
            value={p.date}
            onChange={(e) => p.setDate(e.target.value)}
            className={VALUE}
          />
        </label>
        <label className={`${LABEL} w-36`}>
          Time
          <input
            type="time"
            value={p.time}
            onChange={(e) => p.setTime(e.target.value)}
            className={VALUE}
          />
        </label>
      </div>
      {p.date && !p.time && (
        <p className="-mt-2 m-0 text-xs text-[var(--sea-ink-soft)]">Any time that day.</p>
      )}

      {p.repeatLabel && (
        <div className="flex items-center justify-between gap-2 rounded-lg border border-[var(--line)] bg-[var(--option-bg)] px-3 py-2">
          <span className="text-sm">Repeats: {p.repeatLabel}</span>
          <button
            type="button"
            onClick={p.clearRepeat}
            className="rounded-full border border-[var(--line)] px-2 py-0.5 text-xs text-[var(--sea-ink-soft)]"
          >
            Remove
          </button>
        </div>
      )}

      {p.household && (
        <label className={LABEL}>
          Who
          <select
            value={p.who}
            onChange={(e) => p.setWho(e.target.value as WhoValue)}
            className={VALUE}
          >
            <option value="personal">Just me (personal)</option>
            <option value="ffa">Anyone in the family</option>
            <option value="group:adults">Any adult</option>
            <option value="group:kids">Any kid</option>
            {p.household.members
              .filter((m) => m.role !== 'kiosk')
              .map((m) => (
                <option key={m.userId} value={`user:${m.userId}`}>
                  {m.name}
                </option>
              ))}
          </select>
        </label>
      )}

      {p.notes && (
        <label className={LABEL}>
          Notes
          <textarea
            value={p.notes}
            onChange={(e) => p.setNotes(e.target.value)}
            rows={2}
            className={`${VALUE} resize-y`}
          />
        </label>
      )}
    </>
  )
}

interface Props {
  draft: VoiceDraft | null
  transcript: string | null
  /** True when speech was captured but the parse failed. */
  degraded?: boolean
  onClose: () => void
}

/**
 * Editable copy of a draft, re-seeded whenever a new one arrives. Split out
 * so the sheet itself stays a render, not a pile of state.
 */
function useDraftForm(draft: VoiceDraft | null) {
  const [title, setTitle] = useState('')
  const [notes, setNotes] = useState('')
  const [date, setDate] = useState('')
  const [time, setTime] = useState('')
  const [recurrence, setRecurrence] = useState<Recurrence | null>(null)
  const [who, setWho] = useState<WhoValue>('personal')

  useEffect(() => {
    if (!draft) return
    const local = splitLocal(draft.dueAtOverride)
    setTitle(draft.title)
    setNotes(draft.notes ?? '')
    setDate(local.date)
    // An anytime task has no spoken time; leave the input blank rather than
    // showing the 23:59 sentinel the resolver used.
    setTime(draft.timeOfDay ? local.time : '')
    setRecurrence(draft.recurrence)
    setWho(whoFromDraft(draft))
  }, [draft])

  return {
    title,
    setTitle,
    notes,
    setNotes,
    date,
    setDate,
    time,
    setTime,
    recurrence,
    setRecurrence,
    who,
    setWho,
  }
}

/** Drives a native <dialog>, which gives focus trap, esc and a backdrop. */
function useModalDialog(open: boolean) {
  const ref = useRef<HTMLDialogElement | null>(null)
  useEffect(() => {
    const el = ref.current
    if (!el) return
    if (open && !el.open) el.showModal()
    else if (!open && el.open) el.close()
  }, [open])
  return ref
}

export function VoiceReviewSheet({ draft, transcript, degraded, onClose }: Props) {
  const qc = useQueryClient()
  const navigate = useNavigate()
  const form = useDraftForm(draft)
  const dialogRef = useModalDialog(Boolean(draft))

  const householdQuery = useQuery({
    queryKey: ['my-household'],
    queryFn: () => getMyHouseholdFn(),
  })
  const household = householdQuery.data ?? null

  const repeatLabel = useMemo(() => describeRepeat(form.recurrence), [form.recurrence])

  const save = useMutation({
    mutationFn: () => {
      const dueAtOverride = joinLocal(form.date, form.time)
      const assignment = whoToFields(form.who, household?.household.id ?? null)
      return createTask({
        data: {
          title: form.title.trim(),
          notes: form.notes.trim() || null,
          difficulty: 'medium' as const,
          recurrence: form.recurrence,
          timeOfDay: form.time || null,
          someday: dueAtOverride === null && form.recurrence === null,
          dueAtOverride,
          ...assignment,
        },
      })
    },
    onSuccess: async () => {
      toast.success('Task added')
      onClose()
      await Promise.all([
        qc.invalidateQueries({ queryKey: ['today'] }),
        qc.invalidateQueries({ queryKey: ['someday'] }),
        qc.invalidateQueries({ queryKey: ['tasks'] }),
      ])
      navigate({ to: '/today' })
    },
    onError: (err) => {
      toast.error(err instanceof Error ? err.message : 'Could not add that task')
    },
  })

  return (
    <dialog
      ref={dialogRef}
      onClose={onClose}
      onCancel={onClose}
      aria-label="Review dictated task"
      className="m-auto w-[min(28rem,calc(100%-1.5rem))] max-w-[100vw] rounded-2xl border border-[var(--line)] bg-[var(--surface)] p-0 text-[var(--sea-ink)] shadow-2xl backdrop:bg-black/40 backdrop:backdrop-blur-sm"
    >
      {draft && (
        <form
          method="dialog"
          onSubmit={(e) => {
            e.preventDefault()
            if (form.title.trim()) save.mutate()
          }}
          className="flex flex-col gap-4 p-5"
        >
          <HeardHeader transcript={transcript} degraded={degraded} />

          <DraftFields
            title={form.title}
            setTitle={form.setTitle}
            notes={form.notes}
            setNotes={form.setNotes}
            date={form.date}
            setDate={form.setDate}
            time={form.time}
            setTime={form.setTime}
            repeatLabel={repeatLabel}
            clearRepeat={() => form.setRecurrence(null)}
            who={form.who}
            setWho={form.setWho}
            household={
              household ? { id: household.household.id, members: household.members } : null
            }
          />

          <div className="mt-1 flex justify-end gap-2">
            <button
              type="button"
              onClick={onClose}
              disabled={save.isPending}
              className="rounded-full border border-[var(--line)] px-4 py-2 text-sm font-semibold text-[var(--sea-ink-soft)]"
            >
              Cancel
            </button>
            <button
              type="submit"
              disabled={save.isPending || !form.title.trim()}
              className="btn-primary rounded-full px-5 py-2 text-sm font-semibold disabled:opacity-60"
            >
              {save.isPending ? 'Adding…' : 'Add task'}
            </button>
          </div>
        </form>
      )}
    </dialog>
  )
}
