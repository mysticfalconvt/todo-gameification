import { useState } from 'react'
import { Link, createFileRoute, useNavigate, useSearch } from '@tanstack/react-router'
import { authClient } from '../../lib/auth-client'

interface ResetSearch {
  token?: string
  error?: string
}

export const Route = createFileRoute('/auth/reset-password')({
  component: ResetPasswordPage,
  validateSearch: (s: Record<string, unknown>): ResetSearch => ({
    token: typeof s.token === 'string' ? s.token : undefined,
    error: typeof s.error === 'string' ? s.error : undefined,
  }),
})

function ResetPasswordPage() {
  const navigate = useNavigate()
  const { token, error: urlError } = useSearch({
    from: '/auth/reset-password',
  })
  const [password, setPassword] = useState('')
  const [confirm, setConfirm] = useState('')
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState<string | null>(
    urlError ? `Invalid or expired link (${urlError}).` : null,
  )

  if (!token && !urlError) {
    return (
      <main className="page-wrap px-4 py-12">
        <section className="island-shell mx-auto max-w-md rounded-2xl p-6 sm:p-8">
          <h1 className="display-title mb-2 text-3xl font-bold text-[var(--sea-ink)]">
            Invalid link
          </h1>
          <p className="mb-4 text-sm text-[var(--sea-ink-soft)]">
            This reset link is missing its token.{' '}
            <Link to="/auth/forgot-password" className="font-semibold">
              Request a new one
            </Link>
            .
          </p>
        </section>
      </main>
    )
  }

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault()
    setError(null)
    if (password.length < 8) {
      setError('Password must be at least 8 characters.')
      return
    }
    if (password !== confirm) {
      setError("Passwords don't match.")
      return
    }
    if (!token) {
      setError('Missing token.')
      return
    }
    setSubmitting(true)
    const { error: err } = await authClient.resetPassword({
      newPassword: password,
      token,
    })
    setSubmitting(false)
    if (err) {
      setError(err.message ?? 'Could not reset password')
      return
    }
    navigate({ to: '/auth/login' })
  }

  return (
    <main className="page-wrap px-4 py-12">
      <section className="island-shell mx-auto max-w-md rounded-2xl p-6 sm:p-8">
        <h1 className="display-title mb-6 text-3xl font-bold text-[var(--sea-ink)]">
          Set a new password
        </h1>
        <form onSubmit={onSubmit} className="space-y-4">
          <label className="block">
            <span className="mb-1 block text-xs font-semibold uppercase tracking-wide text-[var(--kicker)]">
              New password
            </span>
            <input
              type="password"
              required
              autoComplete="new-password"
              minLength={8}
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              className="field-input"
            />
          </label>
          <label className="block">
            <span className="mb-1 block text-xs font-semibold uppercase tracking-wide text-[var(--kicker)]">
              Confirm
            </span>
            <input
              type="password"
              required
              autoComplete="new-password"
              minLength={8}
              value={confirm}
              onChange={(e) => setConfirm(e.target.value)}
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
            {submitting ? 'Saving…' : 'Set new password'}
          </button>
        </form>
      </section>
    </main>
  )
}
