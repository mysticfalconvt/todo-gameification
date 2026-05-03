export type Difficulty = 'small' | 'medium' | 'large'

export type DueKind = 'hard' | 'week_target'

export type DomainEvent =
  | {
      type: 'task.completed'
      taskId: string
      instanceId: string
      difficulty: Difficulty
      xpOverride: number | null
      dueAt: Date | null
      timeOfDay: string | null
      // Discriminator picked at completion time. Defaults to 'hard' when
      // missing (back-compat with old events written before this field
      // existed). 'week_target' selects the soft early-bird/late curve.
      dueKind?: DueKind
      occurredAt: Date
    }
  | {
      type: 'task.skipped'
      taskId: string
      instanceId: string
      occurredAt: Date
    }
  | {
      // Cheer-received: event belongs to the *recipient* (their progression
      // picks up the XP on replay). giverUserId records who gave the cheer
      // so the service layer can enforce anti-farming caps and dedupe.
      type: 'task.cheered'
      completionEventId: string
      giverUserId: string
      xp: number
      occurredAt: Date
    }
  | {
      // Friend-added: event belongs to one side of the pair (their
      // progression picks up the XP). The other side gets their own event
      // inserted at the same time. otherUserId lets the service dedupe so
      // unfriend+refriend can't farm XP repeatedly.
      type: 'friend.added'
      otherUserId: string
      xp: number
      occurredAt: Date
    }
  | {
      // Purely informational: doesn't affect progression. Lets admin analytics
      // see how many sessions get abandoned vs completed.
      type: 'focus.started'
      durationMin: 5 | 10 | 15 | 25 | 50
      taskInstanceId: string | null
      occurredAt: Date
    }
  | {
      type: 'focus.completed'
      durationMin: 5 | 10 | 15 | 25 | 50
      taskInstanceId: string | null
      tokensEarned: number
      xpEarned: number
      occurredAt: Date
    }
  | {
      type: 'game.played'
      gameId: string
      tokenCost: number
      xpReward: number
      result: { won: boolean; score: number | null }
      // Game-specific payload (e.g. wordle stores the word played here).
      // Not consumed by progression — just threaded through to the event
      // log for later queries.
      meta?: Record<string, unknown>
      occurredAt: Date
    }
  | {
      // Admin-issued token grant (positive or negative). Lives in the event
      // log so `rebuildProgression` preserves it across replays.
      type: 'tokens.granted'
      amount: number
      reason: string | null
      grantedBy: string
      occurredAt: Date
    }
  | {
      // Subtask checked off. xpEarned is resolved at the moment of toggle
      // (based on parent's base XP / current step count, modulated by
      // streak + punctuality) and persisted in the payload so replay is
      // deterministic. Streak is *not* affected by step events — only
      // parent completion drives streak.
      type: 'task.step.completed'
      taskId: string
      stepId: string
      instanceId: string
      xpEarned: number
      occurredAt: Date
    }
  | {
      // Subtask unchecked. Refunds exactly the XP recorded on the prior
      // task.step.completed event so undo/redo cycles stay neutral.
      type: 'task.step.uncompleted'
      taskId: string
      stepId: string
      instanceId: string
      xpRefunded: number
      occurredAt: Date
    }

export type DomainEventType = DomainEvent['type']

export const FOCUS_REWARDS: Record<5 | 10 | 15 | 25 | 50, { tokens: number; xp: number }> = {
  5: { tokens: 1, xp: 5 },
  10: { tokens: 1, xp: 11 },
  15: { tokens: 1, xp: 18 },
  25: { tokens: 2, xp: 35 },
  50: { tokens: 4, xp: 80 },
}
