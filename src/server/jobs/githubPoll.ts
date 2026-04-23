// Every minute the scheduler fires this handler. It loads users whose
// per-user poll interval has elapsed (see listDueUsers) and runs the
// GitHub sync for each. One bad token writes to last_poll_error on
// that integration row but never fails the cron tick for other users.
import { listDueUsers, syncReviewTasksForUser } from '../services/github'

export async function githubPollHandler(): Promise<void> {
  const dueUsers = await listDueUsers()
  if (dueUsers.length === 0) return

  await Promise.allSettled(
    dueUsers.map(async (userId) => {
      try {
        await syncReviewTasksForUser(userId)
      } catch (err) {
        console.error('[github-poll] sync failed for', userId, err)
      }
    }),
  )
}
