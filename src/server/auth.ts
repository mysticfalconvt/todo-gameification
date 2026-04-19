import { betterAuth } from 'better-auth'
import { drizzleAdapter } from 'better-auth/adapters/drizzle'
import { db } from './db/client'
import * as schema from './db/schema'
import { sendMail, isEmailConfigured } from './email'

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
      await sendMail({
        to: user.email,
        subject: 'Reset your Todo XP password',
        text: `Click the link to reset your password: ${url}`,
        html: resetPasswordHtml(url),
      })
    },
  },
  emailVerification: {
    sendOnSignUp: true,
    sendOnSignIn: true,
    autoSignInAfterVerification: true,
    sendVerificationEmail: async ({ user, url }) => {
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
    },
  },
  session: {
    expiresIn: 60 * 60 * 24 * 30,
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
