// Queue names and job payload shapes. Deliberately dependency-free.
//
// This module exists to break a cycle. `boss.ts` needs the queue names and
// payload types to schedule work; the job handlers need them to type their
// arguments. If either side owned them, the other would have to import it —
// and since handlers import services, and services schedule jobs, that closed
// the loop boss.ts → jobs/* → services/* → boss.ts.
//
// Keep this file free of imports. Anything added here that reaches into the
// db, services or pg-boss re-opens the cycle.

export const REMINDER_QUEUE = 'send-reminder'
export const CLEANUP_SUBS_QUEUE = 'cleanup-stale-subs'
export const PLANT_RISK_QUEUE = 'check-plant-risk'
export const GITHUB_POLL_QUEUE = 'poll-github'
export const WEEKLY_SUMMARY_QUEUE = 'send-weekly-summary'
export const FOCUS_END_QUEUE = 'focus-session-end'
export const FOCUS_EXPIRE_QUEUE = 'focus-session-expire'
export const DOOMSCROLL_END_QUEUE = 'doomscroll-end'

// Every queue that must exist before anything can be sent to it.
export const ALL_QUEUES = [
  REMINDER_QUEUE,
  CLEANUP_SUBS_QUEUE,
  PLANT_RISK_QUEUE,
  GITHUB_POLL_QUEUE,
  WEEKLY_SUMMARY_QUEUE,
  FOCUS_END_QUEUE,
  FOCUS_EXPIRE_QUEUE,
  DOOMSCROLL_END_QUEUE,
] as const

export interface SendReminderJobData {
  taskInstanceId: string
  // Attempt number: 1 = initial reminder, 2..MAX = escalation nudges.
  // Legacy jobs that predate the escalation work will be missing this
  // field; handler defaults to 1 to keep them behaving as before.
  attempt?: number
}

export interface FocusSessionEndJobData {
  startEventId: string
  userId: string
}

export interface FocusSessionExpireJobData {
  startEventId: string
  userId: string
}

export interface DoomScrollEndJobData {
  startEventId: string
  userId: string
  durationMin: number
}
