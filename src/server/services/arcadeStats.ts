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
//
// Sudoku has two leaderboards (easy/hard), exposed via synthetic gameIds
// `sudoku:easy` / `sudoku:hard` in friend-best output. The base `sudoku`
// id is registered so `isBetter` works if anything ever calls it.
const SCORE_DIRECTION: Record<string, 'lower' | 'higher'> = {
  wordle: 'lower',
  'sliding-puzzle': 'lower',
  'memory-flip': 'lower',
  '2048': 'higher',
  sudoku: 'lower',
  'sudoku:easy': 'lower',
  'sudoku:hard': 'lower',
}

// Most games only have a meaningful score on a win — losing Wordle by
// running out of guesses, or quitting sliding-puzzle mid-game, isn't a
// "best." 2048 is the exception: even on a loss the highest-tile-reached
// is real progress (you might have hit 512 and gotten stuck), so we
// count those too. Defaults to true (must-win) so adding a new game
// without thinking about it errs on the safe side.
const SCORE_NEEDS_WIN: Record<string, boolean> = {
  wordle: true,
  'sliding-puzzle': true,
  'memory-flip': true,
  '2048': false,
  sudoku: true,
  'sudoku:easy': true,
  'sudoku:hard': true,
}

function scoreCounts(gameId: string, won: boolean): boolean {
  if (won) return true
  return SCORE_NEEDS_WIN[gameId] === false
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

export interface SudokuDifficultyStats {
  played: number
  won: number
  bestScore: number | null
  bestAt: string | null
  averageSecondsOnWin: number | null
  currentWinStreak: number
  longestWinStreak: number
}

export interface SudokuDetails {
  easy: SudokuDifficultyStats
  hard: SudokuDifficultyStats
  totalSolved: number
}

export interface ArcadeStats {
  personal: PersonalGameStats[]
  friendBests: FriendBest[]
  wordle: WordleDetails | null
  sudoku: SudokuDetails | null
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
  difficulty: 'easy' | 'hard' | null
  seconds: number | null
  mistakes: number | null
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
  const rawDifficulty = p['difficulty']
  const difficulty =
    rawDifficulty === 'easy' || rawDifficulty === 'hard'
      ? rawDifficulty
      : null
  const seconds = typeof p['seconds'] === 'number' ? (p['seconds'] as number) : null
  const mistakes =
    typeof p['mistakes'] === 'number' ? (p['mistakes'] as number) : null
  return {
    gameId,
    won,
    score,
    word,
    difficulty,
    seconds,
    mistakes,
    occurredAt: row.occurredAt,
  }
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
    // Best score is counted on wins, plus on losses for games where the
    // raw score is still meaningful (e.g. 2048's highest-tile-reached).
    // See SCORE_NEEDS_WIN. Sudoku has per-difficulty leaderboards instead
    // — a combined "overall best" would mix easy + hard times — so we
    // omit the top-line best here and let SudokuDetails carry the splits.
    if (
      p.gameId !== 'sudoku' &&
      typeof p.score === 'number' &&
      scoreCounts(p.gameId, p.won)
    ) {
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

function emptyDifficultyStats(): SudokuDifficultyStats {
  return {
    played: 0,
    won: 0,
    bestScore: null,
    bestAt: null,
    averageSecondsOnWin: null,
    currentWinStreak: 0,
    longestWinStreak: 0,
  }
}

function buildSudokuDetails(
  plays: ReturnType<typeof readPlay>[],
): SudokuDetails | null {
  const sudokus = plays.filter(
    (p): p is NonNullable<ReturnType<typeof readPlay>> =>
      p !== null && p.gameId === 'sudoku',
  )
  if (sudokus.length === 0) return null

  // Per-difficulty ladder. Streaks are tracked separately per difficulty —
  // losing an easy run doesn't reset the hard streak and vice versa.
  sudokus.sort((a, b) => a.occurredAt.getTime() - b.occurredAt.getTime())

  const stats: Record<'easy' | 'hard', SudokuDifficultyStats> = {
    easy: emptyDifficultyStats(),
    hard: emptyDifficultyStats(),
  }
  const secondsSum: Record<'easy' | 'hard', number> = { easy: 0, hard: 0 }
  const secondsCount: Record<'easy' | 'hard', number> = { easy: 0, hard: 0 }
  const running: Record<'easy' | 'hard', number> = { easy: 0, hard: 0 }
  let totalSolved = 0

  for (const p of sudokus) {
    const d = p.difficulty
    if (d !== 'easy' && d !== 'hard') continue
    const s = stats[d]
    s.played += 1
    if (p.won) {
      s.won += 1
      totalSolved += 1
      running[d] += 1
      if (running[d] > s.longestWinStreak) s.longestWinStreak = running[d]
      s.currentWinStreak = running[d]
      if (typeof p.score === 'number') {
        if (s.bestScore === null || p.score < s.bestScore) {
          s.bestScore = p.score
          s.bestAt = p.occurredAt.toISOString()
        }
      }
      if (typeof p.seconds === 'number') {
        secondsSum[d] += p.seconds
        secondsCount[d] += 1
      }
    } else {
      running[d] = 0
      s.currentWinStreak = 0
    }
  }
  for (const d of ['easy', 'hard'] as const) {
    if (secondsCount[d] > 0) {
      stats[d].averageSecondsOnWin = Math.round(secondsSum[d] / secondsCount[d])
    }
  }

  return { easy: stats.easy, hard: stats.hard, totalSolved }
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
    } else if (
      typeof play.score === 'number' &&
      scoreCounts(play.gameId, play.won)
    ) {
      // Friend "best" mirrors the personal rule: wins always count, losses
      // count only for games where the score is meaningful regardless
      // (e.g. 2048's highest tile). Sudoku is keyed per-difficulty so the
      // two ladders don't get conflated — SudokuPanel looks them up via
      // `sudoku:easy` / `sudoku:hard`.
      const aggregateGameId =
        play.gameId === 'sudoku' && play.difficulty
          ? `sudoku:${play.difficulty}`
          : play.gameId
      if (play.gameId !== 'sudoku' || play.difficulty) {
        friendPlays.push({
          userId: r.userId,
          gameId: aggregateGameId,
          score: play.score,
          occurredAt: play.occurredAt,
        })
      }
    }
  }

  return {
    personal: aggregatePersonal(myPlays),
    friendBests: aggregateFriendBests(friends, friendPlays),
    wordle: buildWordleDetails(myPlays),
    sudoku: buildSudokuDetails(myPlays),
  }
}
