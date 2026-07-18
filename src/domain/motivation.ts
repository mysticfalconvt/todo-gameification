// Motivation style — what a person wants their to-do list to give them.
//
// Lives in the domain layer (like coach.ts) so every consumer shares one
// source of truth: the settings picker, the server functions that validate +
// persist the preference, and the coach service that shifts its emphasis.
//
// IMPORTANT: motivation style changes *emphasis and coaching only*. It does
// NOT change XP/token/streak math — milestone rewards are identical for every
// style. That keeps the event-sourced progression replay-safe (nothing about
// a completion's reward depends on a mutable preference).

export const MOTIVATION_STYLES = [
  'balanced',
  'xp_hunter',
  'clean_sweep',
  'streak_keeper',
] as const
export type MotivationStyle = (typeof MOTIVATION_STYLES)[number]
export const DEFAULT_MOTIVATION_STYLE: MotivationStyle = 'balanced'

export function isMotivationStyle(v: unknown): v is MotivationStyle {
  return (
    typeof v === 'string' &&
    (MOTIVATION_STYLES as readonly string[]).includes(v)
  )
}

// Which Today stat tile a style foregrounds. null = no special emphasis.
export type PrimaryStat = 'xp' | 'streak' | 'remaining' | null

export interface MotivationStyleOption {
  value: MotivationStyle
  label: string
  glyph: string
  hint: string
  primaryStat: PrimaryStat
  // A one-line instruction injected into the coach's system prompt.
  coachEmphasis: string
}

export const MOTIVATION_STYLE_OPTIONS: ReadonlyArray<MotivationStyleOption> = [
  {
    value: 'balanced',
    label: 'Balanced',
    glyph: '◆',
    hint: 'A little of everything. No single number in the spotlight.',
    primaryStat: null,
    coachEmphasis:
      'This person likes a balanced mix — acknowledge progress broadly without fixating on one metric.',
  },
  {
    value: 'xp_hunter',
    label: 'XP Hunter',
    glyph: '⬢',
    hint: 'Driven by points and levels. Show me the numbers go up.',
    primaryStat: 'xp',
    coachEmphasis:
      'This person is motivated by XP and levelling up — frame progress in points and levels, and call out how close the next level is.',
  },
  {
    value: 'clean_sweep',
    label: 'Clean Sweep',
    glyph: '✓',
    hint: 'Motivated by an empty list. Getting to zero is the win.',
    primaryStat: 'remaining',
    coachEmphasis:
      "This person is motivated by clearing the list — celebrate an empty or nearly-empty day and frame remaining tasks as the gap to zero.",
  },
  {
    value: 'streak_keeper',
    label: 'Streak Keeper',
    glyph: '◈',
    hint: 'Consistency above all. Protect the streak at all costs.',
    primaryStat: 'streak',
    coachEmphasis:
      'This person values consistency above all — honor the current streak, gently protect it, and treat showing up daily as the main win.',
  },
]

export function motivationStyleOption(
  style: MotivationStyle,
): MotivationStyleOption {
  return (
    MOTIVATION_STYLE_OPTIONS.find((o) => o.value === style) ??
    MOTIVATION_STYLE_OPTIONS[0]
  )
}
