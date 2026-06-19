// Thin Start server-function wrappers around services/households.ts.
// Auth + input shape only; business logic stays in the service so the
// REST routes under /api/v1 can reuse it with token auth.
import { createServerFn } from '@tanstack/react-start'
import { authMiddleware } from '../middleware/auth'
import * as service from '../services/households'
import {
  approveClaim,
  getStats,
  listHouseholdChores,
  listHouseholdChoresWeek,
  listPendingApprovals,
  rejectClaim,
} from '../services/tasks'

export const createHouseholdFn = createServerFn({ method: 'POST' })
  .middleware([authMiddleware])
  .inputValidator((data: { name: string }) => {
    if (typeof data.name !== 'string' || !data.name.trim()) {
      throw new Error('Household name is required.')
    }
    return { name: data.name.trim() }
  })
  .handler(({ data, context }) => service.createHousehold(context.userId, data.name))

export const getMyHouseholdFn = createServerFn({ method: 'GET' })
  .middleware([authMiddleware])
  .handler(({ context }) => service.getMyHousehold(context.userId))

export const listHouseholdMembersFn = createServerFn({ method: 'GET' })
  .middleware([authMiddleware])
  .inputValidator((data: { householdId: string }) => data)
  .handler(({ data, context }) =>
    service.listHouseholdMembers(context.userId, data.householdId),
  )

export const inviteMemberFn = createServerFn({ method: 'POST' })
  .middleware([authMiddleware])
  .inputValidator(
    (data: { inviteeUserId: string; proposedRole: 'member' | 'kid' }) => {
      if (!data.inviteeUserId) throw new Error('Invitee is required.')
      if (data.proposedRole !== 'member' && data.proposedRole !== 'kid') {
        throw new Error('Invalid role.')
      }
      return data
    },
  )
  .handler(({ data, context }) =>
    service.inviteMember(context.userId, data.inviteeUserId, data.proposedRole),
  )

export const listMyInvitesFn = createServerFn({ method: 'GET' })
  .middleware([authMiddleware])
  .handler(({ context }) => service.listMyInvites(context.userId))

export const listOutgoingInvitesFn = createServerFn({ method: 'GET' })
  .middleware([authMiddleware])
  .handler(({ context }) => service.listOutgoingInvites(context.userId))

export const acceptInviteFn = createServerFn({ method: 'POST' })
  .middleware([authMiddleware])
  .inputValidator((data: { inviteId: string }) => data)
  .handler(({ data, context }) => service.acceptInvite(context.userId, data.inviteId))

export const declineInviteFn = createServerFn({ method: 'POST' })
  .middleware([authMiddleware])
  .inputValidator((data: { inviteId: string }) => data)
  .handler(async ({ data, context }) => {
    await service.declineInvite(context.userId, data.inviteId)
    return { ok: true }
  })

export const cancelInviteFn = createServerFn({ method: 'POST' })
  .middleware([authMiddleware])
  .inputValidator((data: { inviteId: string }) => data)
  .handler(async ({ data, context }) => {
    await service.cancelInvite(context.userId, data.inviteId)
    return { ok: true }
  })

export const removeMemberFn = createServerFn({ method: 'POST' })
  .middleware([authMiddleware])
  .inputValidator(
    (data: { householdId: string; targetUserId: string }) => data,
  )
  .handler(async ({ data, context }) => {
    await service.removeMember(context.userId, data.householdId, data.targetUserId)
    return { ok: true }
  })

export const leaveHouseholdFn = createServerFn({ method: 'POST' })
  .middleware([authMiddleware])
  .handler(async ({ context }) => {
    await service.leaveHousehold(context.userId)
    return { ok: true }
  })

export const changeRoleFn = createServerFn({ method: 'POST' })
  .middleware([authMiddleware])
  .inputValidator(
    (data: { targetUserId: string; role: 'admin' | 'member' | 'kid' }) => {
      if (
        data.role !== 'admin' &&
        data.role !== 'member' &&
        data.role !== 'kid'
      ) {
        throw new Error('Invalid role.')
      }
      return data
    },
  )
  .handler(async ({ data, context }) => {
    await service.changeRole(context.userId, data.targetUserId, data.role)
    return { ok: true }
  })

export const renameHouseholdFn = createServerFn({ method: 'POST' })
  .middleware([authMiddleware])
  .inputValidator((data: { householdId: string; name: string }) => {
    if (typeof data.name !== 'string' || !data.name.trim()) {
      throw new Error('Household name is required.')
    }
    return { householdId: data.householdId, name: data.name.trim() }
  })
  .handler(async ({ data, context }) => {
    await service.renameHousehold(context.userId, data.householdId, data.name)
    return { ok: true }
  })

export const deleteHouseholdFn = createServerFn({ method: 'POST' })
  .middleware([authMiddleware])
  .inputValidator((data: { householdId: string }) => data)
  .handler(async ({ data, context }) => {
    await service.deleteHousehold(context.userId, data.householdId)
    return { ok: true }
  })

export const listHouseholdChoresFn = createServerFn({ method: 'GET' })
  .middleware([authMiddleware])
  .inputValidator((data: { householdId: string }) => data)
  .handler(({ data, context }) =>
    listHouseholdChores(context.userId, data.householdId),
  )

export const listHouseholdChoresWeekFn = createServerFn({ method: 'POST' })
  .middleware([authMiddleware])
  .inputValidator(
    (data: { householdId: string; startDateLocal: string }) => data,
  )
  .handler(({ data, context }) =>
    listHouseholdChoresWeek(
      context.userId,
      data.householdId,
      data.startDateLocal,
    ),
  )

export const listPendingApprovalsFn = createServerFn({ method: 'POST' })
  .middleware([authMiddleware])
  .inputValidator((data: { householdId: string }) => data)
  .handler(({ data, context }) =>
    listPendingApprovals(context.userId, data.householdId),
  )

export const approveClaimFn = createServerFn({ method: 'POST' })
  .middleware([authMiddleware])
  .inputValidator((data: { instanceId: string }) => data)
  .handler(({ data, context }) =>
    approveClaim(context.userId, data.instanceId),
  )

export const rejectClaimFn = createServerFn({ method: 'POST' })
  .middleware([authMiddleware])
  .inputValidator((data: { instanceId: string }) => data)
  .handler(({ data, context }) =>
    rejectClaim(context.userId, data.instanceId),
  )

export const createManagedMemberFn = createServerFn({ method: 'POST' })
  .middleware([authMiddleware])
  .inputValidator(
    (data: {
      name: string
      handle: string
      password: string
      email?: string | null
      role: 'kid' | 'kiosk'
    }) => {
      if (data.role !== 'kid' && data.role !== 'kiosk') {
        throw new Error('role must be "kid" or "kiosk"')
      }
      return data
    },
  )
  .handler(({ data, context }) =>
    service.createManagedMember(context.userId, data),
  )

export const resetManagedMemberPasswordFn = createServerFn({ method: 'POST' })
  .middleware([authMiddleware])
  .inputValidator(
    (data: { targetUserId: string; newPassword: string }) => data,
  )
  .handler(async ({ data, context }) => {
    await service.resetManagedMemberPassword(
      context.userId,
      data.targetUserId,
      data.newPassword,
    )
    return { ok: true }
  })

export const getManagedMemberSettingsFn = createServerFn({ method: 'POST' })
  .middleware([authMiddleware])
  .inputValidator((data: { targetUserId: string }) => data)
  .handler(({ data, context }) =>
    service.getManagedMemberSettings(context.userId, data.targetUserId),
  )

export const updateManagedMemberQuietHoursFn = createServerFn({ method: 'POST' })
  .middleware([authMiddleware])
  .inputValidator(
    (data: {
      targetUserId: string
      start: string | null
      end: string | null
    }) => data,
  )
  .handler(({ data, context }) =>
    service.updateManagedMemberQuietHours(context.userId, data.targetUserId, {
      start: data.start,
      end: data.end,
    }),
  )

export const updateManagedMemberCoachAttitudeFn = createServerFn({
  method: 'POST',
})
  .middleware([authMiddleware])
  .inputValidator((data: { targetUserId: string; attitude: string }) => data)
  .handler(({ data, context }) =>
    service.updateManagedMemberCoachAttitude(
      context.userId,
      data.targetUserId,
      data.attitude,
    ),
  )

export const updateMemberColorFn = createServerFn({ method: 'POST' })
  .middleware([authMiddleware])
  .inputValidator(
    (data: { targetUserId: string; color: string }) => data,
  )
  .handler(async ({ data, context }) => {
    await service.updateMemberColor(
      context.userId,
      data.targetUserId,
      data.color,
    )
    return { ok: true }
  })

export const listHouseholdStatsFn = createServerFn({ method: 'POST' })
  .middleware([authMiddleware])
  .inputValidator(
    (data: { householdId: string; days?: number }) => data,
  )
  .handler(({ data, context }) =>
    service.listHouseholdStats(
      context.userId,
      data.householdId,
      data.days ?? 30,
    ),
  )

export const listHouseholdActivityFn = createServerFn({ method: 'POST' })
  .middleware([authMiddleware])
  .inputValidator(
    (data: { householdId: string; days?: number; limit?: number }) => data,
  )
  .handler(({ data, context }) =>
    service.listHouseholdActivity(context.userId, data.householdId, {
      days: data.days,
      limit: data.limit,
    }),
  )

// Stats for another household member. Permission gate: viewer and
// target must share a household. Falls through to the same getStats
// the personal stats page already uses, just with a different userId.
export const getHouseholdMemberStatsFn = createServerFn({ method: 'POST' })
  .middleware([authMiddleware])
  .inputValidator(
    (data: { targetUserId: string; days?: number | 'all' }) => data,
  )
  .handler(async ({ data, context }) => {
    if (data.targetUserId === context.userId) {
      return getStats(context.userId, data.days ?? 30)
    }
    const my = await service.getMyMembership(context.userId)
    if (!my) throw new Error('You are not in a household.')
    const target = await service.getMembership(
      data.targetUserId,
      my.householdId,
    )
    if (!target) {
      throw new Error('That user is not in your household.')
    }
    return getStats(data.targetUserId, data.days ?? 30)
  })
