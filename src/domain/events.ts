export type Difficulty = 'small' | 'medium' | 'large'

export type DomainEvent =
  | {
      type: 'task.completed'
      taskId: string
      instanceId: string
      difficulty: Difficulty
      xpOverride: number | null
      dueAt: Date | null
      timeOfDay: string | null
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

export type DomainEventType = DomainEvent['type']
