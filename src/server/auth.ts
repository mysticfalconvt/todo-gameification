import { betterAuth } from 'better-auth'
import { drizzleAdapter } from 'better-auth/adapters/drizzle'
import { db } from './db/client'
import * as schema from './db/schema'
import { sendMail, isEmailConfigured } from './email'
import { generateUniqueHandleFromName } from './services/handles'
import { recordAndCheck } from './services/emailRateLimit'
import { bootstrapNewUser } from './services/onboarding'

// Constant-ish delay helper for the password-reset hook. Better Auth only
// invokes sendResetPassword when a user exists, so an unknown-email path
// returns instantly; padding the known-email path to a similar floor
// removes the timing side-channel that would otherwise let an attacker
// enumerate registered addresses.
function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms))
}

function appUrl(): string {
  return (process.env.BETTER_AUTH_URL ?? 'http://localhost:3000').replace(
    /\/$/,
    '',
  )
}

export const auth = betterAuth({
  database: drizzleAdapter(db, {
    provider: 'pg',
    schema: {
      user: schema.user,
      session: schema.session,
      account: schema.account,
      verification: schema.verification,
    },
  }),
  emailAndPassword: {
    enabled: true,
    // Only enforce verification if we actually have an SMTP transport wired;
    // otherwise users could sign up and be permanently locked out.
    requireEmailVerification: isEmailConfigured(),
    sendResetPassword: async ({ user, url }) => {
      // Pad the known-email path so it takes similar time to the
      // unknown-email path (which returns ~instantly without calling
      // this hook). 300–500ms of jitter is cheap and masks SMTP RTT
      // leakage without being user-visible.
      const pad = sleep(300 + Math.floor(Math.random() * 200))
      const ok = await recordAndCheck(user.email, 'password_reset')
      if (ok) {
        await sendMail({
          to: user.email,
          subject: 'Reset your Todo XP password',
          text: `Click the link to reset your password: ${url}`,
          html: resetPasswordHtml(url),
        })
      }
      await pad
    },
  },
  emailVerification: {
    sendOnSignUp: true,
    sendOnSignIn: true,
    autoSignInAfterVerification: true,
    sendVerificationEmail: async ({ user, url }) => {
      // Rate-limit to prevent a login-loop attacker from spamming an
      // unverified user's inbox via sendOnSignIn.
      const ok = await recordAndCheck(user.email, 'verification')
      if (!ok) return
      await sendMail({
        to: user.email,
        subject: 'Verify your Todo XP email',
        text: `Click the link to verify your email: ${url}`,
        html: verifyEmailHtml(url),
      })
    },
  },
  user: {
    additionalFields: {
      timezone: {
        type: 'string',
        required: false,
        defaultValue: 'UTC',
        input: true,
      },
      handle: {
        type: 'string',
        required: false,
        // Auto-generated on create via the databaseHooks.user.create hook.
        // Not user-input at signup; editable later in /settings.
        input: false,
      },
      profileVisibility: {
        type: 'string',
        required: false,
        defaultValue: 'friends',
        input: false,
      },
    },
  },
  databaseHooks: {
    user: {
      create: {
        before: async (data) => {
          const name =
            typeof (data as { name?: unknown }).name === 'string'
              ? (data as { name: string }).name
              : ''
          const handle = await generateUniqueHandleFromName(name)
          return { data: { ...data, handle } }
        },
        after: async (user) => {
          // Bootstrap categories, arcade tokens, and try-game onboarding
          // tasks. Don't fail signup if this stumbles — a user without
          // starter tasks is recoverable; a user without an account is
          // not.
          const id =
            typeof (user as { id?: unknown }).id === 'string'
              ? (user as { id: string }).id
              : null
          if (!id) return
          try {
            await bootstrapNewUser(id)
          } catch (err) {
            console.error('[auth] bootstrapNewUser failed', err)
          }
        },
      },
    },
  },
  session: {
    expiresIn: 60 * 60 * 24 * 30,
  },
  // Defense-in-depth: explicitly allowlist origins that may hold a
  // session cookie. Better Auth defaults to just baseURL, but pinning
  // this makes the trust boundary explicit if more origins ever get
  // added later. Localhost stays usable in dev because BETTER_AUTH_URL
  // is http://localhost:3000 there.
  trustedOrigins: [process.env.BETTER_AUTH_URL].filter(
    (v): v is string => Boolean(v),
  ),
  advanced: {
    defaultCookieAttributes: {
      sameSite: 'lax',
      httpOnly: true,
      // Secure only in prod; allowing insecure cookies in dev lets the
      // local http://localhost flow keep working.
      secure: process.env.NODE_ENV === 'production',
    },
  },
  secret: process.env.BETTER_AUTH_SECRET,
  baseURL: process.env.BETTER_AUTH_URL,
})

export type Session = typeof auth.$Infer.Session

function verifyEmailHtml(url: string): string {
  const base = appUrl()
  return `<!doctype html><html><body style="font-family:system-ui,sans-serif;max-width:480px;margin:2em auto;padding:1em">
    <h2 style="color:#173a40">Verify your email</h2>
    <p>Click the button below to confirm your email address on Todo XP.</p>
    <p><a href="${url}" style="display:inline-block;padding:12px 24px;background:#1f6e75;color:white;border-radius:999px;text-decoration:none">Verify email</a></p>
    <p style="color:#888;font-size:12px">If that doesn't work, paste this URL into your browser: <br><code>${url}</code></p>
    <p style="color:#888;font-size:12px">— Todo XP · ${base}</p>
  </body></html>`
}

function resetPasswordHtml(url: string): string {
  const base = appUrl()
  return `<!doctype html><html><body style="font-family:system-ui,sans-serif;max-width:480px;margin:2em auto;padding:1em">
    <h2 style="color:#173a40">Reset your password</h2>
    <p>Someone (hopefully you) asked to reset the password on this account. Click the button to set a new one.</p>
    <p><a href="${url}" style="display:inline-block;padding:12px 24px;background:#1f6e75;color:white;border-radius:999px;text-decoration:none">Reset password</a></p>
    <p style="color:#888;font-size:12px">Ignore this email if you didn't request it. The link expires after a short time.</p>
    <p style="color:#888;font-size:12px">If the button doesn't work: <br><code>${url}</code></p>
    <p style="color:#888;font-size:12px">— Todo XP · ${base}</p>
  </body></html>`
}
