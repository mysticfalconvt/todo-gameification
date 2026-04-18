import { useState } from 'react'
import { createFileRoute, redirect, useNavigate } from '@tanstack/react-router'
import { Link } from '@tanstack/react-router'
import { signIn } from '../../lib/auth-client'
import { getCurrentSession } from '../../server/session'

export const Route = createFileRoute('/auth/login')({
  beforeLoad: async () => {
    const session = await getCurrentSession()
    if (session) throw redirect({ to: '/today' })
  },
  component: LoginPage,
})

function LoginPage() {
  const navigate = useNavigate()
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [submitting, setSubmitting] = useState(false)

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault()
    setError(null)
    setSubmitting(true)
    const { error: signInError } = await signIn.email({ email, password })
    setSubmitting(false)
    if (signInError) {
      setError(signInError.message ?? 'Sign in failed')
      return
    }
    navigate({ to: '/today' })
  }

  return (
    <main className="page-wrap px-4 py-12">
      <section className="island-shell mx-auto max-w-md rounded-2xl p-6 sm:p-8">
        <h1 className="display-title mb-6 text-3xl font-bold text-[var(--sea-ink)]">
          Log in
        </h1>
        <form onSubmit={onSubmit} className="space-y-4">
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
              autoComplete="current-password"
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
            {submitting ? 'Signing in…' : 'Sign in'}
          </button>
        </form>
        <p className="mt-6 text-sm text-[var(--sea-ink-soft)]">
          No account yet?{' '}
          <Link to="/auth/signup" className="font-semibold">
            Sign up
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
