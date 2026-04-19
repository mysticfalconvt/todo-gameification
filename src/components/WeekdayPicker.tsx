// Seven-pill toggle row for selecting which days of the week a task
// recurs on. Uses JS day indices (0 = Sunday … 6 = Saturday) to match
// `Recurrence.daysOfWeek` and the server-side recurrence math.

const DAY_LABELS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']
const DAY_SHORT = ['S', 'M', 'T', 'W', 'T', 'F', 'S']

export function WeekdayPicker({
  value,
  onChange,
}: {
  value: number[]
  onChange: (next: number[]) => void
}) {
  const selected = new Set(value)
  function toggle(day: number) {
    const next = new Set(selected)
    if (next.has(day)) next.delete(day)
    else next.add(day)
    onChange([...next].sort((a, b) => a - b))
  }
  return (
    <div className="flex flex-wrap gap-1" role="group" aria-label="Weekdays">
      {DAY_LABELS.map((label, idx) => {
        const on = selected.has(idx)
        return (
          <button
            key={idx}
            type="button"
            aria-pressed={on}
            aria-label={label}
            onClick={() => toggle(idx)}
            title={label}
            className={`flex h-9 w-9 items-center justify-center rounded-full border text-xs font-semibold transition ${
              on
                ? 'border-[var(--lagoon-deep)] bg-[var(--btn-primary-bg)] text-[var(--btn-primary-fg)]'
                : 'border-[var(--line)] bg-[var(--option-bg)] text-[var(--sea-ink-soft)] hover:text-[var(--sea-ink)]'
            }`}
          >
            {DAY_SHORT[idx]}
          </button>
        )
      })}
    </div>
  )
}

// Friendly label for a weekly recurrence — used in task lists to show
// "Mon, Wed, Fri" instead of "Weekly (3d)". Falls back to "Every day"
// when all seven are selected.
export function formatWeeklyLabel(daysOfWeek: number[]): string {
  if (daysOfWeek.length === 0) return 'Weekly'
  if (daysOfWeek.length === 7) return 'Every day'
  const sorted = [...daysOfWeek].sort((a, b) => a - b)
  if (sorted.length === 1) return `Every ${DAY_LABELS[sorted[0]]}`
  // Weekdays shortcut (Mon–Fri).
  const weekdays = [1, 2, 3, 4, 5]
  if (
    sorted.length === 5 &&
    sorted.every((d, i) => d === weekdays[i])
  ) {
    return 'Weekdays'
  }
  // Weekends shortcut (Sat + Sun).
  if (sorted.length === 2 && sorted[0] === 0 && sorted[1] === 6) {
    return 'Weekends'
  }
  return sorted.map((d) => DAY_LABELS[d]).join(', ')
}
