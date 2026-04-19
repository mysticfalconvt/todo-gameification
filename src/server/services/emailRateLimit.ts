// Per-email outbound-mail rate limiter. Keeps Better Auth's verification
// and password-reset hooks from being abused to spam a target's inbox
// just by hitting /auth/login or /auth/forgot-password in a loop.
//
// Scope is per (email, kind) rather than per IP because that's the axis
// an attacker can't trivially rotate: the victim's address is fixed.
import { and, eq, gte, sql } from 'drizzle-orm'
import { db } from '../db/client'
import { emailSendLog } from '../db/schema'

export type EmailKind = 'verification' | 'password_reset'

// Up to N sends per address within WINDOW_MS. Generous enough for
// legitimate users (forwarding, retries) but cheap to spam past.
export const MAX_SENDS_PER_WINDOW = 3
export const WINDOW_MS = 60 * 60 * 1000 // 1 hour

function normalize(email: string): string {
  return email.trim().toLowerCase()
}

// Returns true if we should proceed with the send. Records a row when we
// allow it so the next caller sees it in the window. Best-effort — any
// query error is logged and treated as "allow" so a transient DB blip
// doesn't lock users out of password reset.
export async function recordAndCheck(
  email: string,
  kind: EmailKind,
): Promise<boolean> {
  const e = normalize(email)
  if (!e) return false
  try {
    const since = new Date(Date.now() - WINDOW_MS)
    const rows = await db
      .select({ n: sql<number>`count(*)::int` })
      .from(emailSendLog)
      .where(
        and(
          eq(emailSendLog.email, e),
          eq(emailSendLog.kind, kind),
          gte(emailSendLog.sentAt, since),
        ),
      )
    const count = Number(rows[0]?.n ?? 0)
    if (count >= MAX_SENDS_PER_WINDOW) {
      console.warn(
        `[emailRateLimit] skipping ${kind} to ${e}: ${count} sends in window`,
      )
      return false
    }
    await db.insert(emailSendLog).values({ email: e, kind })
    return true
  } catch (err) {
    console.error('[emailRateLimit] query failed, allowing send:', err)
    return true
  }
}
