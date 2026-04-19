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

export type DomainEventType = DomainEvent['type']
