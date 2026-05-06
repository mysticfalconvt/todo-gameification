// Feature request submission. Any authenticated user can submit a request;
// the system creates a today-due task in every admin's account (deduped per
// admin via external_ref) and sends a single email to the ADMIN_EMAILS list.
//
// Tasks created here go through the same createTask path as user-created
// tasks, so xp scoring + categorization run against each admin's category
// set automatically.
import { eq } from 'drizzle-orm'
import { db } from '../db/client'
import { user as userTable } from '../db/schema'
import { sendMail } from '../email'
import { listAdminEmails, listAdminUsers } from './admin'
import { createTask } from './tasks'

export interface SubmitFeatureRequestInput {
  title: string
  description: string
}

export interface SubmitFeatureRequestResult {
  adminTaskCount: number
  emailsSent: number
}

export async function submitFeatureRequest(
  submitterUserId: string,
  input: SubmitFeatureRequestInput,
): Promise<SubmitFeatureRequestResult> {
  const title = input.title.trim()
  const description = input.description.trim()
  if (!title) throw new Error('Title is required')
  if (!description) throw new Error('Description is required')
  if (title.length > 200) throw new Error('Title is too long (max 200 chars)')
  if (description.length > 4000) {
    throw new Error('Description is too long (max 4000 chars)')
  }

  const admins = await listAdminUsers()
  if (admins.length === 0) {
    throw new Error(
      'No admins configured to receive feature requests. Please contact support directly.',
    )
  }

  const submitter = await db.query.user.findFirst({
    where: eq(userTable.id, submitterUserId),
    columns: { handle: true, email: true, name: true },
  })
  const submitterHandle = submitter?.handle ?? 'unknown'
  const submitterEmail = submitter?.email ?? 'unknown'
  const submittedAt = new Date()

  const submissionId =
    (typeof globalThis.crypto?.randomUUID === 'function'
      ? globalThis.crypto.randomUUID()
      : `${Date.now()}-${Math.random().toString(36).slice(2)}`)

  const dateLabel = submittedAt.toISOString().slice(0, 10)
  const notesBody = [
    `Submitted by @${submitterHandle} (${submitterEmail}) on ${dateLabel}`,
    '',
    description,
  ].join('\n')

  const taskTitle = `[Feature Request] ${title}`

  let adminTaskCount = 0
  for (const admin of admins) {
    try {
      await createTask(admin.id, {
        title: taskTitle,
        notes: notesBody,
        difficulty: 'medium',
        recurrence: null,
        timeOfDay: null,
        someday: false,
        dueKind: 'hard',
      })
      adminTaskCount += 1
    } catch (err) {
      console.error(
        `[featureRequests] failed to create task for admin ${admin.id}:`,
        err,
      )
    }
  }

  let emailsSent = 0
  const adminEmails = listAdminEmails()
  if (adminEmails.length > 0) {
    const subject = `New feature request: ${title}`
    const text = [
      `New feature request from @${submitterHandle} (${submitterEmail})`,
      '',
      title,
      '',
      description,
      '',
      `A task has been added to each admin's list (submission id ${submissionId}).`,
    ].join('\n')
    try {
      await sendMail({ to: adminEmails.join(', '), subject, text })
      emailsSent = adminEmails.length
    } catch (err) {
      console.error('[featureRequests] email send failed:', err)
    }
  }

  return { adminTaskCount, emailsSent }
}
