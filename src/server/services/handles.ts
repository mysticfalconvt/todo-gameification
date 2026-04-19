import { sql } from 'drizzle-orm'
import { db } from '../db/client'
import { user } from '../db/schema'

// Lowercase alphanumeric + underscore. 3–20 chars.
export const HANDLE_PATTERN = /^[a-z0-9_]{3,20}$/

export function normalizeHandle(raw: string): string {
  return raw
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_]+/g, '_')
    .replace(/_+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 20)
}

export function isValidHandle(handle: string): boolean {
  return HANDLE_PATTERN.test(handle)
}

export async function handleExists(
  candidate: string,
  excludeUserId?: string,
): Promise<boolean> {
  const rows = await db
    .select({ id: user.id })
    .from(user)
    .where(
      excludeUserId
        ? sql`lower(${user.handle}) = lower(${candidate}) and ${user.id} <> ${excludeUserId}`
        : sql`lower(${user.handle}) = lower(${candidate})`,
    )
    .limit(1)
  return rows.length > 0
}

// Generate a unique handle for a new user from their display name.
// Tries the slugified name first, then appends a short random suffix on
// collision. Final fallback is a fully random handle.
export async function generateUniqueHandleFromName(
  name: string,
): Promise<string> {
  const base = normalizeHandle(name) || 'user'
  const primary = base.length >= 3 ? base : (base + '_user').slice(0, 20)
  if (!(await handleExists(primary))) return primary
  for (let i = 0; i < 8; i++) {
    const suffix = '_' + randomSuffix(3)
    const candidate = (primary.slice(0, 20 - suffix.length) + suffix).slice(
      0,
      20,
    )
    if (!(await handleExists(candidate))) return candidate
  }
  return 'u_' + randomSuffix(8)
}

function randomSuffix(len: number): string {
  const alphabet = 'abcdefghijklmnopqrstuvwxyz0123456789'
  let out = ''
  for (let i = 0; i < len; i++) {
    out += alphabet[Math.floor(Math.random() * alphabet.length)]
  }
  return out
}
