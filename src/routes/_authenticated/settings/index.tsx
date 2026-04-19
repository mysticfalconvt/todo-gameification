import { useEffect, useState } from 'react'
import { createFileRoute } from '@tanstack/react-router'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Link } from '@tanstack/react-router'
import { authClient, useSession } from '../../../lib/auth-client'
import {
  createApiToken,
  listApiTokens,
  revokeApiToken,
} from '../../../server/functions/api-tokens'

export const Route = createFileRoute('/_authenticated/settings/')({
  component: SettingsPage,
})

function SettingsPage() {
  const { data: session } = useSession()

  return (
    <main className="page-wrap space-y-8 px-4 py-8">
      <h1 className="display-title text-4xl font-bold text-[var(--sea-ink)]">
        Profile & settings
      </h1>
      <ProfileSection user={session?.user} />
      <PasswordSection />
      <TokensSection />
    </main>
  )
}

// ---------------------------------------------------------------------------
// Profile
// ---------------------------------------------------------------------------

function ProfileSection({
  user,
}: {
  user:
    | { id: string; name: string; email: string; [k: string]: unknown }
    | undefined
}) {
  const [name, setName] = useState('')
  const [saved, setSaved] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [pending, setPending] = useState(false)

  useEffect(() => {
    if (user?.name) setName(user.name)
  }, [user?.id, user?.name])

  async function onSave(e: React.FormEvent) {
    e.preventDefault()
    if (!user) return
    setError(null)
    setSaved(false)
    setPending(true)
    try {
      const { error: err } = await authClient.updateUser({ name })
      if (err) throw new Error(err.message ?? 'Failed to update name')
      setSaved(true)
      setTimeout(() => setSaved(false), 2000)
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to update name')
    } finally {
      setPending(false)
    }
  }

  const tz =
    (user && (user as { timezone?: string }).timezone) ||
    Intl.DateTimeFormat().resolvedOptions().timeZone

  return (
    <section className="island-shell max-w-xl rounded-2xl p-6">
      <h2 className="mb-1 text-lg font-bold text-[var(--sea-ink)]">Profile</h2>
      <dl className="mb-4 grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 text-sm text-[var(--sea-ink-soft)]">
        <dt className="font-semibold">Email</dt>
        <dd className="truncate text-[var(--sea-ink)]">{user?.email ?? '—'}</dd>
        <dt className="font-semibold">Timezone</dt>
        <dd className="text-[var(--sea-ink)]">{tz}</dd>
      </dl>
      <form onSubmit={onSave} className="space-y-3">
        <label className="block">
          <span className="mb-1 block text-xs font-semibold uppercase tracking-wide text-[var(--kicker)]">
            Display name
          </span>
          <input
            type="text"
            value={name}
            onChange={(e) => setName(e.target.value)}
            className="field-input"
          />
        </label>
        {error ? (
          <p className="text-sm text-red-600" role="alert">
            {error}
          </p>
        ) : null}
        {saved ? (
          <p className="text-sm text-[var(--palm)]">Saved.</p>
        ) : null}
        <button
          type="submit"
          disabled={pending || !user || name === user?.name}
          className="rounded-full border border-[rgba(50,143,151,0.3)] bg-[rgba(79,184,178,0.14)] px-4 py-2 text-sm font-semibold text-[var(--lagoon-deep)] disabled:opacity-60"
        >
          {pending ? 'Saving…' : 'Save'}
        </button>
      </form>
    </section>
  )
}

// ---------------------------------------------------------------------------
// Password
// ---------------------------------------------------------------------------

function PasswordSection() {
  const [current, setCurrent] = useState('')
  const [next, setNext] = useState('')
  const [confirm, setConfirm] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [saved, setSaved] = useState(false)
  const [pending, setPending] = useState(false)

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault()
    setError(null)
    setSaved(false)
    if (next.length < 8) {
      setError('New password must be at least 8 characters.')
      return
    }
    if (next !== confirm) {
      setError("New passwords don't match.")
      return
    }
    setPending(true)
    try {
      const { error: err } = await authClient.changePassword({
        currentPassword: current,
        newPassword: next,
        revokeOtherSessions: false,
      })
      if (err) throw new Error(err.message ?? 'Failed to change password')
      setCurrent('')
      setNext('')
      setConfirm('')
      setSaved(true)
      setTimeout(() => setSaved(false), 2500)
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to change password')
    } finally {
      setPending(false)
    }
  }

  return (
    <section className="island-shell max-w-xl rounded-2xl p-6">
      <h2 className="mb-3 text-lg font-bold text-[var(--sea-ink)]">
        Change password
      </h2>
      <form onSubmit={onSubmit} className="space-y-3">
        <label className="block">
          <span className="mb-1 block text-xs font-semibold uppercase tracking-wide text-[var(--kicker)]">
            Current password
          </span>
          <input
            type="password"
            required
            autoComplete="current-password"
            value={current}
            onChange={(e) => setCurrent(e.target.value)}
            className="field-input"
          />
        </label>
        <label className="block">
          <span className="mb-1 block text-xs font-semibold uppercase tracking-wide text-[var(--kicker)]">
            New password
          </span>
          <input
            type="password"
            required
            autoComplete="new-password"
            minLength={8}
            value={next}
            onChange={(e) => setNext(e.target.value)}
            className="field-input"
          />
        </label>
        <label className="block">
          <span className="mb-1 block text-xs font-semibold uppercase tracking-wide text-[var(--kicker)]">
            Confirm new password
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
        {saved ? (
          <p className="text-sm text-[var(--palm)]">Password updated.</p>
        ) : null}
        <button
          type="submit"
          disabled={pending}
          className="rounded-full border border-[rgba(50,143,151,0.3)] bg-[rgba(79,184,178,0.14)] px-4 py-2 text-sm font-semibold text-[var(--lagoon-deep)] disabled:opacity-60"
        >
          {pending ? 'Updating…' : 'Change password'}
        </button>
      </form>
    </section>
  )
}

// ---------------------------------------------------------------------------
// API tokens
// ---------------------------------------------------------------------------

type TokenRow = Awaited<ReturnType<typeof listApiTokens>>[number]
type CreatedToken = Awaited<ReturnType<typeof createApiToken>>

function TokensSection() {
  const qc = useQueryClient()
  const [name, setName] = useState('')
  const [created, setCreated] = useState<CreatedToken | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [copied, setCopied] = useState(false)

  const tokensQuery = useQuery({
    queryKey: ['api-tokens'],
    queryFn: () => listApiTokens(),
  })

  const create = useMutation({
    mutationFn: (n: string) => createApiToken({ data: { name: n } }),
    onSuccess: (token) => {
      setCreated(token)
      setName('')
      qc.invalidateQueries({ queryKey: ['api-tokens'] })
    },
    onError: (err) => {
      setError(err instanceof Error ? err.message : 'Failed to create token')
    },
  })

  const revoke = useMutation({
    mutationFn: (tokenId: string) =>
      revokeApiToken({ data: { tokenId } }),
    onMutate: async (tokenId) => {
      await qc.cancelQueries({ queryKey: ['api-tokens'] })
      const prev = qc.getQueryData<TokenRow[]>(['api-tokens'])
      qc.setQueryData<TokenRow[]>(['api-tokens'], (old) =>
        old?.filter((t) => t.id !== tokenId),
      )
      return { prev }
    },
    onError: (_err, _id, ctx) => {
      if (ctx?.prev) qc.setQueryData(['api-tokens'], ctx.prev)
    },
    onSettled: () => qc.invalidateQueries({ queryKey: ['api-tokens'] }),
  })

  function onSubmit(e: React.FormEvent) {
    e.preventDefault()
    setError(null)
    if (!name.trim()) {
      setError('Name is required')
      return
    }
    create.mutate(name.trim())
  }

  async function onCopy() {
    if (!created?.plaintext) return
    try {
      await navigator.clipboard.writeText(created.plaintext)
      setCopied(true)
      setTimeout(() => setCopied(false), 1500)
    } catch {
      // ignore
    }
  }

  const tokens = tokensQuery.data ?? []

  return (
    <details className="island-shell max-w-2xl rounded-2xl [&[open]>summary_[data-chevron]]:rotate-90">
      <summary className="flex cursor-pointer list-none items-center justify-between gap-3 p-5">
        <div className="min-w-0">
          <h2 className="text-lg font-bold text-[var(--sea-ink)]">API access</h2>
          <p className="text-sm text-[var(--sea-ink-soft)]">
            {tokens.length === 0
              ? 'No tokens yet.'
              : `${tokens.length} active token${tokens.length === 1 ? '' : 's'}.`}{' '}
            Tokens work for REST, MCP, and Home Assistant.
          </p>
        </div>
        <span
          data-chevron
          aria-hidden
          className="flex-shrink-0 text-[var(--sea-ink-soft)] transition-transform"
        >
          ▸
        </span>
      </summary>

      <div className="space-y-4 border-t border-[var(--line)] p-5">
        <nav className="grid gap-2 sm:grid-cols-3">
          <DocLink
            to="/settings/api-docs"
            label="REST API"
            detail="Endpoints, request & response shapes."
          />
          <DocLink
            to="/settings/mcp"
            label="MCP (for LLMs)"
            detail="Claude Desktop config + tool inventory."
          />
          <DocLink
            to="/settings/home-assistant"
            label="Home Assistant"
            detail="Copy-paste sensor & command YAML."
          />
        </nav>

      <div className="island-shell rounded-2xl p-5">
        <h3 className="mb-3 text-sm font-semibold text-[var(--sea-ink)]">
          Create token
        </h3>
        <form onSubmit={onSubmit} className="space-y-3">
          <label className="block">
            <span className="mb-1 block text-xs font-semibold uppercase tracking-wide text-[var(--kicker)]">
              Name
            </span>
            <input
              type="text"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="e.g. Home Assistant"
              maxLength={80}
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
            disabled={create.isPending}
            className="rounded-full border border-[rgba(50,143,151,0.3)] bg-[rgba(79,184,178,0.14)] px-4 py-2 text-sm font-semibold text-[var(--lagoon-deep)] disabled:opacity-60"
          >
            {create.isPending ? 'Creating…' : 'Create token'}
          </button>
        </form>

        {created ? (
          <div className="mt-4 rounded-xl border border-[var(--lagoon-deep)] bg-[rgba(79,184,178,0.1)] p-4 text-sm">
            <p className="mb-2 font-semibold text-[var(--sea-ink)]">
              Copy this token now. You won't see it again.
            </p>
            <div className="mb-3 flex items-center gap-2">
              <code className="flex-1 break-all rounded-md border border-[var(--line)] bg-[var(--surface-strong)] p-2 font-mono text-xs text-[var(--sea-ink)]">
                {created.plaintext}
              </code>
              <button
                type="button"
                onClick={onCopy}
                className="rounded-full border border-[var(--line)] bg-[var(--option-bg)] px-3 py-1 text-xs font-semibold text-[var(--sea-ink)]"
              >
                {copied ? 'Copied!' : 'Copy'}
              </button>
            </div>
            <button
              type="button"
              onClick={() => setCreated(null)}
              className="rounded-full border border-[var(--line)] bg-[var(--option-bg)] px-3 py-1 text-xs font-semibold text-[var(--sea-ink-soft)]"
            >
              I've saved it
            </button>
          </div>
        ) : null}
      </div>

      <div>
        <h3 className="mb-2 text-sm font-semibold text-[var(--sea-ink)]">
          Your tokens
        </h3>
        {tokensQuery.isLoading ? (
          <p className="text-sm text-[var(--sea-ink-soft)]">Loading…</p>
        ) : tokens.length === 0 ? (
          <p className="text-sm text-[var(--sea-ink-soft)]">
            No tokens yet.
          </p>
        ) : (
          <ul className="space-y-2">
            {tokens.map((t) => (
              <li
                key={t.id}
                className="island-shell flex items-center gap-3 rounded-xl p-3"
              >
                <div className="min-w-0 flex-1">
                  <p className="truncate font-semibold text-[var(--sea-ink)]">
                    {t.name}
                  </p>
                  <p className="text-xs text-[var(--sea-ink-soft)]">
                    <code className="font-mono">{t.tokenPrefix}…</code>
                    {' • created '}
                    {new Date(t.createdAt).toLocaleDateString()}
                    {' • '}
                    {t.lastUsedAt
                      ? `last used ${timeAgo(t.lastUsedAt)}`
                      : 'never used'}
                  </p>
                </div>
                <button
                  type="button"
                  onClick={() => {
                    if (
                      confirm(
                        `Revoke "${t.name}"? This can't be undone.`,
                      )
                    ) {
                      revoke.mutate(t.id)
                    }
                  }}
                  className="rounded-full border border-[var(--line)] bg-[var(--option-bg)] px-3 py-1 text-xs font-semibold text-[var(--sea-ink-soft)] transition hover:text-red-600"
                >
                  Revoke
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>

      </div>
    </details>
  )
}

function DocLink({
  to,
  label,
  detail,
}: {
  to: '/settings/api-docs' | '/settings/mcp' | '/settings/home-assistant'
  label: string
  detail: string
}) {
  return (
    <Link
      to={to}
      onClick={(e) => e.stopPropagation()}
      className="block rounded-xl border border-[var(--line)] bg-[var(--option-bg)] p-3 no-underline transition hover:bg-[var(--option-bg-hover)]"
    >
      <p className="text-sm font-semibold text-[var(--sea-ink)]">{label}</p>
      <p className="mt-0.5 text-xs text-[var(--sea-ink-soft)]">{detail}</p>
    </Link>
  )
}

function timeAgo(iso: string): string {
  const ms = Date.now() - new Date(iso).getTime()
  const mins = Math.floor(ms / 60_000)
  if (mins < 1) return 'just now'
  if (mins < 60) return `${mins}m ago`
  const hrs = Math.floor(mins / 60)
  if (hrs < 24) return `${hrs}h ago`
  const days = Math.floor(hrs / 24)
  return `${days}d ago`
}
