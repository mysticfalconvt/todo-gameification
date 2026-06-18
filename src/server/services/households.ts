// Households core: small shared groups built on the friends graph. A
// household has members with roles (admin/member/kid) and can own
// chores. XP/streak for a household chore goes to the completer — see
// completeInstance in services/tasks.ts. This module owns membership,
// invites, and the assertHouseholdRole helper that task services
// import.
import { and, desc, eq, gte, inArray, isNotNull, sql } from 'drizzle-orm'
import { db } from '../db/client'
import { auth } from '../auth'
import {
  events,
  householdInvites,
  householdMembers,
  households,
  tasks,
  user as userTable,
} from '../db/schema'
import {
  handleExists,
  isValidHandle,
  normalizeHandle,
} from './handles'
import { getMemberStatus } from './membership'
import { areFriends, ensureAcceptedFriendship } from './social'

export type Role = 'admin' | 'member' | 'kid' | 'kiosk'

// "Manageable" subset — roles a real person can have. Kiosk is
// excluded here because kiosk accounts are provisioned by admins via
// createManagedMember and shouldn't transition through changeRole.
export type ManageableRole = 'admin' | 'member' | 'kid'

// Default palette for new household members. Cycled by join order so
// the first member gets the first color, second the second, etc. Once
// assigned, a color sticks until the user picks a new one.
export const HOUSEHOLD_COLOR_PALETTE = [
  '#4fb8b2',
  '#f59e0b',
  '#a855f7',
  '#ef4444',
  '#22c55e',
  '#0ea5e9',
  '#ec4899',
  '#facc15',
] as const

const COLOR_HEX_RE = /^#[0-9a-fA-F]{6}$/

function pickNextColor(usedColors: ReadonlyArray<string | null>): string {
  const used = new Set(usedColors.filter((c): c is string => !!c))
  for (const c of HOUSEHOLD_COLOR_PALETTE) {
    if (!used.has(c)) return c
  }
  // Palette exhausted (>8 members) — fall through to the start of the
  // palette so colors repeat rather than landing on null.
  return HOUSEHOLD_COLOR_PALETTE[0]
}

export interface HouseholdMemberRow {
  userId: string
  handle: string
  name: string
  role: Role
  joinedAt: Date
  color: string | null
}

export interface MyHousehold {
  household: {
    id: string
    name: string
    createdByUserId: string
    createdAt: Date
  }
  role: Role
  members: HouseholdMemberRow[]
}

export interface HouseholdInviteRow {
  id: string
  householdId: string
  householdName: string
  inviterUserId: string
  inviterHandle: string
  inviterName: string
  proposedRole: 'member' | 'kid'
  createdAt: Date
}

// Find the membership row for a (user, household) pair. Returns null
// when the user is not in that household.
export async function getMembership(
  userId: string,
  householdId: string,
): Promise<{ role: Role } | null> {
  const row = await db.query.householdMembers.findFirst({
    where: and(
      eq(householdMembers.userId, userId),
      eq(householdMembers.householdId, householdId),
    ),
    columns: { role: true },
  })
  return row ? { role: row.role as Role } : null
}

// Find the (only) household a user is in, or null. Cheap; relies on the
// unique index on household_members.user_id.
export async function getMyMembership(
  userId: string,
): Promise<{ householdId: string; role: Role } | null> {
  const row = await db.query.householdMembers.findFirst({
    where: eq(householdMembers.userId, userId),
    columns: { householdId: true, role: true },
  })
  return row ? { householdId: row.householdId, role: row.role as Role } : null
}

export async function assertHouseholdRole(
  userId: string,
  householdId: string,
  allowed: Role[],
): Promise<void> {
  const m = await getMembership(userId, householdId)
  if (!m) throw new Error('Not a member of this household.')
  if (!allowed.includes(m.role)) {
    throw new Error('You do not have permission for this action.')
  }
}

// Households are paywalled at the *admin* level: the person creating
// the household (and growing it via invites or managed accounts) must
// be a paid member or active trial. Once they're set up, kid /
// member / kiosk accounts in the household don't need their own
// memberships — joining or being added to an admin's household is
// free. This keeps the family use case affordable (one parent pays;
// everyone else is included) while still gating the feature.
async function assertAdminIsMember(userId: string): Promise<void> {
  const status = await getMemberStatus(userId)
  if (!status.isMember) {
    throw new Error(
      'Household features require a Todo XP membership for the admin. Upgrade from Settings → Membership to create or grow a household.',
    )
  }
}

export async function createHousehold(
  userId: string,
  name: string,
): Promise<{ householdId: string }> {
  const trimmed = name.trim()
  if (!trimmed) throw new Error('Household name is required.')
  if (trimmed.length > 80) throw new Error('Household name is too long.')
  const existing = await getMyMembership(userId)
  if (existing) throw new Error('You are already in a household.')
  await assertAdminIsMember(userId)

  return db.transaction(async (tx) => {
    const [hh] = await tx
      .insert(households)
      .values({ name: trimmed, createdByUserId: userId })
      .returning({ id: households.id })
    if (!hh) throw new Error('Failed to create household.')
    await tx.insert(householdMembers).values({
      householdId: hh.id,
      userId,
      role: 'admin',
      color: HOUSEHOLD_COLOR_PALETTE[0],
    })
    // Joined-event for the creator so the activity feed has a starting
    // point ("Alice founded the household").
    await tx.insert(events).values({
      userId,
      type: 'household.member.joined',
      payload: { householdId: hh.id, role: 'admin' },
      occurredAt: new Date(),
    })
    return { householdId: hh.id }
  })
}

export async function getMyHousehold(
  userId: string,
): Promise<MyHousehold | null> {
  const m = await getMyMembership(userId)
  if (!m) return null
  const hh = await db.query.households.findFirst({
    where: eq(households.id, m.householdId),
  })
  if (!hh) return null
  const members = await listHouseholdMembers(userId, m.householdId)
  return {
    household: {
      id: hh.id,
      name: hh.name,
      createdByUserId: hh.createdByUserId,
      createdAt: hh.createdAt,
    },
    role: m.role,
    members,
  }
}

export async function listHouseholdMembers(
  viewerId: string,
  householdId: string,
): Promise<HouseholdMemberRow[]> {
  const m = await getMembership(viewerId, householdId)
  if (!m) throw new Error('Not a member of this household.')
  const rows = await db
    .select({
      userId: householdMembers.userId,
      role: householdMembers.role,
      joinedAt: householdMembers.joinedAt,
      color: householdMembers.color,
      handle: userTable.handle,
      name: userTable.name,
    })
    .from(householdMembers)
    .innerJoin(userTable, eq(userTable.id, householdMembers.userId))
    .where(eq(householdMembers.householdId, householdId))
    .orderBy(householdMembers.joinedAt)
  return rows.map((r) => ({
    userId: r.userId,
    handle: r.handle,
    name: r.name,
    role: r.role as Role,
    joinedAt: r.joinedAt,
    color: r.color,
  }))
}

// Kids are auto-friended with the rest of their household so they show
// up on family surfaces (leaderboard, activity, friends list) without
// going through the friend-request flow — which is blocked for kids.
// Idempotent: for every pair of members where at least one side is a
// kid, ensure an accepted friendship exists. Kiosk accounts are
// excluded — a kiosk is a shared device, not a person. Best-effort:
// called after membership changes; safe to call repeatedly.
export async function syncHouseholdKidFriendships(
  householdId: string,
): Promise<void> {
  const members = await db
    .select({ userId: householdMembers.userId, role: householdMembers.role })
    .from(householdMembers)
    .where(eq(householdMembers.householdId, householdId))
  const eligible = members.filter((m) => m.role !== 'kiosk')
  for (let i = 0; i < eligible.length; i++) {
    for (let j = i + 1; j < eligible.length; j++) {
      const a = eligible[i]
      const b = eligible[j]
      if (a.role !== 'kid' && b.role !== 'kid') continue
      await ensureAcceptedFriendship(a.userId, b.userId)
    }
  }
}

// Update one member's color. Permission: the member themselves OR a
// household admin. Color must be a 6-digit hex string (#rrggbb).
export async function updateMemberColor(
  actorId: string,
  targetUserId: string,
  color: string,
): Promise<void> {
  if (!COLOR_HEX_RE.test(color)) {
    throw new Error('Color must be a hex string like #4fb8b2.')
  }
  const actor = await getMyMembership(actorId)
  if (!actor) throw new Error('You are not in a household.')
  if (actorId !== targetUserId && actor.role !== 'admin') {
    throw new Error('Only admins can change another member’s color.')
  }
  const target = await getMembership(targetUserId, actor.householdId)
  if (!target) throw new Error('That user is not in your household.')
  await db
    .update(householdMembers)
    .set({ color })
    .where(
      and(
        eq(householdMembers.householdId, actor.householdId),
        eq(householdMembers.userId, targetUserId),
      ),
    )
}

// Send a household invite. Requires the inviter to be a household admin
// and the invitee to be an existing friend. Accept-time deliberately
// does NOT re-check friendship — so an unfriend after invite doesn't
// orphan the invitee.
export async function inviteMember(
  inviterId: string,
  inviteeId: string,
  proposedRole: 'member' | 'kid',
): Promise<{ inviteId: string }> {
  if (inviterId === inviteeId) {
    throw new Error("You can't invite yourself.")
  }
  const inviter = await getMyMembership(inviterId)
  if (!inviter) throw new Error('You are not in a household.')
  if (inviter.role !== 'admin') {
    throw new Error('Only household admins can invite.')
  }
  await assertAdminIsMember(inviterId)
  const friends = await areFriends(inviterId, inviteeId)
  if (!friends) {
    throw new Error('You can only invite users you are friends with.')
  }
  const inviteeMembership = await getMyMembership(inviteeId)
  if (inviteeMembership) {
    if (inviteeMembership.householdId === inviter.householdId) {
      throw new Error('That user is already in this household.')
    }
    throw new Error('That user is already in another household.')
  }
  // De-dup: if there's already a pending invite for this pair, return it.
  const pending = await db.query.householdInvites.findFirst({
    where: and(
      eq(householdInvites.householdId, inviter.householdId),
      eq(householdInvites.inviteeUserId, inviteeId),
      eq(householdInvites.status, 'pending'),
    ),
    columns: { id: true },
  })
  if (pending) return { inviteId: pending.id }

  const [row] = await db
    .insert(householdInvites)
    .values({
      householdId: inviter.householdId,
      inviterUserId: inviterId,
      inviteeUserId: inviteeId,
      proposedRole,
    })
    .returning({ id: householdInvites.id })
  if (!row) throw new Error('Failed to create invite.')
  return { inviteId: row.id }
}

export async function listMyInvites(
  userId: string,
): Promise<HouseholdInviteRow[]> {
  const rows = await db
    .select({
      id: householdInvites.id,
      householdId: householdInvites.householdId,
      householdName: households.name,
      inviterUserId: householdInvites.inviterUserId,
      inviterHandle: userTable.handle,
      inviterName: userTable.name,
      proposedRole: householdInvites.proposedRole,
      createdAt: householdInvites.createdAt,
    })
    .from(householdInvites)
    .innerJoin(households, eq(households.id, householdInvites.householdId))
    .innerJoin(userTable, eq(userTable.id, householdInvites.inviterUserId))
    .where(
      and(
        eq(householdInvites.inviteeUserId, userId),
        eq(householdInvites.status, 'pending'),
      ),
    )
    .orderBy(desc(householdInvites.createdAt))
  return rows.map((r) => ({
    id: r.id,
    householdId: r.householdId,
    householdName: r.householdName,
    inviterUserId: r.inviterUserId,
    inviterHandle: r.inviterHandle,
    inviterName: r.inviterName,
    proposedRole: r.proposedRole as 'member' | 'kid',
    createdAt: r.createdAt,
  }))
}

export async function listOutgoingInvites(
  adminId: string,
): Promise<Array<{
  id: string
  inviteeUserId: string
  inviteeHandle: string
  inviteeName: string
  proposedRole: 'member' | 'kid'
  createdAt: Date
}>> {
  const m = await getMyMembership(adminId)
  if (!m || m.role !== 'admin') return []
  const rows = await db
    .select({
      id: householdInvites.id,
      inviteeUserId: householdInvites.inviteeUserId,
      inviteeHandle: userTable.handle,
      inviteeName: userTable.name,
      proposedRole: householdInvites.proposedRole,
      createdAt: householdInvites.createdAt,
    })
    .from(householdInvites)
    .innerJoin(userTable, eq(userTable.id, householdInvites.inviteeUserId))
    .where(
      and(
        eq(householdInvites.householdId, m.householdId),
        eq(householdInvites.status, 'pending'),
      ),
    )
    .orderBy(desc(householdInvites.createdAt))
  return rows.map((r) => ({
    id: r.id,
    inviteeUserId: r.inviteeUserId,
    inviteeHandle: r.inviteeHandle,
    inviteeName: r.inviteeName,
    proposedRole: r.proposedRole as 'member' | 'kid',
    createdAt: r.createdAt,
  }))
}

export async function acceptInvite(
  userId: string,
  inviteId: string,
): Promise<{ householdId: string }> {
  const result = await db.transaction(async (tx) => {
    const invite = await tx.query.householdInvites.findFirst({
      where: and(
        eq(householdInvites.id, inviteId),
        eq(householdInvites.inviteeUserId, userId),
        eq(householdInvites.status, 'pending'),
      ),
    })
    if (!invite) throw new Error('Invite not found or already handled.')

    const existing = await tx.query.householdMembers.findFirst({
      where: eq(householdMembers.userId, userId),
      columns: { householdId: true },
    })
    if (existing) {
      // Mark this invite cancelled so it doesn't sit pending forever.
      await tx
        .update(householdInvites)
        .set({ status: 'cancelled', respondedAt: new Date() })
        .where(eq(householdInvites.id, inviteId))
      throw new Error('You are already in a household.')
    }

    // Pick the next free palette color for the joiner based on
    // colors already used in this household.
    const peers = await tx
      .select({ color: householdMembers.color })
      .from(householdMembers)
      .where(eq(householdMembers.householdId, invite.householdId))
    const color = pickNextColor(peers.map((r) => r.color))
    await tx.insert(householdMembers).values({
      householdId: invite.householdId,
      userId,
      role: invite.proposedRole as Role,
      color,
    })
    await tx.insert(events).values({
      userId,
      type: 'household.member.joined',
      payload: {
        householdId: invite.householdId,
        role: invite.proposedRole,
      },
      occurredAt: new Date(),
    })
    await tx
      .update(householdInvites)
      .set({ status: 'accepted', respondedAt: new Date() })
      .where(eq(householdInvites.id, inviteId))
    return { householdId: invite.householdId }
  })
  // Wire up auto-friendships once the membership row is committed. A kid
  // joining (or a member joining a household that already has kids) gets
  // auto-friended with the family.
  await syncHouseholdKidFriendships(result.householdId)
  return result
}

export async function declineInvite(
  userId: string,
  inviteId: string,
): Promise<void> {
  await db
    .update(householdInvites)
    .set({ status: 'declined', respondedAt: new Date() })
    .where(
      and(
        eq(householdInvites.id, inviteId),
        eq(householdInvites.inviteeUserId, userId),
        eq(householdInvites.status, 'pending'),
      ),
    )
}

export async function cancelInvite(
  adminId: string,
  inviteId: string,
): Promise<void> {
  const invite = await db.query.householdInvites.findFirst({
    where: eq(householdInvites.id, inviteId),
    columns: { householdId: true, status: true },
  })
  if (!invite || invite.status !== 'pending') return
  await assertHouseholdRole(adminId, invite.householdId, ['admin'])
  await db
    .update(householdInvites)
    .set({ status: 'cancelled', respondedAt: new Date() })
    .where(eq(householdInvites.id, inviteId))
}

// Count of admins remaining if we remove `targetUserId`. Used to block
// removal/demotion that would leave a household with no admin.
async function adminCountExcluding(
  householdId: string,
  excludeUserId: string,
): Promise<number> {
  const rows = await db
    .select({ c: sql<number>`count(*)::int` })
    .from(householdMembers)
    .where(
      and(
        eq(householdMembers.householdId, householdId),
        eq(householdMembers.role, 'admin'),
        sql`${householdMembers.userId} <> ${excludeUserId}`,
      ),
    )
  return rows[0]?.c ?? 0
}

export async function removeMember(
  adminId: string,
  householdId: string,
  targetUserId: string,
): Promise<void> {
  await assertHouseholdRole(adminId, householdId, ['admin'])
  if (adminId === targetUserId) {
    throw new Error('Use leaveHousehold to remove yourself.')
  }
  const target = await getMembership(targetUserId, householdId)
  if (!target) throw new Error('That user is not in this household.')
  if (target.role === 'admin') {
    const remaining = await adminCountExcluding(householdId, targetUserId)
    if (remaining < 1) {
      throw new Error('Cannot remove the last admin.')
    }
  }
  await db.transaction(async (tx) => {
    await tx
      .delete(householdMembers)
      .where(
        and(
          eq(householdMembers.householdId, householdId),
          eq(householdMembers.userId, targetUserId),
        ),
      )
    // Event belongs to the departing user, so it stays attributable to
    // them in the activity feed even after they leave.
    await tx.insert(events).values({
      userId: targetUserId,
      type: 'household.member.left',
      payload: { householdId },
      occurredAt: new Date(),
    })
  })
}

export async function leaveHousehold(userId: string): Promise<void> {
  const m = await getMyMembership(userId)
  if (!m) return
  if (m.role === 'admin') {
    const remaining = await adminCountExcluding(m.householdId, userId)
    if (remaining < 1) {
      throw new Error(
        'Promote another admin before leaving (you are the last admin).',
      )
    }
  }
  await db.transaction(async (tx) => {
    await tx
      .delete(householdMembers)
      .where(
        and(
          eq(householdMembers.householdId, m.householdId),
          eq(householdMembers.userId, userId),
        ),
      )
    await tx.insert(events).values({
      userId,
      type: 'household.member.left',
      payload: { householdId: m.householdId },
      occurredAt: new Date(),
    })
  })
}

export async function changeRole(
  adminId: string,
  targetUserId: string,
  role: ManageableRole,
): Promise<void> {
  const m = await getMyMembership(adminId)
  if (!m || m.role !== 'admin') {
    throw new Error('Only admins can change roles.')
  }
  if (adminId === targetUserId && role !== 'admin') {
    const remaining = await adminCountExcluding(m.householdId, adminId)
    if (remaining < 1) {
      throw new Error('Promote another admin before demoting yourself.')
    }
  }
  const target = await getMembership(targetUserId, m.householdId)
  if (!target) throw new Error('That user is not in this household.')
  // Kiosk accounts are admin-provisioned and shouldn't be promoted
  // into a real person's role via this path — they'd inherit family-
  // member powers but lack a real identity. Same for the reverse.
  if (target.role === 'kiosk') {
    throw new Error('Kiosk accounts cannot be promoted to a person role.')
  }
  if (target.role === 'admin' && role !== 'admin') {
    const remaining = await adminCountExcluding(m.householdId, targetUserId)
    if (remaining < 1) {
      throw new Error('Cannot demote the last admin.')
    }
  }
  await db
    .update(householdMembers)
    .set({ role })
    .where(
      and(
        eq(householdMembers.householdId, m.householdId),
        eq(householdMembers.userId, targetUserId),
      ),
    )
  // Promoting someone to kid should auto-friend them with the family.
  // (Demotions don't tear friendships down — leaving stale auto-friend
  // edges is harmless and avoids clobbering anything intentional.)
  if (role === 'kid') {
    await syncHouseholdKidFriendships(m.householdId)
  }
}

export async function renameHousehold(
  adminId: string,
  householdId: string,
  name: string,
): Promise<void> {
  await assertHouseholdRole(adminId, householdId, ['admin'])
  const trimmed = name.trim()
  if (!trimmed) throw new Error('Household name is required.')
  if (trimmed.length > 80) throw new Error('Household name is too long.')
  await db
    .update(households)
    .set({ name: trimmed, updatedAt: new Date() })
    .where(eq(households.id, householdId))
}

export async function deleteHousehold(
  adminId: string,
  householdId: string,
): Promise<void> {
  await assertHouseholdRole(adminId, householdId, ['admin'])
  await db.delete(households).where(eq(households.id, householdId))
}

export interface CreateManagedMemberInput {
  name: string
  handle: string
  password: string
  email?: string | null
  role: 'kid' | 'kiosk'
}

export interface CreateManagedMemberResult {
  userId: string
  name: string
  handle: string
  email: string
  role: 'kid' | 'kiosk'
}

// Admin provisions a kid or kiosk account directly (no friend invite,
// no email signup loop).
//
// IMPORTANT: this calls better-auth's *internal adapter* rather than
// auth.api.signUpEmail. The HTTP-endpoint API has side effects we
// don't want here:
//   - Fires `sendVerificationEmail` (would email `@managed.local` —
//     a real outbound message rejected nowhere and indistinguishable
//     from a typo in the logs).
//   - Sets Set-Cookie response headers (would silently swap the
//     admin's session for the newly-created kiosk/kid).
// Using the adapter directly keeps creation pure data — no auto
// session, no transactional email, no surprises.
//
// If the admin doesn't supply an email, a synthetic
// `<handle>@managed.local` is used. We mark `emailVerified = true`
// for every managed account regardless of email source: the admin
// vouches for the account at creation time, and there's no
// inbox-confirmation flow for synthetic addresses.
export async function createManagedMember(
  adminId: string,
  input: CreateManagedMemberInput,
): Promise<CreateManagedMemberResult> {
  const my = await getMyMembership(adminId)
  if (!my) throw new Error('You are not in a household.')
  if (my.role !== 'admin') {
    throw new Error('Only admins can add managed accounts.')
  }
  await assertAdminIsMember(adminId)
  const householdId = my.householdId

  const name = input.name.trim()
  if (!name) throw new Error('Name is required.')
  if (name.length > 80) throw new Error('Name is too long.')

  const handle = normalizeHandle(input.handle)
  if (!isValidHandle(handle)) {
    throw new Error(
      'Handle must be 3–20 characters, lowercase letters, numbers, or underscores.',
    )
  }
  if (await handleExists(handle)) {
    throw new Error('That handle is already taken.')
  }

  const password = input.password
  if (password.length < 8) {
    throw new Error('Password must be at least 8 characters.')
  }

  if (input.role !== 'kid' && input.role !== 'kiosk') {
    throw new Error('Role must be "kid" or "kiosk".')
  }

  const trimmedEmail = (input.email ?? '').trim().toLowerCase()
  const email = trimmedEmail || `${handle}@managed.local`

  // Reject duplicate email up-front rather than letting better-auth's
  // unique constraint surface as a 500.
  const existingEmail = await db
    .select({ id: userTable.id })
    .from(userTable)
    .where(sql`lower(${userTable.email}) = lower(${email})`)
    .limit(1)
  if (existingEmail.length > 0) {
    throw new Error('That email is already in use.')
  }

  const ctx = await auth.$context
  const passwordHash = await ctx.password.hash(password)

  // `internalAdapter.createUser` still triggers our databaseHooks
  // (handle auto-generation + bootstrapNewUser). The handle we want
  // is set by the admin; we overwrite the auto-generated value below.
  // Pass emailVerified directly so the user can sign in immediately —
  // no verification email is sent because we're never going through
  // `sendVerificationEmail`.
  const createdUser = await ctx.internalAdapter.createUser({
    email,
    name,
    emailVerified: true,
  })
  if (!createdUser?.id) {
    throw new Error('Failed to create managed account.')
  }
  const userId = createdUser.id

  await ctx.internalAdapter.linkAccount({
    userId,
    providerId: 'credential',
    accountId: userId,
    password: passwordHash,
  })

  // Patch handle (auto-generator ran during createUser; we want the
  // admin's choice) and ensure emailVerified stays true in case any
  // hook flipped it.
  await db
    .update(userTable)
    .set({
      handle,
      emailVerified: true,
      updatedAt: new Date(),
    })
    .where(eq(userTable.id, userId))

  // Pick next palette color for this household.
  const peers = await db
    .select({ color: householdMembers.color })
    .from(householdMembers)
    .where(eq(householdMembers.householdId, householdId))
  const color = pickNextColor(peers.map((r) => r.color))

  await db.insert(householdMembers).values({
    householdId,
    userId,
    role: input.role,
    color,
  })

  await db.insert(events).values({
    userId,
    type: 'household.member.joined',
    payload: { householdId, role: input.role },
    occurredAt: new Date(),
  })

  // A newly-provisioned kid is auto-friended with the rest of the
  // household. (Kiosk accounts are excluded inside the helper.)
  await syncHouseholdKidFriendships(householdId)

  return {
    userId,
    name,
    handle,
    email,
    role: input.role,
  }
}

// Admin resets a managed member's password. Uses better-auth's admin
// reset path (sets a new password directly without an email
// round-trip). Only allowed for kid + kiosk accounts in the admin's
// household — real adult accounts manage their own password.
export async function resetManagedMemberPassword(
  adminId: string,
  targetUserId: string,
  newPassword: string,
): Promise<void> {
  const my = await getMyMembership(adminId)
  if (!my) throw new Error('You are not in a household.')
  if (my.role !== 'admin') {
    throw new Error('Only admins can reset passwords.')
  }
  const target = await getMembership(targetUserId, my.householdId)
  if (!target) throw new Error('That user is not in your household.')
  if (target.role !== 'kid' && target.role !== 'kiosk') {
    throw new Error(
      'Only kid + kiosk passwords can be admin-reset. Adult members manage their own.',
    )
  }
  if (newPassword.length < 8) {
    throw new Error('Password must be at least 8 characters.')
  }
  // better-auth's adapter exposes a `ctx.internalAdapter.updatePassword`
  // utility, but the cleanest surface is the public setUserPassword
  // server action via the internal context. We just rewrite the
  // credential account directly using better-auth's password hasher
  // for parity with signUpEmail.
  const ctx = await auth.$context
  const hashed = await ctx.password.hash(newPassword)
  await ctx.internalAdapter.updatePassword(targetUserId, hashed)
}

export interface HouseholdMemberStats {
  userId: string
  name: string
  handle: string
  color: string | null
  totalXp: number
  totalCount: number
  // daily[i] aligns to dateKeys[i] (same index across all members).
  daily: number[]
  dailyCount: number[]
}

export interface HouseholdStatsResult {
  // ISO yyyy-MM-dd in the viewer's tz, oldest → newest. The frontend
  // can render straight from these without re-deriving the timeline.
  dateKeys: string[]
  totalCompletions: number
  members: HouseholdMemberStats[]
}

// Per-member daily XP + completion counts within a rolling window.
// Backed by the partial events index on payload->>'householdId' from
// migration 0034. XP per completion is derived the same way the
// leaderboard does it (xpOverride from payload, else difficulty
// default) so totals match.
export async function listHouseholdStats(
  viewerId: string,
  householdId: string,
  days: number,
): Promise<HouseholdStatsResult> {
  await assertHouseholdRole(viewerId, householdId, ['admin', 'member', 'kid', 'kiosk'])
  const windowDays = Math.min(Math.max(Math.floor(days), 1), 365)

  // Pull household members so users with zero activity still show
  // up at 0. Exclude kiosk accounts — they're a shared device, not
  // a person to rank, and they never accumulate XP themselves
  // (every kiosk completion credits a real family member).
  const allMembers = await listHouseholdMembers(viewerId, householdId)
  const members = allMembers.filter((m) => m.role !== 'kiosk')
  if (members.length === 0) {
    return { dateKeys: [], totalCompletions: 0, members: [] }
  }

  // Use the viewer's tz for date bucketing so the chart aligns to the
  // viewer's calendar regardless of when each member completed.
  const viewer = await db.query.user.findFirst({
    where: eq(userTable.id, viewerId),
    columns: { timezone: true },
  })
  const timeZone = viewer?.timezone ?? 'UTC'

  // Build the date key list once, ordered oldest -> newest.
  const dateKeys: string[] = []
  const today = new Date()
  for (let i = windowDays - 1; i >= 0; i--) {
    const d = new Date(today.getTime() - i * 24 * 3_600_000)
    dateKeys.push(
      new Intl.DateTimeFormat('en-CA', {
        timeZone,
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
      }).format(d),
    )
  }
  const dateIndex = new Map(dateKeys.map((k, i) => [k, i]))

  // Initialize per-member buckets.
  const byUser = new Map<string, HouseholdMemberStats>()
  for (const m of members) {
    byUser.set(m.userId, {
      userId: m.userId,
      name: m.name,
      handle: m.handle,
      color: m.color,
      totalXp: 0,
      totalCount: 0,
      daily: new Array(dateKeys.length).fill(0),
      dailyCount: new Array(dateKeys.length).fill(0),
    })
  }

  // Pull household completion events in the window.
  const since = new Date(today.getTime() - windowDays * 24 * 3_600_000)
  const rows = await db
    .select({
      userId: events.userId,
      payload: events.payload,
      occurredAt: events.occurredAt,
    })
    .from(events)
    .where(
      and(
        eq(events.type, 'task.completed'),
        isNotNull(events.occurredAt),
        gte(events.occurredAt, since),
        sql`${events.payload}->>'householdId' = ${householdId}`,
      ),
    )

  let total = 0
  for (const r of rows) {
    const bucket = byUser.get(r.userId)
    if (!bucket || !r.occurredAt) continue
    const localDay = new Intl.DateTimeFormat('en-CA', {
      timeZone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    }).format(r.occurredAt)
    const idx = dateIndex.get(localDay)
    if (idx === undefined) continue
    const p =
      r.payload && typeof r.payload === 'object'
        ? (r.payload as Record<string, unknown>)
        : {}
    const xpOverride =
      typeof p['xpOverride'] === 'number' ? (p['xpOverride'] as number) : null
    const difficulty =
      typeof p['difficulty'] === 'string' ? (p['difficulty'] as string) : null
    const xp =
      xpOverride ??
      (difficulty === 'small' ? 10 : difficulty === 'large' ? 60 : 25)
    bucket.daily[idx] += xp
    bucket.dailyCount[idx] += 1
    bucket.totalXp += xp
    bucket.totalCount += 1
    total += 1
  }

  return {
    dateKeys,
    totalCompletions: total,
    members: Array.from(byUser.values()).sort((a, b) => b.totalXp - a.totalXp),
  }
}

export interface HouseholdActivityRow {
  eventId: string
  type: 'task.completed' | 'household.member.joined' | 'household.member.left'
  userId: string
  handle: string
  name: string
  occurredAt: Date
  // task.completed only
  taskId: string | null
  taskTitle: string | null
  xp: number | null
  completedAs:
    | 'personal'
    | 'assigned'
    | 'free_for_all'
    | null
  // household.member.joined only
  role: Role | null
}

// Recent activity in this household: chore completions credited to any
// member, plus join/leave events. Caller must be a household member.
// Backed by the events table — task completions are filtered via the
// partial index on `events ((payload->>'householdId'))` from migration
// 0034; join/left events are looked up by payload.householdId as well.
export async function listHouseholdActivity(
  viewerId: string,
  householdId: string,
  opts: { days?: number; limit?: number } = {},
): Promise<HouseholdActivityRow[]> {
  await assertHouseholdRole(viewerId, householdId, ['admin', 'member', 'kid', 'kiosk'])
  const days = Math.min(Math.max(opts.days ?? 30, 1), 365)
  const limit = Math.min(Math.max(opts.limit ?? 50, 1), 200)
  const since = new Date(Date.now() - days * 24 * 3_600_000)

  // Pull completions in the household. The join against `tasks` is a
  // left join because a task might have been deleted since completion;
  // we still want the activity row, just with title=null.
  const completionRows = await db
    .select({
      id: events.id,
      userId: events.userId,
      payload: events.payload,
      occurredAt: events.occurredAt,
      taskId: tasks.id,
      taskTitle: tasks.title,
    })
    .from(events)
    .leftJoin(tasks, eq(tasks.id, sql`(${events.payload}->>'taskId')::uuid`))
    .where(
      and(
        eq(events.type, 'task.completed'),
        isNotNull(events.occurredAt),
        gte(events.occurredAt, since),
        sql`${events.payload}->>'householdId' = ${householdId}`,
      ),
    )
    .orderBy(desc(events.occurredAt))
    .limit(limit)

  // Pull membership events too. Either type, scoped to this household.
  const membershipRows = await db
    .select({
      id: events.id,
      userId: events.userId,
      type: events.type,
      payload: events.payload,
      occurredAt: events.occurredAt,
    })
    .from(events)
    .where(
      and(
        inArray(events.type, [
          'household.member.joined',
          'household.member.left',
        ]),
        isNotNull(events.occurredAt),
        gte(events.occurredAt, since),
        sql`${events.payload}->>'householdId' = ${householdId}`,
      ),
    )
    .orderBy(desc(events.occurredAt))
    .limit(limit)

  // Resolve user display info for every actor seen in either result set.
  const actorIds = Array.from(
    new Set([
      ...completionRows.map((r) => r.userId),
      ...membershipRows.map((r) => r.userId),
    ]),
  )
  if (actorIds.length === 0) return []
  const userRows = await db
    .select({
      id: userTable.id,
      handle: userTable.handle,
      name: userTable.name,
    })
    .from(userTable)
    .where(inArray(userTable.id, actorIds))
  const userById = new Map(userRows.map((u) => [u.id, u]))

  const out: HouseholdActivityRow[] = []
  for (const r of completionRows) {
    if (!r.occurredAt) continue
    const u = userById.get(r.userId)
    if (!u) continue
    const p =
      r.payload && typeof r.payload === 'object'
        ? (r.payload as Record<string, unknown>)
        : {}
    const xpOverride =
      typeof p['xpOverride'] === 'number' ? (p['xpOverride'] as number) : null
    const difficulty =
      typeof p['difficulty'] === 'string' ? (p['difficulty'] as string) : null
    const xp =
      xpOverride ??
      (difficulty === 'small' ? 10 : difficulty === 'large' ? 60 : 25)
    const completedAs =
      p['completedAs'] === 'personal' ||
      p['completedAs'] === 'assigned' ||
      p['completedAs'] === 'free_for_all'
        ? (p['completedAs'] as 'personal' | 'assigned' | 'free_for_all')
        : null
    out.push({
      eventId: r.id,
      type: 'task.completed',
      userId: u.id,
      handle: u.handle,
      name: u.name,
      occurredAt: r.occurredAt,
      taskId: r.taskId,
      taskTitle: r.taskTitle,
      xp,
      completedAs,
      role: null,
    })
  }
  for (const r of membershipRows) {
    if (!r.occurredAt) continue
    const u = userById.get(r.userId)
    if (!u) continue
    const p =
      r.payload && typeof r.payload === 'object'
        ? (r.payload as Record<string, unknown>)
        : {}
    const role =
      r.type === 'household.member.joined' &&
      (p['role'] === 'admin' || p['role'] === 'member' || p['role'] === 'kid')
        ? (p['role'] as Role)
        : null
    out.push({
      eventId: r.id,
      type: r.type as 'household.member.joined' | 'household.member.left',
      userId: u.id,
      handle: u.handle,
      name: u.name,
      occurredAt: r.occurredAt,
      taskId: null,
      taskTitle: null,
      xp: null,
      completedAs: null,
      role,
    })
  }
  // Sort merged stream by recency and cap to the limit.
  out.sort((a, b) => b.occurredAt.getTime() - a.occurredAt.getTime())
  return out.slice(0, limit)
}
