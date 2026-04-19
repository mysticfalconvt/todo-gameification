// API token service layer.
//
// Tokens are `tgx_<base64url(32 random bytes)>` — the prefix makes them
// greppable and eligible for secret-scanning; only the SHA-256 hash is stored
// at rest. The plaintext is only ever returned to the caller at creation
// time; listing tokens shows the prefix and never the full value.
import { randomBytes, createHash, timingSafeEqual } from 'node:crypto'
import { and, eq } from 'drizzle-orm'
import { db } from '../db/client'
import { apiTokens } from '../db/schema'

const TOKEN_PREFIX = 'tgx_'
const PREFIX_DISPLAY_LEN = 8 // "tgx_XXXX" shown to the user

function generatePlaintextToken(): string {
  return TOKEN_PREFIX + randomBytes(32).toString('base64url')
}

function hashToken(plaintext: string): string {
  return createHash('sha256').update(plaintext).digest('hex')
}

export interface ApiTokenSummary {
  id: string
  name: string
  tokenPrefix: string
  lastUsedAt: string | null
  createdAt: string
  expiresAt: string | null
}

export interface CreateApiTokenResult {
  id: string
  name: string
  tokenPrefix: string
  plaintext: string
  createdAt: string
}

export async function createApiToken(
  userId: string,
  name: string,
): Promise<CreateApiTokenResult> {
  const cleanName = name?.trim()
  if (!cleanName) throw new Error('token name required')
  if (cleanName.length > 80) throw new Error('token name too long')

  const plaintext = generatePlaintextToken()
  const hashedToken = hashToken(plaintext)
  const tokenPrefix = plaintext.slice(0, PREFIX_DISPLAY_LEN)

  const [row] = await db
    .insert(apiTokens)
    .values({
      userId,
      name: cleanName,
      hashedToken,
      tokenPrefix,
    })
    .returning()

  return {
    id: row.id,
    name: row.name,
    tokenPrefix: row.tokenPrefix,
    plaintext,
    createdAt: row.createdAt.toISOString(),
  }
}

export async function listApiTokens(
  userId: string,
): Promise<ApiTokenSummary[]> {
  const rows = await db.query.apiTokens.findMany({
    where: eq(apiTokens.userId, userId),
    orderBy: (t, { desc }) => desc(t.createdAt),
  })
  return rows.map((r) => ({
    id: r.id,
    name: r.name,
    tokenPrefix: r.tokenPrefix,
    lastUsedAt: r.lastUsedAt?.toISOString() ?? null,
    createdAt: r.createdAt.toISOString(),
    expiresAt: r.expiresAt?.toISOString() ?? null,
  }))
}

export async function revokeApiToken(
  userId: string,
  tokenId: string,
): Promise<{ id: string }> {
  if (!tokenId) throw new Error('tokenId required')
  const result = await db
    .delete(apiTokens)
    .where(and(eq(apiTokens.id, tokenId), eq(apiTokens.userId, userId)))
    .returning({ id: apiTokens.id })
  if (result.length === 0) throw new Error('token not found')
  return { id: result[0].id }
}

/**
 * Verify a plaintext bearer token against the stored hashes.
 * Returns the userId on success, null otherwise. Bumps lastUsedAt on success.
 *
 * Note on timing-attack resistance: the match lookup uses a Postgres
 * index on `hashed_token`, which is not a linear string-compare the way
 * `===` in JS would be. We also defensively timingSafeEqual the stored
 * hash against the recomputed one after the DB returns a row — a no-op
 * in practice (they must match for the lookup to have succeeded) but it
 * keeps the final compare explicit and constant-time regardless of
 * future refactors.
 */
export async function verifyApiToken(
  plaintext: string,
): Promise<{ userId: string } | null> {
  if (!plaintext?.startsWith(TOKEN_PREFIX)) return null
  const hashedToken = hashToken(plaintext)
  const row = await db.query.apiTokens.findFirst({
    where: eq(apiTokens.hashedToken, hashedToken),
  })
  if (!row) return null
  if (row.expiresAt && row.expiresAt < new Date()) return null

  const a = Buffer.from(hashedToken, 'hex')
  const b = Buffer.from(row.hashedToken, 'hex')
  if (a.length !== b.length || !timingSafeEqual(a, b)) return null

  // Fire-and-forget the lastUsedAt bump so we don't add latency to every call.
  db
    .update(apiTokens)
    .set({ lastUsedAt: new Date() })
    .where(eq(apiTokens.id, row.id))
    .catch((e) => console.error('lastUsedAt bump failed', e))

  return { userId: row.userId }
}
