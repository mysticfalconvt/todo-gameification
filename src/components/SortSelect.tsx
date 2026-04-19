import type { SortKey, SortOption } from '../lib/sort'

export function SortSelect({
  value,
  options,
  onChange,
  label = 'Sort',
}: {
  value: SortKey
  options: SortOption[]
  onChange: (next: SortKey) => void
  label?: string
}) {
  return (
    <label className="inline-flex items-center gap-2 text-xs">
      <span className="font-semibold uppercase tracking-wide text-[var(--kicker)]">
        {label}
      </span>
      <select
        value={value}
        onChange={(e) => onChange(e.target.value as SortKey)}
        className="rounded-full border border-[var(--line)] bg-[var(--option-bg)] px-3 py-1 text-xs font-semibold text-[var(--sea-ink)]"
      >
        {options.map((o) => (
          <option key={o.key} value={o.key}>
            {o.label}
          </option>
        ))}
      </select>
    </label>
  )
}
