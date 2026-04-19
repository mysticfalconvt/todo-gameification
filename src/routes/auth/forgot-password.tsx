import { useState } from 'react'
import { Link, createFileRoute } from '@tanstack/react-router'
import { authClient } from '../../lib/auth-client'

export const Route = createFileRoute('/auth/forgot-password')({
  component: ForgotPasswordPage,
})

function ForgotPasswordPage() {
  const [email, setEmail] = useState('')
  const [submitting, setSubmitting] = useState(false)
  const [sent, setSent] = useState(false)
  const [error, setError] = useState<string | null>(null)

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault()
    setError(null)
    setSubmitting(true)
    const { error: err } = await authClient.requestPasswordReset({
      email,
      redirectTo: '/auth/reset-password',
    })
    setSubmitting(false)
    if (err) {
      setError(err.message ?? 'Could not send reset email')
      return
    }
    setSent(true)
  }

  return (
    <main className="page-wrap px-4 py-12">
      <section className="island-shell mx-auto max-w-md rounded-2xl p-6 sm:p-8">
        <h1 className="display-title mb-6 text-3xl font-bold text-[var(--sea-ink)]">
          Forgot password
        </h1>
        {sent ? (
          <>
            <p className="mb-4 text-sm text-[var(--sea-ink)]">
              If there's an account for <strong>{email}</strong>, a password
              reset link is on its way. The link expires in a short while.
            </p>
            <Link
              to="/auth/login"
              className="font-semibold text-[var(--lagoon-deep)]"
            >
              Back to sign in
            </Link>
          </>
        ) : (
          <>
            <p className="mb-4 text-sm text-[var(--sea-ink-soft)]">
              Enter the email you signed up with and we'll send you a reset
              link.
            </p>
            <form onSubmit={onSubmit} className="space-y-4">
              <label className="block">
                <span className="mb-1 block text-xs font-semibold uppercase tracking-wide text-[var(--kicker)]">
                  Email
                </span>
                <input
                  type="email"
                  required
                  autoComplete="email"
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  className="field-input"
                />
              </label>
              {error ? (
                <p className="text-sm text-red-600" role="alert">
                  {error}
                </p>
              ) : null}
              <button
                type="submit"
                disabled={submitting}
                className="w-full rounded-full border border-[rgba(50,143,151,0.3)] bg-[rgba(79,184,178,0.14)] px-5 py-2.5 text-sm font-semibold text-[var(--lagoon-deep)] disabled:opacity-60"
              >
                {submitting ? 'Sending…' : 'Send reset link'}
              </button>
            </form>
            <p className="mt-6 text-sm text-[var(--sea-ink-soft)]">
              Remembered it?{' '}
              <Link to="/auth/login" className="font-semibold">
                Sign in
              </Link>
            </p>
          </>
        )}
      </section>
    </main>
  )
}
