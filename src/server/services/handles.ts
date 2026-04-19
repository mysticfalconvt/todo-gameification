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
//
// Always appends a 4-char random suffix instead of using the bare slug.
// This is deliberate: the bare-slug path had a TOCTOU race where two
// simultaneous signups with the same name could both pass the SELECT
// check, then the second INSERT would crash on the unique constraint —
// and by that point we're deep inside Better Auth's transaction so
// there's no clean retry. With 36^4 ≈ 1.7M suffix options and our tiny
// scale, picking the same "rob_abcd" twice at the same instant is
// effectively impossible. Users can rename to the bare handle later via
// the settings flow, which does a proper check-and-update with a clear
// error on conflict.
export async function generateUniqueHandleFromName(
  name: string,
): Promise<string> {
  const base = normalizeHandle(name) || 'user'
  const usableBase = base.length >= 3 ? base : (base + '_user').slice(0, 20)
  for (let i = 0; i < 8; i++) {
    const suffix = '_' + randomSuffix(4)
    const candidate = (
      usableBase.slice(0, 20 - suffix.length) + suffix
    ).slice(0, 20)
    if (!(await handleExists(candidate))) return candidate
  }
  // Ultimate fallback: a fully random handle. 10 chars of [a-z0-9] is
  // 36^10 ≈ 3.6e15 possibilities — collision is not a real concern.
  return 'u_' + randomSuffix(10)
}

function randomSuffix(len: number): string {
  const alphabet = 'abcdefghijklmnopqrstuvwxyz0123456789'
  let out = ''
  for (let i = 0; i < len; i++) {
    out += alphabet[Math.floor(Math.random() * alphabet.length)]
  }
  return out
}
