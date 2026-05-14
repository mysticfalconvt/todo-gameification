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
      // see how many sessions get abandoned vs completed. `mode` distinguishes
      // visible (screen-on enforcement) from pocket (server-tracked + push).
      // Old events omit `mode` and default to 'visible' on read.
      type: 'focus.started'
      durationMin: 5 | 10 | 15 | 25 | 50
      taskInstanceId: string | null
      mode?: FocusMode
      // Pocket-mode bookkeeping: expected end time (so reopening the app
      // can show remaining time) and the pg-boss job ID for cancellation.
      expectedEndAt?: Date | null
      scheduledJobId?: string | null
      occurredAt: Date
    }
  | {
      // Early termination of an in-flight pocket session. Lets the
      // active-session lookup ignore the parent focus.started cleanly,
      // and lets the scheduled push handler short-circuit on fire.
      type: 'focus.cancelled'
      startEventId: string
      occurredAt: Date
    }
  | {
      // `mode` lets applyEvent route to the right reward table at write time
      // (tokensEarned/xpEarned are stored in the payload, so replay is
      // unaffected). `startEventId` links back to the originating
      // focus.started, enabling de-dup against duplicate completion attempts.
      type: 'focus.completed'
      durationMin: 5 | 10 | 15 | 25 | 50
      taskInstanceId: string | null
      tokensEarned: number
      xpEarned: number
      mode?: FocusMode
      startEventId?: string | null
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
  | {
      // Admin granted a membership outside Stripe. Lifetime today; annual is
      // allowed by the type for future flexibility (e.g. one-year comp).
      type: 'membership.granted'
      tier: 'lifetime' | 'annual'
      grantedBy: string
      reason: string | null
      occurredAt: Date
    }
  | {
      // Automatic 10-day full-access trial granted at signup. Entitlement
      // is lazy — `isMember()` returns true while currentPeriodEnd > now,
      // false after. No `trial_expired` event is needed for gating; the
      // projection row stays as the historical record of the trial.
      type: 'membership.trial_started'
      trialEndsAt: Date
      occurredAt: Date
    }
  | {
      // Stripe checkout completed (subscription OR one-time payment). For
      // annual: stripeSubscriptionId + currentPeriodEnd are set. For
      // lifetime: both are null. stripeCustomerId can be null when an
      // older lifetime checkout completed without `customer_creation: 'always'`.
      type: 'membership.activated'
      tier: 'annual' | 'lifetime'
      stripeCustomerId: string | null
      stripeSubscriptionId: string | null
      currentPeriodEnd: Date | null
      stripeEventId: string
      occurredAt: Date
    }
  | {
      // Annual subscription successfully renewed (invoice.paid).
      type: 'membership.renewed'
      currentPeriodEnd: Date
      stripeEventId: string
      occurredAt: Date
    }
  | {
      // User clicked "cancel" in the Stripe Customer Portal — sub still
      // active until currentPeriodEnd.
      type: 'membership.cancel_scheduled'
      currentPeriodEnd: Date
      stripeEventId: string
      occurredAt: Date
    }
  | {
      // Subscription ended (period_end after cancel, or payment failed past
      // grace). Drop tier to free.
      type: 'membership.lapsed'
      reason: 'period_end' | 'payment_failed' | 'voluntary'
      stripeEventId: string
      occurredAt: Date
    }
  | {
      // Lifetime payment refunded. Drop tier to free.
      type: 'membership.refunded'
      stripeEventId: string
      occurredAt: Date
    }
  | {
      // Admin revoked an admin-granted membership.
      type: 'membership.revoked'
      revokedBy: string
      reason: string | null
      occurredAt: Date
    }

export type DomainEventType = DomainEvent['type']

export type FocusMode = 'visible' | 'pocket'

// Pocket-mode rewards = the original FOCUS_REWARDS values. The screen
// stays usable for the duration, so we can't verify the user didn't
// switch to a game; rewards are baseline.
export const FOCUS_REWARDS_POCKET: Record<5 | 10 | 15 | 25 | 50, { tokens: number; xp: number }> = {
  5: { tokens: 1, xp: 5 },
  10: { tokens: 1, xp: 11 },
  15: { tokens: 1, xp: 18 },
  25: { tokens: 2, xp: 35 },
  50: { tokens: 4, xp: 80 },
}

// Visible mode commits the screen to the focus app for the whole
// session (any backgrounding pauses the timer), so the longer tiers
// earn an extra token over Pocket.
export const FOCUS_REWARDS_VISIBLE: Record<5 | 10 | 15 | 25 | 50, { tokens: number; xp: number }> = {
  5: { tokens: 1, xp: 5 },
  10: { tokens: 1, xp: 11 },
  15: { tokens: 2, xp: 18 },
  25: { tokens: 3, xp: 35 },
  50: { tokens: 5, xp: 80 },
}

export function focusRewardsFor(mode: FocusMode) {
  return mode === 'pocket' ? FOCUS_REWARDS_POCKET : FOCUS_REWARDS_VISIBLE
}

// TESTING ONLY — when > 0, every focus session (visible or pocket)
// runs for this many seconds regardless of the user-chosen duration.
// Lets you exercise the whole pocket-mode push flow in seconds rather
// than minutes. Set to 0 before shipping.
export const FOCUS_TEST_OVERRIDE_SECONDS = 0

export function focusDurationMs(durationMin: FocusDurationMin): number {
  return FOCUS_TEST_OVERRIDE_SECONDS > 0
    ? FOCUS_TEST_OVERRIDE_SECONDS * 1000
    : durationMin * 60_000
}

// Validation: do we recognize this duration tier at all?
export const FOCUS_DURATIONS = [5, 10, 15, 25, 50] as const
export type FocusDurationMin = (typeof FOCUS_DURATIONS)[number]
export function isFocusDuration(n: number): n is FocusDurationMin {
  return (FOCUS_DURATIONS as readonly number[]).includes(n)
}
