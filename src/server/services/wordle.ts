// Wordle arcade game. The answer pool lives in `wordle_words` and is
// edited from /admin/wordle; game plays are logged into the shared `events`
// table with the word in the payload so per-user "seen" tracking is just a
// SQL NOT EXISTS against the event log (no separate seen table).
import { and, eq, sql } from 'drizzle-orm'
import { db } from '../db/client'
import {
  taskInstances,
  tasks,
  user as userTable,
  wordleWords,
} from '../db/schema'
import { isAdminEmail } from './admin'

const WORD_LENGTH = 5
const LOW_UNSEEN_THRESHOLD = 10
const ADMIN_TASK_EXTERNAL_REF = 'wordle-words-low'

export function normalizeWord(word: string): string {
  return word.trim().toUpperCase()
}

export function isValidWord(word: string): boolean {
  const w = normalizeWord(word)
  return w.length === WORD_LENGTH && /^[A-Z]+$/.test(w)
}

export interface WordleWordRow {
  word: string
  createdBy: string | null
  createdAt: string
}

export async function listWords(): Promise<WordleWordRow[]> {
  const rows = await db
    .select({
      word: wordleWords.word,
      createdBy: wordleWords.createdBy,
      createdAt: wordleWords.createdAt,
    })
    .from(wordleWords)
    .orderBy(wordleWords.word)
  return rows.map((r) => ({
    word: r.word,
    createdBy: r.createdBy,
    createdAt: r.createdAt.toISOString(),
  }))
}

export interface AddWordsResult {
  added: number
  skipped: number
  invalid: string[]
}

// Accepts whitespace- or comma-separated input. Normalizes to uppercase,
// rejects anything that isn't 5 A–Z letters. Duplicates (in input or
// already in table) show up in `skipped`.
export async function addWords(
  raw: string,
  createdBy: string,
): Promise<AddWordsResult> {
  const tokens = raw.split(/[\s,]+/).filter(Boolean)
  const normalized: string[] = []
  const invalid: string[] = []
  for (const t of tokens) {
    if (isValidWord(t)) normalized.push(normalizeWord(t))
    else invalid.push(t)
  }
  const unique = Array.from(new Set(normalized))
  if (unique.length === 0) return { added: 0, skipped: 0, invalid }
  const inserted = await db
    .insert(wordleWords)
    .values(unique.map((word) => ({ word, createdBy })))
    .onConflictDoNothing()
    .returning({ word: wordleWords.word })
  return {
    added: inserted.length,
    skipped: unique.length - inserted.length,
    invalid,
  }
}

export async function removeWord(word: string): Promise<boolean> {
  const w = normalizeWord(word)
  const result = await db
    .delete(wordleWords)
    .where(eq(wordleWords.word, w))
    .returning({ word: wordleWords.word })
  return result.length > 0
}

// Picks a random word the user hasn't played. Falls back to any word when
// they've exhausted the pool. Returns null only if the table is empty.
export async function pickWordForUser(userId: string): Promise<string | null> {
  const unseen = await db.execute<{ word: string }>(sql`
    SELECT word FROM wordle_words w
    WHERE NOT EXISTS (
      SELECT 1 FROM events e
      WHERE e.user_id = ${userId}
        AND e.type = 'game.played'
        AND e.payload->>'gameId' = 'wordle'
        AND e.payload->>'word' = w.word
    )
    ORDER BY random()
    LIMIT 1
  `)
  if (unseen[0]?.word) return unseen[0].word
  const any = await db.execute<{ word: string }>(sql`
    SELECT word FROM wordle_words ORDER BY random() LIMIT 1
  `)
  return any[0]?.word ?? null
}

export async function countUnseen(userId: string): Promise<number> {
  const rows = await db.execute<{ n: number }>(sql`
    SELECT COUNT(*)::int AS n FROM wordle_words w
    WHERE NOT EXISTS (
      SELECT 1 FROM events e
      WHERE e.user_id = ${userId}
        AND e.type = 'game.played'
        AND e.payload->>'gameId' = 'wordle'
        AND e.payload->>'word' = w.word
    )
  `)
  return Number(rows[0]?.n ?? 0)
}

export async function countTotal(): Promise<number> {
  const rows = await db.execute<{ n: number }>(
    sql`SELECT COUNT(*)::int AS n FROM wordle_words`,
  )
  return Number(rows[0]?.n ?? 0)
}

// Called from finishGame after a wordle play. If the user's unseen count is
// at or below the threshold, nudge every admin with a task.
export async function checkAndNotifyLowPool(userId: string): Promise<void> {
  const unseen = await countUnseen(userId)
  if (unseen > LOW_UNSEEN_THRESHOLD) return
  const admins = await loadAdminUsers()
  if (admins.length === 0) return
  const total = await countTotal()
  const title = 'Add more Wordle words'
  const notes = `A player has only ${unseen} unseen word${unseen === 1 ? '' : 's'} left (pool size: ${total}). Add more at /admin/wordle.`
  for (const admin of admins) {
    await ensureAdminTask(admin.id, title, notes).catch((err) => {
      console.error('[wordle] ensureAdminTask failed', err)
    })
  }
}

async function loadAdminUsers(): Promise<Array<{ id: string; email: string }>> {
  const rows = await db
    .select({ id: userTable.id, email: userTable.email })
    .from(userTable)
  return rows.filter((r) => isAdminEmail(r.email))
}

// One active task per admin, keyed by externalRef. When the admin has
// completed a prior nudge (task row still exists, instance closed), reopen
// it by inserting a fresh instance so they get it in "today" again.
async function ensureAdminTask(
  userId: string,
  title: string,
  notes: string,
): Promise<void> {
  const existing = await db.query.tasks.findFirst({
    where: and(
      eq(tasks.userId, userId),
      eq(tasks.externalRef, ADMIN_TASK_EXTERNAL_REF),
    ),
  })
  if (existing) {
    const openInstance = await db.query.taskInstances.findFirst({
      where: and(
        eq(taskInstances.taskId, existing.id),
        sql`${taskInstances.completedAt} is null`,
        sql`${taskInstances.skippedAt} is null`,
      ),
    })
    if (openInstance) return
    await db.transaction(async (tx) => {
      await tx
        .update(tasks)
        .set({ active: true, notes, updatedAt: new Date() })
        .where(eq(tasks.id, existing.id))
      await tx.insert(taskInstances).values({
        taskId: existing.id,
        userId,
        dueAt: new Date(),
      })
    })
    return
  }
  try {
    await db.transaction(async (tx) => {
      const [task] = await tx
        .insert(tasks)
        .values({
          userId,
          title,
          notes,
          difficulty: 'small',
          externalRef: ADMIN_TASK_EXTERNAL_REF,
          visibility: 'private',
        })
        .returning({ id: tasks.id })
      await tx.insert(taskInstances).values({
        taskId: task.id,
        userId,
        dueAt: new Date(),
      })
    })
  } catch (err) {
    // Partial unique index may fire under concurrency — that's fine.
    const message = err instanceof Error ? err.message : String(err)
    if (!/tasks_user_external_ref_idx|duplicate key/i.test(message)) {
      throw err
    }
  }
}
