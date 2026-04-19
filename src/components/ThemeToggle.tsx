import { useEffect, useState } from 'react'

export const THEME_KEY = 'todo-xp-theme'
export type Theme = 'light' | 'dark' | 'system'

function applyTheme(theme: Theme) {
  if (typeof document === 'undefined') return
  const root = document.documentElement
  if (theme === 'system') {
    root.removeAttribute('data-theme')
  } else {
    root.setAttribute('data-theme', theme)
  }
}

function readStored(): Theme {
  if (typeof localStorage === 'undefined') return 'system'
  const saved = localStorage.getItem(THEME_KEY)
  return saved === 'light' || saved === 'dark' ? saved : 'system'
}

function persist(theme: Theme): void {
  if (typeof localStorage === 'undefined') return
  if (theme === 'system') {
    localStorage.removeItem(THEME_KEY)
  } else {
    localStorage.setItem(THEME_KEY, theme)
  }
}

/** Three explicit buttons — meant for /settings. */
export function ThemePicker() {
  const [theme, setTheme] = useState<Theme>('system')

  useEffect(() => {
    setTheme(readStored())
  }, [])

  function select(next: Theme) {
    setTheme(next)
    persist(next)
    applyTheme(next)
  }

  const options: Array<{ value: Theme; label: string; glyph: string }> = [
    { value: 'light', label: 'Light', glyph: '☀' },
    { value: 'dark', label: 'Dark', glyph: '☾' },
    { value: 'system', label: 'Auto', glyph: '◐' },
  ]

  return (
    <div className="flex flex-wrap gap-2" role="radiogroup" aria-label="Theme">
      {options.map((o) => {
        const selected = theme === o.value
        return (
          <button
            key={o.value}
            type="button"
            role="radio"
            aria-checked={selected}
            onClick={() => select(o.value)}
            className={`inline-flex items-center gap-1 rounded-full border px-3 py-1 text-sm font-semibold transition ${
              selected
                ? 'border-[var(--lagoon-deep)] bg-[rgba(79,184,178,0.2)] text-[var(--lagoon-deep)]'
                : 'border-[var(--line)] bg-[var(--option-bg)] text-[var(--sea-ink-soft)] hover:bg-[var(--option-bg-hover)]'
            }`}
          >
            <span aria-hidden>{o.glyph}</span>
            <span>{o.label}</span>
          </button>
        )
      })}
    </div>
  )
}
