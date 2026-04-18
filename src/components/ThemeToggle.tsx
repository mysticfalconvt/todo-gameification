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

export function ThemeToggle() {
  const [theme, setTheme] = useState<Theme>('system')
  const [mounted, setMounted] = useState(false)

  useEffect(() => {
    const stored = readStored()
    setTheme(stored)
    applyTheme(stored)
    setMounted(true)
  }, [])

  function cycle() {
    const next: Theme =
      theme === 'light' ? 'dark' : theme === 'dark' ? 'system' : 'light'
    setTheme(next)
    if (next === 'system') {
      localStorage.removeItem(THEME_KEY)
    } else {
      localStorage.setItem(THEME_KEY, next)
    }
    applyTheme(next)
  }

  const glyph =
    theme === 'system' ? '◐' : theme === 'light' ? '☀' : '☾'
  const label =
    theme === 'system' ? 'Auto' : theme === 'light' ? 'Light' : 'Dark'

  return (
    <button
      type="button"
      onClick={cycle}
      aria-label={`Theme: ${label} (click to change)`}
      title={`Theme: ${label}`}
      className="nav-link inline-flex items-center gap-1"
      suppressHydrationWarning
    >
      <span aria-hidden>{glyph}</span>
      <span className={mounted ? '' : 'opacity-0'}>{label}</span>
    </button>
  )
}
