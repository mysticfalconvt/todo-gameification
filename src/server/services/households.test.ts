import { eq } from 'drizzle-orm'
import { describe, expect, it } from 'vitest'
import { withTestUsers, type TestUser } from '../../test/helpers'
import { auth } from '../auth'
import { db } from '../db/client'
import { account, householdMembers, households, session } from '../db/schema'
import { resetManagedMemberPassword } from './households'

interface ManagedHousehold {
  admin: TestUser
  kid: TestUser
  member: TestUser
  kidPasswordHash: string
}

async function withManagedHousehold(
  fn: (fixture: ManagedHousehold) => Promise<void>,
): Promise<void> {
  await withTestUsers(3, async ([admin, kid, member]) => {
    const [household] = await db
      .insert(households)
      .values({ name: 'Test household', createdByUserId: admin.id })
      .returning({ id: households.id })
    const ctx = await auth.$context
    const kidPasswordHash = await ctx.password.hash('old-password')

    try {
      await db.insert(householdMembers).values([
        { householdId: household.id, userId: admin.id, role: 'admin' },
        { householdId: household.id, userId: kid.id, role: 'kid' },
        { householdId: household.id, userId: member.id, role: 'member' },
      ])
      await db.insert(account).values({
        id: `account_${kid.id}`,
        accountId: kid.id,
        providerId: 'credential',
        userId: kid.id,
        password: kidPasswordHash,
      })
      await db.insert(session).values([
        {
          id: `session_${admin.id}`,
          token: `token_${admin.id}`,
          userId: admin.id,
          expiresAt: new Date(Date.now() + 60_000),
        },
        {
          id: `session_${kid.id}`,
          token: `token_${kid.id}`,
          userId: kid.id,
          expiresAt: new Date(Date.now() + 60_000),
        },
      ])
      await fn({ admin, kid, member, kidPasswordHash })
    } finally {
      await db.delete(households).where(eq(households.id, household.id))
    }
  })
}

describe('managed household password reset', () => {
  it('updates the password and revokes only the managed member sessions', async () => {
    await withManagedHousehold(async ({ admin, kid }) => {
      await resetManagedMemberPassword(admin.id, kid.id, 'new-password')

      const credential = await db.query.account.findFirst({
        where: eq(account.userId, kid.id),
        columns: { password: true },
      })
      const sessions = await db.select().from(session)
      const ctx = await auth.$context

      expect(credential?.password).toBeTruthy()
      expect(
        await ctx.password.verify({ hash: credential?.password ?? '', password: 'new-password' }),
      ).toBe(true)
      expect(sessions.some((row) => row.userId === kid.id)).toBe(false)
      expect(sessions.some((row) => row.userId === admin.id)).toBe(true)
    })
  })

  it('rejects resets by non-admin household members', async () => {
    await withManagedHousehold(async ({ member, kid, kidPasswordHash }) => {
      await expect(resetManagedMemberPassword(member.id, kid.id, 'new-password')).rejects.toThrow(
        /only admins/i,
      )
      const credential = await db.query.account.findFirst({
        where: eq(account.userId, kid.id),
        columns: { password: true },
      })
      expect(credential?.password).toBe(kidPasswordHash)
    })
  })

  it('enforces Better Auth password length limits', async () => {
    await withManagedHousehold(async ({ admin, kid }) => {
      await expect(resetManagedMemberPassword(admin.id, kid.id, 'short')).rejects.toThrow(
        /at least 8/i,
      )
      await expect(resetManagedMemberPassword(admin.id, kid.id, 'x'.repeat(129))).rejects.toThrow(
        /at most 128/i,
      )
    })
  })
})
