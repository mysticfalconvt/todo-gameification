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

export type DomainEventType = DomainEvent['type']
