import { useState } from 'react'
import { createFileRoute, redirect } from '@tanstack/react-router'
import { Link } from '@tanstack/react-router'
import { signUp } from '../../lib/auth-client'
import { getCurrentSession } from '../../server/session'

export const Route = createFileRoute('/auth/signup')({
  beforeLoad: async () => {
    const session = await getCurrentSession()
    if (session) throw redirect({ to: '/today' })
  },
  component: SignupPage,
})

function SignupPage() {
  const [name, setName] = useState('')
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [submitting, setSubmitting] = useState(false)
  const [sent, setSent] = useState(false)

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault()
    setError(null)
    setSubmitting(true)
    const timezone = Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC'
    const { error: signUpError } = await signUp.email({
      email,
      password,
      name,
      timezone,
    } as never)
    setSubmitting(false)
    if (signUpError) {
      setError(signUpError.message ?? 'Sign up failed')
      return
    }
    setSent(true)
  }

  if (sent) {
    return (
      <main className="page-wrap px-4 py-12">
        <section className="island-shell mx-auto max-w-md rounded-2xl p-6 sm:p-8">
          <h1 className="display-title mb-4 text-3xl font-bold text-[var(--sea-ink)]">
            Check your email
          </h1>
          <p className="mb-4 text-sm text-[var(--sea-ink-soft)]">
            We sent a verification link to <strong>{email}</strong>. Click
            it, and you'll be signed in automatically.
          </p>
          <p className="text-sm text-[var(--sea-ink-soft)]">
            Didn't get it? Check your spam folder, or{' '}
            <Link to="/auth/login" className="font-semibold">
              try signing in
            </Link>{' '}
            — you can resend from there.
          </p>
        </section>
      </main>
    )
  }

  return (
    <main className="page-wrap px-4 py-12">
      <section className="island-shell mx-auto max-w-md rounded-2xl p-6 sm:p-8">
        <h1 className="display-title mb-6 text-3xl font-bold text-[var(--sea-ink)]">
          Sign up
        </h1>
        <form onSubmit={onSubmit} className="space-y-4">
          <Field label="Name">
            <input
              type="text"
              required
              autoComplete="name"
              value={name}
              onChange={(e) => setName(e.target.value)}
              className="field-input"
            />
          </Field>
          <Field label="Email">
            <input
              type="email"
              required
              autoComplete="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              className="field-input"
            />
          </Field>
          <Field label="Password">
            <input
              type="password"
              required
              autoComplete="new-password"
              minLength={8}
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              className="field-input"
            />
          </Field>
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
            {submitting ? 'Creating account…' : 'Create account'}
          </button>
        </form>
        <p className="mt-6 text-sm text-[var(--sea-ink-soft)]">
          Already have an account?{' '}
          <Link to="/auth/login" className="font-semibold">
            Log in
          </Link>
        </p>
      </section>
    </main>
  )
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="block">
      <span className="mb-1 block text-xs font-semibold uppercase tracking-wide text-[var(--kicker)]">
        {label}
      </span>
      {children}
    </label>
  )
}
