import { useEffect, useState } from 'react'

// Controlled numeric input that tolerates transient empty / invalid states
// while the user is typing. A plain `Math.max(1, Number(v) || 1)` onChange
// coerces empty back to 1 immediately, which means backspacing leaves the
// "1" stuck in the field — so typing "30" after a clear yields "130".
export function PositiveNumberInput({
  value,
  onChange,
  min = 1,
  className,
  'aria-label': ariaLabel,
}: {
  value: number
  onChange: (n: number) => void
  min?: number
  className?: string
  'aria-label'?: string
}) {
  const [raw, setRaw] = useState(() => String(value))

  // Keep the input in sync when the parent changes the value externally
  // (e.g., form reset). During normal typing this is a no-op because raw
  // already matches.
  useEffect(() => {
    setRaw((prev) => (Number.parseInt(prev, 10) === value ? prev : String(value)))
  }, [value])

  return (
    <input
      type="number"
      inputMode="numeric"
      min={min}
      value={raw}
      aria-label={ariaLabel}
      onChange={(e) => {
        const next = e.target.value
        setRaw(next)
        const n = Number.parseInt(next, 10)
        if (Number.isFinite(n) && n >= min) onChange(n)
      }}
      onBlur={() => {
        const n = Number.parseInt(raw, 10)
        if (!Number.isFinite(n) || n < min) {
          setRaw(String(min))
          onChange(min)
        }
      }}
      className={className}
    />
  )
}
