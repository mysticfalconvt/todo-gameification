// Coach attitude — the voice the daily coach uses on the Today page.
//
// Lives in the domain layer so every consumer shares one source of truth:
// the settings page picker, the household kid-settings modal, and the
// server services that validate + select the system prompt. Keeping it
// here (rather than in services/coach.ts) also lets households services
// validate an attitude without importing the coach service, which would
// risk an import cycle (coach → tasks → households).

export const COACH_ATTITUDES = [
  'warm',
  'snarky',
  'stoic',
  'drill',
  'zen',
] as const
export type CoachAttitude = (typeof COACH_ATTITUDES)[number]
export const DEFAULT_COACH_ATTITUDE: CoachAttitude = 'warm'

export function isCoachAttitude(v: unknown): v is CoachAttitude {
  return (
    typeof v === 'string' && (COACH_ATTITUDES as readonly string[]).includes(v)
  )
}

export interface CoachAttitudeOption {
  value: CoachAttitude
  label: string
  glyph: string
  hint: string
}

// User-facing option metadata for the attitude picker. Labels/hints are
// the same wherever the picker is shown.
export const COACH_ATTITUDE_OPTIONS: ReadonlyArray<CoachAttitudeOption> = [
  {
    value: 'warm',
    label: 'Warm',
    glyph: '·',
    hint: 'A warm, ADHD-aware companion. The original voice.',
  },
  {
    value: 'snarky',
    label: 'Snarky',
    glyph: '✦',
    hint: 'Sarcastic and dry. Roasts the to-do list, never the human.',
  },
  {
    value: 'stoic',
    label: 'Stoic',
    glyph: '◻',
    hint: 'Just facts. No personality, no warmth, no humor.',
  },
  {
    value: 'drill',
    label: 'Drill Sergeant',
    glyph: '★',
    hint: 'Theatrical tough-love. Short, punchy, imperative.',
  },
  {
    value: 'zen',
    label: 'Zen',
    glyph: '◯',
    hint: 'Calm and unhurried. Reframes the day toward "do less, breathe."',
  },
]
