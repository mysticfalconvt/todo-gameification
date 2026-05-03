// Arcade stats service.
//
// Reads from the `events` log (game.played) and aggregates per-game stats
// for the viewer plus a single "best friend score per game" comparison.
// Visibility mirrors the leaderboard: a friend only contributes to the
// arcade page if they're not 'private' and haven't disabled
// shareProgression. The viewer always sees their own data.
//
// Source of truth is the event payload — no separate scoreboard table.
// All aggregation happens in memory because the event volume per user is
// small (low thousands at most) and we already pay the cost for stats.
import { and, eq, inArray, or } from 'drizzle-orm'
import { db } from '../db/client'
import {
  events,
  friendships,
  user as userTable,
  userPrefs,
} from '../db/schema'
import { GAMES } from '../../games/registry'

// Lower-is-better games: fewer moves / fewer guesses wins. Higher-is-better
// games: bigger tile, bigger score wins. Drives MIN/MAX direction in
// aggregation. Unknown game IDs default to higher-is-better — safest if
// we add a new game without updating this map.
const SCORE_DIRECTION: Record<string, 'lower' | 'higher'> = {
  wordle: 'lower',
  'sliding-puzzle': 'lower',
  'memory-flip': 'lower',
  '2048': 'higher',
}

function isBetter(gameId: string, candidate: number, current: number): boolean {
  return SCORE_DIRECTION[gameId] === 'lower'
    ? candidate < current
    : candidate > current
}

export interface PersonalGameStats {
  gameId: string
  played: number
  won: number
  bestScore: number | null
  bestAt: string | null
  lastPlayedAt: string | null
}

export interface FriendBest {
  gameId: string
  handle: string
  name: string
  bestScore: number
  bestAt: string
}

export interface WordleDetails {
  played: number
  won: number
  bestGuesses: number | null
  averageGuessesOnWin: number | null
  uniqueWordsSolved: number
  currentWinStreak: number
  longestWinStreak: number
}

export interface ArcadeStats {
  personal: PersonalGameStats[]
  friendBests: FriendBest[]
  wordle: WordleDetails | null
}

interface GameEventRow {
  userId: string
  payload: unknown
  occurredAt: Date | null
}

function payloadAsObj(payload: unknown): Record<string, unknown> {
  return (payload && typeof payload === 'object' ? payload : {}) as Record<
    string,
    unknown
  >
}

function readPlay(row: GameEventRow): {
  gameId: string
  won: boolean
  score: number | null
  word: string | null
  occurredAt: Date
} | null {
  if (!row.occurredAt) return null
  const p = payloadAsObj(row.payload)
  const gameId = typeof p['gameId'] === 'string' ? (p['gameId'] as string) : null
  if (!gameId) return null
  const result = payloadAsObj(p['result'])
  const won = result['won'] === true
  const rawScore = result['score']
  const score = typeof rawScore === 'number' ? (rawScore as number) : null
  const word = typeof p['word'] === 'string' ? (p['word'] as string) : null
  return { gameId, won, score, word, occurredAt: row.occurredAt }
}

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
  return rows.map((r) => (r.requester === userId ? r.addressee : r.requester))
}

interface FriendCandidate {
  id: string
  handle: string
  name: string
}

// Same shape as leaderboard.loadCandidates: drop friends who are 'private'
// or whose shareProgression pref is false. Viewer is excluded — they
// already have their own column.
async function loadVisibleFriends(viewerId: string): Promise<FriendCandidate[]> {
  const ids = await friendIdsFor(viewerId)
  if (ids.length === 0) return []
  const rows = await db
    .select({
      id: userTable.id,
      handle: userTable.handle,
      name: userTable.name,
      profileVisibility: userTable.profileVisibility,
      shareProgression: userPrefs.shareProgression,
    })
    .from(userTable)
    .leftJoin(userPrefs, eq(userPrefs.userId, userTable.id))
    .where(inArray(userTable.id, ids))
  return rows
    .filter(
      (r) =>
        r.profileVisibility !== 'private' &&
        (r.shareProgression ?? true) === true,
    )
    .map((r) => ({ id: r.id, handle: r.handle, name: r.name }))
}

function aggregatePersonal(
  plays: ReturnType<typeof readPlay>[],
): PersonalGameStats[] {
  const byGame = new Map<string, PersonalGameStats>()
  for (const p of plays) {
    if (!p) continue
    const existing =
      byGame.get(p.gameId) ??
      ({
        gameId: p.gameId,
        played: 0,
        won: 0,
        bestScore: null,
        bestAt: null,
        lastPlayedAt: null,
      } as PersonalGameStats)
    existing.played += 1
    if (p.won) existing.won += 1
    // Best score is only counted for wins — losing 2048 with score=512
    // shouldn't beat a winning play of 1024.
    if (p.won && typeof p.score === 'number') {
      if (
        existing.bestScore === null ||
        isBetter(p.gameId, p.score, existing.bestScore)
      ) {
        existing.bestScore = p.score
        existing.bestAt = p.occurredAt.toISOString()
      }
    }
    const occurredIso = p.occurredAt.toISOString()
    if (!existing.lastPlayedAt || occurredIso > existing.lastPlayedAt) {
      existing.lastPlayedAt = occurredIso
    }
    byGame.set(p.gameId, existing)
  }
  // Always return a row for every registered game so the UI can show
  // "no plays yet" without an extra branch — empty rows have played=0.
  for (const g of GAMES) {
    if (!byGame.has(g.id)) {
      byGame.set(g.id, {
        gameId: g.id,
        played: 0,
        won: 0,
        bestScore: null,
        bestAt: null,
        lastPlayedAt: null,
      })
    }
  }
  return Array.from(byGame.values())
}

interface FriendPlay {
  userId: string
  gameId: string
  score: number
  occurredAt: Date
}

function aggregateFriendBests(
  friends: FriendCandidate[],
  rows: FriendPlay[],
): FriendBest[] {
  // For each gameId, find the friend whose best winning score beats all
  // other friends'. One row per game. Friends with no winning plays for
  // a game contribute nothing.
  const bestByFriendByGame = new Map<string, Map<string, FriendPlay>>()
  for (const r of rows) {
    const inner =
      bestByFriendByGame.get(r.gameId) ?? new Map<string, FriendPlay>()
    const existing = inner.get(r.userId)
    if (!existing || isBetter(r.gameId, r.score, existing.score)) {
      inner.set(r.userId, r)
    }
    bestByFriendByGame.set(r.gameId, inner)
  }
  const handleById = new Map(friends.map((f) => [f.id, f]))
  const out: FriendBest[] = []
  for (const [gameId, byFriend] of bestByFriendByGame) {
    let top: FriendPlay | null = null
    for (const play of byFriend.values()) {
      if (!top || isBetter(gameId, play.score, top.score)) top = play
    }
    if (!top) continue
    const f = handleById.get(top.userId)
    if (!f) continue
    out.push({
      gameId,
      handle: f.handle,
      name: f.name,
      bestScore: top.score,
      bestAt: top.occurredAt.toISOString(),
    })
  }
  return out
}

function buildWordleDetails(
  plays: ReturnType<typeof readPlay>[],
): WordleDetails | null {
  const wordles = plays.filter(
    (p): p is NonNullable<ReturnType<typeof readPlay>> =>
      p !== null && p.gameId === 'wordle',
  )
  if (wordles.length === 0) return null

  // Order by occurredAt ascending so streak calc walks chronologically.
  wordles.sort((a, b) => a.occurredAt.getTime() - b.occurredAt.getTime())

  let played = 0
  let won = 0
  let bestGuesses: number | null = null
  let guessesSum = 0
  let guessesCount = 0
  const wordsSolved = new Set<string>()
  let longest = 0
  let runningStreak = 0
  let currentStreak = 0
  for (const p of wordles) {
    played += 1
    if (p.won) {
      won += 1
      runningStreak += 1
      if (runningStreak > longest) longest = runningStreak
      currentStreak = runningStreak
      if (typeof p.score === 'number') {
        guessesSum += p.score
        guessesCount += 1
        if (bestGuesses === null || p.score < bestGuesses) bestGuesses = p.score
      }
      if (p.word) wordsSolved.add(p.word)
    } else {
      runningStreak = 0
      currentStreak = 0
    }
  }
  return {
    played,
    won,
    bestGuesses,
    averageGuessesOnWin:
      guessesCount > 0
        ? Math.round((guessesSum / guessesCount) * 10) / 10
        : null,
    uniqueWordsSolved: wordsSolved.size,
    currentWinStreak: currentStreak,
    longestWinStreak: longest,
  }
}

export async function getArcadeStats(userId: string): Promise<ArcadeStats> {
  // Pull viewer's plays + visible friends' plays in parallel. Same query
  // shape both times — `inArray(userId, [...ids])` so a single events
  // sweep covers everyone.
  const friends = await loadVisibleFriends(userId)
  const friendIds = friends.map((f) => f.id)
  const allUserIds = friendIds.length > 0 ? [userId, ...friendIds] : [userId]

  const rows = await db
    .select({
      userId: events.userId,
      payload: events.payload,
      occurredAt: events.occurredAt,
    })
    .from(events)
    .where(
      and(eq(events.type, 'game.played'), inArray(events.userId, allUserIds)),
    )

  const myPlays: ReturnType<typeof readPlay>[] = []
  const friendPlays: FriendPlay[] = []
  for (const r of rows) {
    const play = readPlay({
      userId: r.userId,
      payload: r.payload,
      occurredAt: r.occurredAt,
    })
    if (!play) continue
    if (r.userId === userId) {
      myPlays.push(play)
    } else if (play.won && typeof play.score === 'number') {
      // Only winning plays with a score can become a friend "best".
      friendPlays.push({
        userId: r.userId,
        gameId: play.gameId,
        score: play.score,
        occurredAt: play.occurredAt,
      })
    }
  }

  return {
    personal: aggregatePersonal(myPlays),
    friendBests: aggregateFriendBests(friends, friendPlays),
    wordle: buildWordleDetails(myPlays),
  }
}
