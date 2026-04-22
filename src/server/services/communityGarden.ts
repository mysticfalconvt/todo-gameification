// Community garden aggregator. Fans out to per-user getGarden() for
// every visible user in the requested scope, flattens their plants into
// one combined view, and enforces gardenVisibility + block rules.
//
// Scope mirrors the leaderboard's loadCandidates (see
// src/server/services/leaderboard.ts):
//   - friends: viewer's accepted friends
//   - global:  everyone with gardenVisibility = 'public'
//
// The viewer is always excluded from the community list — they already
// see their own garden in the "Yours" tab.
import { and, desc, eq, inArray, isNotNull, or } from 'drizzle-orm'
import { db } from '../db/client'
import {
  friendships,
  progression,
  user as userTable,
} from '../db/schema'
import { getGarden, type GardenPlant } from './garden'
import { canViewGarden } from './social'

export type CommunityGardenScope = 'friends' | 'global'

export interface CommunityGardenEntry {
  userId: string
  handle: string
  name: string
  plant: GardenPlant
}

export interface CommunityGardenView {
  entries: CommunityGardenEntry[]
  userCount: number
  totalWaterings: number
}

// Cap on the Global scope so one request doesn't replay events for
// thousands of users. Friends scope is unbounded since people tend to
// have tens, not thousands.
const GLOBAL_SCOPE_USER_CAP = 50

async function friendIdsFor(userId: string): Promise<string[]> {
  const rows = await db
    .select({
      requester: friendships.requesterId,
      addressee: friendships.addresseeId,
    })
    .from(friendships)
    .where(
      and(
        eq(friendships.status, 'accepted'),
        or(
          eq(friendships.requesterId, userId),
          eq(friendships.addresseeId, userId),
        ),
      ),
    )
  return rows.map((r) =>
    r.requester === userId ? r.addressee : r.requester,
  )
}

async function candidateIdsFor(
  viewerId: string,
  scope: CommunityGardenScope,
): Promise<string[]> {
  if (scope === 'friends') {
    // Friends scope is about "other" gardens — viewer sees themselves
    // in the Yours tab, so exclude self here.
    const ids = await friendIdsFor(viewerId)
    return ids.filter((id) => id !== viewerId)
  }
  // Global: users with a public garden, ranked by most-recent activity
  // (progression.lastCompletionAt) so we surface gardens that are
  // actually being tended. Users without a progression row fall to the
  // bottom but are still eligible once they complete something.
  //
  // Viewer is intentionally included here — "Global" is everyone with a
  // public garden, and the viewer is part of everyone when their own
  // gardenVisibility is public. (If their visibility is friends/private
  // they fall out of the WHERE clause naturally.)
  const rows = await db
    .select({ id: userTable.id })
    .from(userTable)
    .leftJoin(progression, eq(progression.userId, userTable.id))
    .where(
      and(
        eq(userTable.gardenVisibility, 'public'),
        isNotNull(progression.lastCompletionAt),
      ),
    )
    .orderBy(desc(progression.lastCompletionAt))
    .limit(GLOBAL_SCOPE_USER_CAP)
  return rows.map((r) => r.id)
}

export async function getCommunityGarden(
  viewerId: string,
  opts: { scope: CommunityGardenScope },
): Promise<CommunityGardenView> {
  const ids = await candidateIdsFor(viewerId, opts.scope)
  if (ids.length === 0) {
    return { entries: [], userCount: 0, totalWaterings: 0 }
  }

  // Privacy gate per candidate (also catches blocks and friends-only
  // gardens that snuck through the scope query).
  const visibleIds: string[] = []
  await Promise.all(
    ids.map(async (id) => {
      if (await canViewGarden(viewerId, id)) visibleIds.push(id)
    }),
  )
  if (visibleIds.length === 0) {
    return { entries: [], userCount: 0, totalWaterings: 0 }
  }

  // Pull display metadata for the survivors in one query.
  const userRows = await db
    .select({
      id: userTable.id,
      handle: userTable.handle,
      name: userTable.name,
    })
    .from(userTable)
    .where(inArray(userTable.id, visibleIds))
  const metaById = new Map(userRows.map((u) => [u.id, u]))

  // Fan out per-user garden replays. N is small (≤ friend count, or
  // ≤ GLOBAL_SCOPE_USER_CAP for global), so a parallel fan-out is fine.
  const gardens = await Promise.all(
    visibleIds.map((id) => getGarden(id).then((g) => ({ id, garden: g }))),
  )

  const entries: CommunityGardenEntry[] = []
  const ownerIds = new Set<string>()
  let totalWaterings = 0
  for (const { id, garden } of gardens) {
    const meta = metaById.get(id)
    if (!meta) continue
    for (const plant of garden.plants) {
      if (plant.waterings <= 0) continue
      entries.push({
        userId: id,
        handle: meta.handle,
        name: meta.name,
        plant,
      })
      ownerIds.add(id)
      totalWaterings += plant.waterings
    }
  }

  entries.sort(
    (a, b) =>
      b.plant.waterings - a.plant.waterings ||
      a.handle.localeCompare(b.handle),
  )

  return {
    entries,
    userCount: ownerIds.size,
    totalWaterings,
  }
}
