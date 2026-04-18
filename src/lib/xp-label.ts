import type { Difficulty } from '../domain/events'

const BASE: Record<Difficulty, number> = { small: 10, medium: 25, large: 60 }

export function baseXp(difficulty: Difficulty, xpOverride: number | null): number {
  return xpOverride ?? BASE[difficulty]
}

export function xpLabel(
  difficulty: Difficulty,
  xpOverride: number | null,
): string {
  if (xpOverride != null) return `${xpOverride} XP`
  const label =
    difficulty === 'small' ? 'Small' : difficulty === 'large' ? 'Large' : 'Medium'
  return `${label} • ${BASE[difficulty]} XP`
}
