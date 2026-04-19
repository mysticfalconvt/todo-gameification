import { useEffect, useState } from 'react'
import { baseXp } from './xp-label'
import type { Difficulty } from '../domain/events'

export type SortKey =
  | 'due-asc'
  | 'title-asc'
  | 'xp-desc'
  | 'xp-asc'
  | 'created-desc'
  | 'created-asc'

export interface SortOption {
  key: SortKey
  label: string
}

export const TODAY_SORTS: SortOption[] = [
  { key: 'due-asc', label: 'Due time' },
  { key: 'title-asc', label: 'A → Z' },
  { key: 'xp-desc', label: 'XP high → low' },
  { key: 'xp-asc', label: 'XP low → high' },
]

export const TASKS_SORTS: SortOption[] = [
  { key: 'created-desc', label: 'Recently added' },
  { key: 'created-asc', label: 'Oldest first' },
  { key: 'title-asc', label: 'A → Z' },
  { key: 'xp-desc', label: 'XP high → low' },
  { key: 'xp-asc', label: 'XP low → high' },
]

interface SortableCommon {
  title: string
  difficulty: Difficulty
  xpOverride: number | null
  dueAt?: string
  createdAt?: string
}

function effectiveXp(row: SortableCommon): number {
  return baseXp(row.difficulty, row.xpOverride)
}

export function compareBy<T extends SortableCommon>(
  key: SortKey,
): (a: T, b: T) => number {
  switch (key) {
    case 'due-asc':
      return (a, b) => (a.dueAt ?? '').localeCompare(b.dueAt ?? '')
    case 'title-asc':
      return (a, b) =>
        a.title.toLowerCase().localeCompare(b.title.toLowerCase())
    case 'xp-desc':
      return (a, b) => effectiveXp(b) - effectiveXp(a)
    case 'xp-asc':
      return (a, b) => effectiveXp(a) - effectiveXp(b)
    case 'created-desc':
      return (a, b) => (b.createdAt ?? '').localeCompare(a.createdAt ?? '')
    case 'created-asc':
      return (a, b) => (a.createdAt ?? '').localeCompare(b.createdAt ?? '')
  }
}

/** Persisted sort choice, keyed by a page identifier. */
export function useStoredSort(
  storageKey: string,
  options: SortOption[],
  initial: SortKey,
): [SortKey, (next: SortKey) => void] {
  const [value, setValue] = useState<SortKey>(initial)

  useEffect(() => {
    if (typeof localStorage === 'undefined') return
    const saved = localStorage.getItem(storageKey)
    if (!saved) return
    if (options.some((o) => o.key === saved)) setValue(saved as SortKey)
  }, [storageKey, options])

  function set(next: SortKey) {
    setValue(next)
    if (typeof localStorage !== 'undefined') {
      localStorage.setItem(storageKey, next)
    }
  }

  return [value, set]
}
